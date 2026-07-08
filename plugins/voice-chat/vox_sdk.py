"""vox-SDK (Python) — bootstrap standalone do motor de voz ``vox-engine``.

Um cliente novo integra com UMA chamada::

    from vox_sdk import ensure_vox
    client = ensure_vox()          # instala/atualiza/usa; devolve o cliente ou None
    if client:
        print(client.info())

Este módulo é **drop-in** e **stdlib-puro** (mais o verificador Ed25519 vendorizado
``_ed25519_ref.py``, que deve ficar ao lado deste arquivo). Ele **NÃO importa**
``vox_engine``, **não** exige ``pywin32`` nem ``cryptography`` e fala com o daemon
pelo named pipe usando ``open(pipe, "r+b", buffering=0)`` puro. ``truststore`` e
``numpy`` são opcionais (carregados sob ``try/except``).

Postura de segurança — **fail-closed**: o instalador da release só roda depois de
uma verificação Ed25519 (hash-then-sign sobre o SHA-256 do zip) bem-sucedida contra
o KEYRING embutido. Chave malformada/ausente, ``.sig`` ausente, erro de rede, ou
verificador indisponível ⇒ verificação falsa ⇒ o ``install.ps1`` NUNCA é executado.

O ``VoxClient`` aqui é **síncrono e serializado** (1 request em voo por vez): ele
espelha a ``_VoxBridge`` do voice-chat (uma request → uma resposta, protegida por um
lock, com thread leitora + timeout). NÃO é o :class:`vox_engine.client.pipe_client.VoxClient`
concorrente (multi-req roteado por ``req_id``). Para um único consumidor sequencial
(ditado, TTS on-demand) isto é suficiente e mais simples.

Fonte canônica: ``vox-engine/sdk/python/vox_sdk.py``. Clientes VENDORIZAM uma cópia
byte-idêntica (a mesma convenção de lock/config vale para o SDK Node irmão).
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import zipfile
import shutil
import urllib.request

# ---------------------------------------------------------------------------
# CONFIG canônica — fonte única (os MESMOS valores no SDK Node irmão).
# ---------------------------------------------------------------------------
SDK_VERSION = "1.0.0"

RELEASES_API = ("https://api.github.com/repos/AllanSantos-DV/"
                "copilot-marketplace/releases")
TAG_PREFIX = "vox-engine-v"
INSTALLER_ASSET = "vox-engine-installer.zip"
SIG_ASSET = INSTALLER_ASSET + ".sig"

# KEYRING Ed25519 (hex, 64 chars cada) — rotação = [atual, próxima]. A verificação
# passa se QUALQUER chave validar. Vazio/algum item inválido (≠ 64 hex) ⇒ FATAL.
PUBKEYS = ["293263e73c4ba424a9ef3432d1ce55740fc0a68478f20235ca109c074ec83f52"]

DEFAULT_PIPE = r"\\.\pipe\vox"


def _install_root() -> str:
    """``%LOCALAPPDATA%\\vox-engine`` (fallback ``%USERPROFILE%``)."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "vox-engine")


INSTALL_ROOT = _install_root()
INSTALLED_PYTHON = os.path.join(INSTALL_ROOT, "venv", "Scripts", "python.exe")
INSTALLED_PYTHONW = os.path.join(INSTALL_ROOT, "venv", "Scripts", "pythonw.exe")
DAEMON_LOG = os.path.join(INSTALL_ROOT, "logs", "daemon.log")
DAEMON_BOOT_LOG = os.path.join(INSTALL_ROOT, "logs", "daemon-boot.log")

# LOCK cross-process (IDÊNTICO ao Node — os dois coordenam entre si).
LOCK_DIR = os.path.join(INSTALL_ROOT, ".install.lock")
STALE_MS = 40 * 60 * 1000          # 40 min: > INSTALL_TIMEOUT_MS (30 min), senão
                                   # uma install legítima teria o lock roubado
ACQUIRE_TIMEOUT_MS = 180000        # 3 min esperando outro instalador
POLL_MS = 500                      # intervalo de poll da aquisição

# Timeouts da máquina de estados / instalação.
CONNECT_TIMEOUT_MS = 2000          # sonda de "pipe no ar?"
BOOT_TIMEOUT_MS = 150000           # 1ª carga GPU compila kernels (~1 min)
INSTALL_TIMEOUT_MS = 1800000       # 30 min: 1ª install baixa deps (wheels CUDA)

# Tetos de sanidade do framing (espelham daemon/protocol.py).
MAX_JSON = 4 * 1024 * 1024
MAX_AUDIO = 512 * 1024 * 1024

__all__ = [
    "SDK_VERSION", "DEFAULT_PIPE", "PUBKEYS", "RELEASES_API", "TAG_PREFIX",
    "INSTALLER_ASSET", "SIG_ASSET",
    "VoxClient", "VoxEngineError", "ProtocolError",
    "verify_installer", "encode_message", "read_message", "make_recv_exact",
    "parse_version", "is_newer", "latest_release", "installed_version",
    "download_and_run_installer", "check_and_update",
    "start_installed_daemon", "ensure_vox", "ensure_vox_detailed",
]


# ---------------------------------------------------------------------------
# Verificador Ed25519 — REUSO do módulo já provado (`_ed25519_ref.verify`).
# NÃO reescrevemos crypto: carregamos a impl vendorizada (RFC 8032 Ap. A).
# ---------------------------------------------------------------------------
def _load_ed25519_verify():
    """Carrega ``_ed25519_ref.verify`` de forma robusta (drop-in): import direto,
    import relativo, ou carga por caminho ao lado deste arquivo. Se nada funcionar,
    devolve ``None`` (fail-closed no chamador)."""
    try:
        from _ed25519_ref import verify as _v  # type: ignore
        return _v
    except Exception:  # noqa: BLE001
        pass
    try:
        from ._ed25519_ref import verify as _v  # type: ignore
        return _v
    except Exception:  # noqa: BLE001
        pass
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "_ed25519_ref.py")
        spec = importlib.util.spec_from_file_location("_vox_ed25519_ref", path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.verify
    except Exception:  # noqa: BLE001
        return None


_ed_verify = _load_ed25519_verify()


def verify_installer(blob: bytes, signature: bytes) -> bool:
    """Verifica a assinatura Ed25519 do instalador contra o KEYRING (``PUBKEYS``).

    Mensagem assinada = ``sha256(blob)`` (hash-then-sign, igual ao tools/sign_release.py).
    Para CADA chave do keyring chama ``_ed25519_ref.verify(pubkey, digest, sig)`` e
    devolve ``True`` se QUALQUER uma validar.

    **Fail-closed** (nunca levanta): devolve ``False`` se o keyring está vazio, se
    QUALQUER chave é malformada (≠ 64 hex / ≠ 32 bytes), se ``.sig`` está ausente ou
    não tem 64 bytes, se o verificador não pôde ser carregado, ou em qualquer erro.
    """
    try:
        keys = list(PUBKEYS)  # lê o global em tempo de chamada (rotação/testes)
    except Exception:  # noqa: BLE001
        return False
    if not keys:
        return False  # keyring vazio ⇒ FATAL
    raw_keys = []
    for k in keys:
        if not isinstance(k, str):
            return False
        ks = k.strip()
        if len(ks) != 64:
            return False  # chave malformada ⇒ FATAL (não instala)
        try:
            rk = bytes.fromhex(ks)
        except ValueError:
            return False
        if len(rk) != 32:
            return False
        raw_keys.append(rk)
    if _ed_verify is None:
        return False  # verificador indisponível ⇒ fail-closed
    if signature is None or not isinstance(signature, (bytes, bytearray)):
        return False  # .sig ausente ⇒ recusa
    sig = bytes(signature)
    if len(sig) != 64:
        return False
    if not isinstance(blob, (bytes, bytearray)):
        return False
    try:
        digest = hashlib.sha256(bytes(blob)).digest()
    except Exception:  # noqa: BLE001
        return False
    for rk in raw_keys:
        try:
            if _ed_verify(rk, digest, sig):
                return True
        except Exception:  # noqa: BLE001
            return False  # verificador levantou ⇒ fail-closed
    return False


# ---------------------------------------------------------------------------
# Framing binário [u32 json_len][u32 audio_len][json][audio] — PARIDADE byte a
# byte com daemon/protocol.py (copiado, NÃO importado de vox_engine).
# ---------------------------------------------------------------------------
_HDR = struct.Struct(">II")


class ProtocolError(Exception):
    """Frame malformado ou fora dos limites de sanidade."""


def encode_message(header: dict, audio: bytes = b"") -> bytes:
    """Serializa um frame completo (idêntico a protocol.encode_message)."""
    jb = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(jb) > MAX_JSON:
        raise ProtocolError(f"json muito grande: {len(jb)} > {MAX_JSON}")
    if len(audio) > MAX_AUDIO:
        raise ProtocolError(f"audio muito grande: {len(audio)} > {MAX_AUDIO}")
    return _HDR.pack(len(jb), len(audio)) + jb + audio


def read_message(recv_exact) -> "tuple[dict, bytes]":
    """Lê um frame via ``recv_exact(n)``. Devolve ``(header, audio)``.

    Levanta :class:`ProtocolError` em frame malformado e :class:`EOFError` se o
    stream fechar no início do frame. Espelho de protocol.read_message.
    """
    head = recv_exact(_HDR.size)
    if not head:
        raise EOFError("stream fechado")
    if len(head) != _HDR.size:
        raise ProtocolError("cabeçalho incompleto")
    json_len, audio_len = _HDR.unpack(head)
    if json_len > MAX_JSON or json_len == 0:
        raise ProtocolError(f"json_len inválido: {json_len}")
    if audio_len > MAX_AUDIO:
        raise ProtocolError(f"audio_len inválido: {audio_len}")
    jb = recv_exact(json_len)
    if len(jb) != json_len:
        raise ProtocolError("json truncado")
    audio = recv_exact(audio_len) if audio_len else b""
    if len(audio) != audio_len:
        raise ProtocolError("audio truncado")
    try:
        header = json.loads(jb.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ProtocolError(f"json inválido: {e}") from e
    if not isinstance(header, dict):
        raise ProtocolError("header não é objeto")
    return header, audio


def make_recv_exact(recv):
    """Adapta um ``recv(n)`` parcial num ``recv_exact(n)`` acumulador."""
    def recv_exact(n: int) -> bytes:
        if n == 0:
            return b""
        chunks = []
        got = 0
        while got < n:
            b = recv(n - got)
            if not b:
                return b"".join(chunks)
            chunks.append(b)
            got += len(b)
        return b"".join(chunks)
    return recv_exact


# numpy é OPCIONAL no consumidor (ex.: Python 3.14 sem wheels).
try:  # pragma: no cover - depende do ambiente
    import numpy as _np
except Exception:  # noqa: BLE001
    _np = None


def _to_pcm_bytes(audio) -> bytes:
    """Converte ``audio`` para PCM float32 little-endian.

    Aceita ``bytes``/``bytearray`` (repassa), ``numpy.ndarray`` (se numpy houver)
    ou qualquer iterável de floats (fallback stdlib via ``array``)."""
    if isinstance(audio, (bytes, bytearray)):
        return bytes(audio)
    if _np is not None:
        try:
            return _np.ascontiguousarray(audio, dtype="<f4").tobytes()
        except Exception:  # noqa: BLE001
            pass
    import array
    a = array.array("f", (float(x) for x in audio))
    if sys.byteorder != "little":
        a.byteswap()
    return a.tobytes()


# ---------------------------------------------------------------------------
# VoxClient SÍNCRONO (1 request em voo). Espelha _VoxBridge do voice-chat.
# ---------------------------------------------------------------------------
class VoxEngineError(RuntimeError):
    """Motor de voz indisponível ou falha de framing (erro ALTO, sem mudo)."""


class VoxClient:
    """Cliente **síncrono e serializado** do daemon ``vox-engine`` via named pipe.

    Abre o pipe como arquivo (``open(pipe, "r+b", buffering=0)`` — sem ``pywin32``),
    fala o framing ``struct.pack(">II", json_len, audio_len) + json + audio`` e
    serializa **1 request/resposta por vez** com um lock; a resposta é lida numa
    thread com timeout (um daemon travado no meio do frame vira erro, não congela).

    Diferença importante: este cliente **NÃO** é o
    :class:`vox_engine.client.pipe_client.VoxClient` concorrente (que roteia
    múltiplos pedidos em voo por ``req_id``). Aqui há no máximo um pedido pendente —
    adequado a um consumidor sequencial (ditado, TTS on-demand).
    """

    def __init__(self, pipe: str = DEFAULT_PIPE, connect_timeout: float = 5.0):
        self.pipe_name = pipe
        self._lock = threading.Lock()   # serializa 1 request/resposta
        self._fh = None
        self._rid = 0
        deadline = time.time() + max(0.0, connect_timeout)
        last_err = None
        while True:
            try:
                self._fh = open(pipe, "r+b", buffering=0)  # noqa: SIM115
                break
            except OSError as e:
                last_err = e
                if time.time() >= deadline:
                    raise
                time.sleep(0.1)
        if self._fh is None:  # pragma: no cover - defensivo
            raise (last_err or OSError("não abriu o pipe"))

    @classmethod
    def try_connect(cls, pipe: str = DEFAULT_PIPE,
                    connect_timeout: float = 2.0) -> "VoxClient | None":
        """Conecta se o daemon existir; senão devolve ``None`` (não levanta).

        É a política "reusa se existe": tenta o motor único e, se não estiver no
        ar, o chamador cai para outra estratégia."""
        try:
            return cls(pipe, connect_timeout)
        except (OSError, ValueError):
            return None

    @property
    def connected(self) -> bool:
        return self._fh is not None

    # ---- I/O bruto ----
    def _close_fh(self):
        try:
            if self._fh:
                self._fh.close()
        except OSError:
            pass
        self._fh = None

    @staticmethod
    def _read_exact(fh, n: int) -> bytes:
        """Lê n bytes de UM handle específico (nunca relê self._fh — uma thread
        leitora abandonada fica presa no SEU pipe, não migra p/ um reconectado)."""
        buf = b""
        while len(buf) < n:
            chunk = fh.read(n - len(buf))
            if not chunk:
                raise EOFError("pipe fechado")
            buf += chunk
        return buf

    def _request(self, header: dict, audio: bytes = b"",
                 timeout: float = 120.0) -> "tuple[dict, bytes]":
        """Envia 1 frame e lê a resposta com TETO de tamanho e TIMEOUT.

        Serializado pelo lock (single-in-flight). A leitura roda numa thread presa
        ao handle capturado aqui; ``join(timeout)`` garante que um motor travado no
        meio do frame não congele o chamador — vira :class:`VoxEngineError`."""
        with self._lock:
            fh = self._fh
            if fh is None:
                raise VoxEngineError("conexão com o motor caiu")
            try:
                fh.write(encode_message(header, audio))
                fh.flush()
            except Exception as exc:  # noqa: BLE001
                self._close_fh()
                raise VoxEngineError(f"falha ao enviar ao motor: {exc}") from exc
            out: dict = {}

            def _read_reply():
                try:
                    head = self._read_exact(fh, _HDR.size)
                    jl, al = _HDR.unpack(head)
                    if jl > MAX_JSON or al > MAX_AUDIO or jl == 0:
                        raise ProtocolError(f"frame absurdo (jl={jl}, al={al})")
                    body = self._read_exact(fh, jl)
                    audio_out = self._read_exact(fh, al) if al else b""
                    out["resp"] = (json.loads(body.decode("utf-8")), audio_out)
                except Exception as exc:  # noqa: BLE001
                    out["err"] = exc

            rt = threading.Thread(target=_read_reply, daemon=True)
            rt.start()
            rt.join(timeout)
            if rt.is_alive():
                # Não fechamos com read() pendente (bloquearia no lock do objeto);
                # soltamos a referência viva — a thread morre quando o handle fechar.
                if self._fh is fh:
                    self._fh = None
                raise VoxEngineError(
                    f"timeout ({timeout:.0f}s) aguardando resposta do motor")
            if "err" in out:
                self._close_fh()
                raise VoxEngineError(f"falha de protocolo: {out['err']}")
            return out["resp"]

    # ---- comandos de alto nível ----
    def _next_rid(self) -> str:
        self._rid += 1
        return str(self._rid)

    def ping(self, timeout: float = 5.0) -> bool:
        """True se o daemon respondeu ``pong``."""
        h, _ = self._request({"cmd": "ping", "req_id": self._next_rid()}, timeout=timeout)
        return h.get("event") == "pong"

    def info(self, timeout: float = 5.0) -> dict:
        """Estado do motor: ``{version, model, provider, stt_ready, tts_ready, ...}``."""
        h, _ = self._request({"cmd": "info", "req_id": self._next_rid()}, timeout=timeout)
        return h

    def transcribe(self, audio, lang: str = "", session: str = "default",
                   priority: str = "interactive", timeout: float = 120.0) -> str:
        """Transcreve ``audio`` (float32 16k mono: bytes, ndarray ou iterável) e
        devolve o texto. Levanta :class:`VoxEngineError` se o motor não retornar
        ``result``."""
        pcm = _to_pcm_bytes(audio)
        h, _ = self._request({"cmd": "transcribe", "req_id": self._next_rid(),
                              "session": session, "lang": lang or "",
                              "priority": priority}, pcm, timeout=timeout)
        if h.get("event") == "result":
            return (h.get("text") or "").strip()
        raise VoxEngineError(
            f"motor retornou {h.get('event')}/{h.get('code')}: {h.get('message') or ''}")

    def tts(self, text: str, fmt: str = "pcm", voice: "str | None" = None,
            speed: float = 1.0, session: str = "default",
            priority: str = "interactive", timeout: float = 120.0):
        """Sintetiza ``text``.

        Com ``fmt="pcm"`` (default) devolve ``(header, samples)`` — ``samples`` é um
        ``numpy.ndarray`` float32 quando numpy existe, senão os ``bytes`` PCM crus
        (numpy é opcional no consumidor). Com um formato comprimido
        (``opus``/``mp3``/``wav``/``vorbis``) devolve ``(header, bytes)`` já
        codificados. O tipo do retorno depende SÓ do ``fmt`` deste request."""
        req = {"cmd": "tts", "req_id": self._next_rid(), "session": session,
               "text": text, "voice": voice, "speed": speed, "priority": priority}
        if fmt and fmt != "pcm":
            req["format"] = fmt
        h, audio = self._request(req, timeout=timeout)
        if fmt and fmt != "pcm":
            return h, audio                      # bytes codificados, sem interpretar
        if _np is not None:
            samples = _np.frombuffer(audio, dtype="<f4") if audio else _np.zeros(0, _np.float32)
            return h, samples
        return h, audio                          # numpy ausente ⇒ bytes PCM crus

    def encode_formats(self, timeout: float = 5.0) -> "list[str]":
        """Formatos de saída de TTS servíveis pelo daemon (capability discovery)."""
        return list(self.info(timeout=timeout).get("encode_formats") or ["pcm"])

    def close(self) -> None:
        with self._lock:
            self._close_fh()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------------------------------------------------------------------------
# Versão: parse/compare (porta de core/updater.py).
# ---------------------------------------------------------------------------
def parse_version(v: str) -> "tuple[int, ...]":
    """'0.1.0' | 'vox-engine-v0.1.0' | 'v0.1.0' -> (0,1,0). Robusto a sufixos.

    FIX 7: só dígitos ASCII ``0-9`` contam (paridade EXATA com o Node e contrato
    never-throws). ``ch.isdigit()`` aceitaria '²' (isdigit()=True, mas int('²')
    LEVANTA ValueError) e dígitos Unicode ('١','๑','１') que ``int()`` converteria
    de forma divergente do Node — aqui qualquer não-ASCII encerra a parte."""
    v = (v or "").strip()
    if v.startswith(TAG_PREFIX):
        v = v[len(TAG_PREFIX):]
    v = v.lstrip("vV")
    nums = []
    for part in v.split("."):
        digits = ""
        for ch in part:
            if ch in "0123456789":     # SOMENTE ASCII 0-9 (nunca int() de Unicode)
                digits += ch
            else:
                break
        nums.append(int(digits) if digits else 0)
    return tuple(nums) or (0,)


def is_newer(candidate: str, current: str) -> bool:
    """True se ``candidate`` é estritamente maior que ``current``."""
    return parse_version(candidate) > parse_version(current)


# ---------------------------------------------------------------------------
# HTTP (urllib) + TLS corporativo opcional (truststore, import-guarded).
# ---------------------------------------------------------------------------
_TRUSTSTORE_TRIED = False


def _maybe_inject_truststore() -> None:
    """Best-effort: usa o cofre de certificados do SO (proxies de inspeção
    corporativa) SE ``truststore`` estiver instalado. Zero dependência obrigatória."""
    global _TRUSTSTORE_TRIED
    if _TRUSTSTORE_TRIED:
        return
    _TRUSTSTORE_TRIED = True
    try:
        import truststore  # type: ignore
        truststore.inject_into_ssl()
    except Exception:  # noqa: BLE001
        pass


def _default_http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": f"vox-sdk/{SDK_VERSION}",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        return r.read()


def latest_release(http_get=None) -> "dict | None":
    """Release mais nova do motor na vitrine que tenha AMBOS os assets
    (``vox-engine-installer.zip`` **e** ``.sig``): ``{version,tag,asset_url,sig_url}``
    ou ``None``. Sem ``.sig`` a release é inútil (fail-closed) → ignorada."""
    getter = http_get or _default_http_get
    if getter is _default_http_get:
        _maybe_inject_truststore()
    try:
        raw = getter(RELEASES_API)
        data = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except Exception:  # noqa: BLE001
        return None
    best = None
    for rel in data if isinstance(data, list) else []:
        tag = rel.get("tag_name", "") or ""
        if not tag.startswith(TAG_PREFIX):
            continue
        asset_url = sig_url = None
        for a in rel.get("assets", []) or []:
            name = a.get("name")
            if name == INSTALLER_ASSET:
                asset_url = a.get("browser_download_url")
            elif name == SIG_ASSET:
                sig_url = a.get("browser_download_url")
        if not asset_url or not sig_url:
            continue  # precisa dos DOIS (sem sig não há como verificar)
        cand = {"version": tag[len(TAG_PREFIX):], "tag": tag,
                "asset_url": asset_url, "sig_url": sig_url}
        if best is None or is_newer(cand["version"], best["version"]):
            best = cand
    return best


def installed_version(python_exe: "str | None" = None, run=None) -> "str | None":
    """Versão do motor INSTALADO — roda o python do venv instalado
    (``import vox_engine; __version__``). ``None`` se ausente / import falho /
    install quebrado."""
    python_exe = python_exe or INSTALLED_PYTHON
    runner = run or subprocess.run
    try:
        if not python_exe or not os.path.exists(python_exe):
            return None
    except Exception:  # noqa: BLE001
        return None
    try:
        out = runner([python_exe, "-c",
                      "import vox_engine,sys;sys.stdout.write(vox_engine.__version__)"],
                     capture_output=True, text=True, timeout=30)
        v = (getattr(out, "stdout", "") or "").strip()
        return v or None
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Download + install (fail-closed): baixa, VERIFICA, extrai, roda install.ps1.
# ---------------------------------------------------------------------------
def _kill_tree(proc) -> None:
    """Mata o processo do install E TODA a árvore de netos (py/venv/pip) no
    Windows. ``taskkill /PID <pid> /T /F`` derruba a árvore a partir da raiz.
    Best-effort, nunca levanta."""
    pid = getattr(proc, "pid", None)
    if pid is not None:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=10)
    except Exception:  # noqa: BLE001
        pass


def _run_installer(args, *, timeout: float, log_path: str):
    """Roda o ``install.ps1`` destacando stdout/err para um ARQUIVO (não pipes:
    o install.ps1 gera netos py/venv/pip que herdariam pipes e poderiam travar).
    Mata a ÁRVORE inteira no timeout. Devolve um objeto com ``.returncode``."""
    proc = None
    try:
        with open(log_path, "wb") as outf:
            proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=outf,
                                    stderr=subprocess.STDOUT, close_fds=True)
            rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        return types.SimpleNamespace(returncode=-1, timed_out=True)
    except Exception:  # noqa: BLE001
        if proc is not None:
            _kill_tree(proc)
        raise
    return types.SimpleNamespace(returncode=rc, timed_out=False)


def download_and_run_installer(asset_url: str, sig_url: "str | None" = None, *,
                               http_get=None, run=None, extra_args=None,
                               pipe: "str | None" = None,
                               target_version: "str | None" = None,
                               connect=None, python_exe: "str | None" = None,
                               lock_dir: "str | None" = None,
                               stale_ms: int = STALE_MS,
                               acquire_timeout_ms: int = ACQUIRE_TIMEOUT_MS,
                               poll_ms: int = POLL_MS) -> bool:
    """Baixa o installer.zip + ``.sig``, VERIFICA Ed25519 (fail-closed), extrai e
    roda ``install.ps1 -NoStart``. Devolve ``True`` só com ``rc == 0``.

    **LOCK (FIX 4 — paridade Node)**: adquire o ``_InstallLock`` compartilhado e
    envolve re-checagem + verify + install. Assim o ``check_and_update`` PÚBLICO (e
    qualquer chamador direto) fica serializado entre processos/linguagens — não só o
    ``ensure_vox_detailed``. Se o lock não vier (outro instalador ativo), devolve
    ``True`` se já estivermos na ``target_version`` (o outro terminou), senão ``False``.

    **Re-check sob o lock**: se ``pipe`` está no ar (outro subiu o daemon) ou já
    estamos na ``target_version``, PULA a instalação (devolve ``True``).

    **Segurança**: sem ``sig_url`` recusa ANTES de baixar o blob (FIX 5, fail-fast);
    sem ``.sig`` baixável ou assinatura inválida ⇒ ``False`` e o ``install.ps1`` NUNCA
    roda. A extração usa os BYTES VERIFICADOS em memória (``io.BytesIO``), sem re-ler
    um arquivo em disco (FIX 6 — evita TOCTOU entre verify e extract). Limpa o temp
    SEMPRE e libera o lock SEMPRE (finally)."""
    # FIX 5: sem sig_url a release é inútil ⇒ recusa ANTES de baixar o blob (fail-fast).
    if not sig_url:
        return False  # fail-closed: release sem .sig ⇒ nunca instala

    getter = http_get or _default_http_get
    runner = run or _run_installer
    if getter is _default_http_get:
        _maybe_inject_truststore()

    def _already_current() -> bool:
        """True se o motor instalado já está na ``target_version`` (ou mais novo)."""
        if target_version is None:
            return False
        cur = installed_version(python_exe, run=run)
        return cur is not None and not is_newer(target_version, cur)

    # FIX 4: LOCK cross-process em volta de re-check + verify + install.
    lock = _InstallLock(lock_dir, stale_ms=stale_ms,
                        acquire_timeout_ms=acquire_timeout_ms, poll_ms=poll_ms)
    if not lock.acquire():
        # Outro instalador segurou o lock o tempo todo — não falha às cegas: ele
        # pode ter terminado. Se já estamos na versão-alvo, trata como sucesso.
        return _already_current()

    tmp = None
    try:
        # RE-CHECK sob o lock (corrida: alguém instalou/subiu enquanto esperávamos).
        if pipe:
            connector = connect or VoxClient.try_connect
            try:
                c = connector(pipe, 0.5)
                if c is not None:
                    try:
                        c.close()
                    except Exception:  # noqa: BLE001
                        pass
                    return True         # daemon subiu no meio-tempo
            except Exception:  # noqa: BLE001
                pass
        if _already_current():
            return True                 # outro instalador já satisfez o alvo

        try:
            blob = getter(asset_url)
        except Exception:  # noqa: BLE001
            return False
        try:
            signature = getter(sig_url)
        except Exception:  # noqa: BLE001
            return False
        if not verify_installer(blob, signature):
            return False  # assinatura inválida/ausente ⇒ NÃO executa (fail-closed)

        # FIX 6: extrai dos BYTES VERIFICADOS (io.BytesIO) — sem gravar/re-ler o zip
        # em disco entre o verify e a extração (fecha a janela TOCTOU).
        tmp = tempfile.mkdtemp(prefix="vox-sdk-install-")
        out_path = os.path.join(tmp, "install-output.log")
        try:
            with zipfile.ZipFile(io.BytesIO(bytes(blob))) as z:
                z.extractall(tmp)
        except Exception:  # noqa: BLE001 — zip corrompido / download parcial
            return False
        install_ps1 = os.path.join(tmp, "install.ps1")
        if not os.path.exists(install_ps1):
            return False  # zip sem install.ps1 na raiz
        args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", install_ps1, "-NoStart", *(extra_args or [])]
        try:
            res = runner(args, timeout=INSTALL_TIMEOUT_MS / 1000.0, log_path=out_path)
        except Exception:  # noqa: BLE001 — powershell ausente etc.
            return False
        return getattr(res, "returncode", 1) == 0
    finally:
        lock.release()
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def check_and_update(python_exe: "str | None" = None, *, http_get=None, run=None,
                     latest: "dict | None" = None, pipe: "str | None" = None,
                     connect=None, lock_dir: "str | None" = None) -> dict:
    """Decide e executa a atualização. Devolve
    ``{'action','installed','latest'}`` com ``action`` ∈
    ``up_to_date|installed|updated|offline_installed|unavailable|failed``.

    Regras (fail-closed): sem release e sem instalado ⇒ ``unavailable``; sem
    release mas instalado ⇒ ``offline_installed`` (usa o existente); atual ⇒
    ``up_to_date`` (NÃO baixa); ausente/velho ⇒ baixa+verifica+instala; verify/
    download falho ⇒ NÃO roda install.ps1 (usa o existente se houver, senão
    ``failed``); pós-install não importável ⇒ ``failed`` (não sobe lixo).

    O LOCK de instalação vive DENTRO de ``download_and_run_installer`` (FIX 4), então
    este ponto de entrada público também fica serializado entre processos."""
    python_exe = python_exe or INSTALLED_PYTHON
    if latest is None:
        latest = latest_release(http_get=http_get)
    cur = installed_version(python_exe, run=run)
    if latest is None:
        return {"action": ("offline_installed" if cur else "unavailable"),
                "installed": cur, "latest": None}
    if cur is not None and not is_newer(latest["version"], cur):
        return {"action": "up_to_date", "installed": cur, "latest": latest["version"]}
    ok = download_and_run_installer(latest["asset_url"], latest.get("sig_url"),
                                    http_get=http_get, run=run, pipe=pipe,
                                    target_version=latest["version"], connect=connect,
                                    python_exe=python_exe, lock_dir=lock_dir)
    if not ok:
        # update é best-effort: sem verify/download/install, usa o existente.
        return {"action": ("offline_installed" if cur else "failed"),
                "installed": cur, "latest": latest["version"]}
    new = installed_version(python_exe, run=run)
    if new is None:
        return {"action": "failed", "installed": cur, "latest": latest["version"]}
    return {"action": ("installed" if cur is None else "updated"),
            "installed": new, "latest": latest["version"]}


# ---------------------------------------------------------------------------
# LOCK cross-process (dir-lock atômico) — convenção IDÊNTICA ao SDK Node.
# ---------------------------------------------------------------------------
def _now_ms() -> int:
    return int(time.time() * 1000)


class _InstallLock:
    """Lock de instalação/atualização compartilhado entre processos (e linguagens).

    Aquisição por ``os.mkdir`` atômico em ``LOCK_DIR`` (falha se já existe). Grava
    ``meta.json`` = ``{"pid","ts","lang":"python"}`` dentro. Recupera locks órfãos
    (dir/meta mais velho que ``STALE_MS``). Poll a cada ``POLL_MS`` até
    ``ACQUIRE_TIMEOUT_MS``. Sempre libera em ``release`` (remove meta + rmdir)."""

    def __init__(self, lock_dir: "str | None" = None, *,
                 stale_ms: int = STALE_MS, acquire_timeout_ms: int = ACQUIRE_TIMEOUT_MS,
                 poll_ms: int = POLL_MS):
        self.lock_dir = lock_dir or LOCK_DIR   # lê o global em tempo de chamada
        self.meta_path = os.path.join(self.lock_dir, "meta.json")
        self.stale_ms = stale_ms
        self.acquire_timeout_ms = acquire_timeout_ms
        self.poll_ms = poll_ms
        self.acquired = False

    def _write_meta(self) -> None:
        try:
            with open(self.meta_path, "w", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "ts": _now_ms(), "lang": "python"}, f)
        except Exception:  # noqa: BLE001 — meta é diagnóstico; não falha o lock
            pass

    def _lock_age_ms(self) -> "int | None":
        """Idade (ms) do lock: ``ts`` do meta.json, senão mtime do dir. None se sumiu."""
        try:
            with open(self.meta_path, "r", encoding="utf-8") as f:
                ts = json.load(f).get("ts")
            if isinstance(ts, (int, float)):
                return _now_ms() - int(ts)
        except Exception:  # noqa: BLE001 — sem meta legível: cai p/ mtime do dir
            pass
        try:
            return _now_ms() - int(os.path.getmtime(self.lock_dir) * 1000)
        except OSError:
            return None

    def _is_stale(self) -> bool:
        age = self._lock_age_ms()
        return age is not None and age > self.stale_ms

    def _steal(self) -> None:
        shutil.rmtree(self.lock_dir, ignore_errors=True)

    def _owned_by_us(self) -> bool:
        """True se o ``meta.json`` em disco tem o NOSSO pid (o lock ainda é nosso).

        Sem meta legível ou com pid diferente ⇒ ``False`` (nosso lock foi roubado por
        outro processo, que recriou o dir). Nunca levanta."""
        try:
            with open(self.meta_path, "r", encoding="utf-8") as f:
                return json.load(f).get("pid") == os.getpid()
        except Exception:  # noqa: BLE001 — sem prova de posse ⇒ não é (comprovadamente) nosso
            return False

    def acquire(self) -> bool:
        """Adquire o lock. ``True`` se conseguiu, ``False`` no timeout (outro
        instalador ativo). Cria o diretório-pai se preciso."""
        try:
            os.makedirs(os.path.dirname(self.lock_dir), exist_ok=True)
        except Exception:  # noqa: BLE001
            pass
        deadline = _now_ms() + self.acquire_timeout_ms
        while True:
            try:
                os.mkdir(self.lock_dir)     # atômico: falha se já existe
                self._write_meta()
                self.acquired = True
                return True
            except FileExistsError:
                if self._is_stale():
                    self._steal()           # lock órfão: tenta roubar
                    if os.path.isdir(self.lock_dir):
                        # roubo NÃO removeu o dir (ex.: arquivo preso no Windows):
                        # respeita deadline + backoff em vez de hot-spin (não gira
                        # sem dormir). Retenta o mkdir após o sleep.
                        if _now_ms() >= deadline:
                            return False
                        time.sleep(self.poll_ms / 1000.0)
                    continue                # dir removido ⇒ retenta o mkdir de imediato
                if _now_ms() >= deadline:
                    return False
                time.sleep(self.poll_ms / 1000.0)
            except OSError:
                if _now_ms() >= deadline:
                    return False
                time.sleep(self.poll_ms / 1000.0)

    def release(self) -> None:
        """Libera o lock SOMENTE se ele ainda é NOSSO (``meta.pid == getpid()``).

        Se o nosso lock foi roubado (meta sumiu ou tem outro pid), NÃO removemos —
        estaríamos apagando o lock de outro processo. Idempotente, nunca levanta."""
        if not self.acquired:
            return
        self.acquired = False
        if not self._owned_by_us():
            return  # lock roubado: não mexe no dir/meta de outro dono
        try:
            os.remove(self.meta_path)
        except OSError:
            pass
        try:
            os.rmdir(self.lock_dir)
        except OSError:
            shutil.rmtree(self.lock_dir, ignore_errors=True)

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


# ---------------------------------------------------------------------------
# Subir o daemon INSTALADO (destacado, sem janela) + esperar o pipe.
# ---------------------------------------------------------------------------
def start_installed_daemon(pipe: str = DEFAULT_PIPE, *, run=None) -> bool:
    """Sobe o daemon INSTALADO destacado (``DETACHED_PROCESS | CREATE_NO_WINDOW``)
    via ``pythonw.exe -m vox_engine``. Devolve ``False`` se o motor não está
    instalado ou o lançamento falhou. stdout/err do boot vão p/ um log (captura um
    crash de import antes do ``--log-file`` do próprio daemon)."""
    pyw = INSTALLED_PYTHONW
    if not os.path.exists(pyw):
        return False
    try:
        os.makedirs(os.path.dirname(DAEMON_LOG), exist_ok=True)
        flags = 0x00000008 | 0x08000000   # DETACHED_PROCESS | CREATE_NO_WINDOW
        bf = open(DAEMON_BOOT_LOG, "ab")   # noqa: SIM115
        try:
            subprocess.Popen([pyw, "-m", "vox_engine", "--pipe", pipe,
                              "--log-file", DAEMON_LOG], creationflags=flags,
                             close_fds=True, stdin=subprocess.DEVNULL,
                             stdout=bf, stderr=bf)
        finally:
            bf.close()
        return True
    except Exception:  # noqa: BLE001 — lançamento falhou
        return False


def _wait_for_pipe(pipe: str, boot_timeout: float) -> "VoxClient | None":
    """Espera o pipe subir (poll) até ``boot_timeout`` e devolve o cliente, ou
    ``None`` se não apareceu (provável crash de import no daemon)."""
    deadline = time.time() + max(0.0, boot_timeout)
    while time.time() < deadline:
        c = VoxClient.try_connect(pipe, connect_timeout=1.0)
        if c is not None:
            return c
        time.sleep(0.5)
    return None


# ---------------------------------------------------------------------------
# Máquina de estados: ensure_vox / ensure_vox_detailed.
# ---------------------------------------------------------------------------
def _reuse_result(client: "VoxClient", *, auto_update: bool, http_get) -> dict:
    """Monta o resultado do caminho de REUSO (daemon já no ar): lê info.version e
    reporta ``updateAvailable`` best-effort (não perturba o daemon servindo)."""
    runtime_ver = None
    try:
        runtime_ver = (client.info() or {}).get("version")
    except Exception:  # noqa: BLE001
        runtime_ver = None
    latest = latest_release(http_get=http_get) if auto_update else None
    return {
        "client": client,
        "installedVersion": runtime_ver,
        "latestVersion": latest["version"] if latest else None,
        "updateAvailable": bool(latest and runtime_ver
                                and is_newer(latest["version"], runtime_ver)),
        "action": "reused",
    }


def ensure_vox_detailed(pipe: "str | None" = None, *, autostart: bool = True,
                        auto_update: bool = True,
                        connect_timeout_ms: "int | None" = None,
                        boot_timeout_ms: "int | None" = None,
                        python_exe: "str | None" = None,
                        http_get=None, run=None) -> dict:
    """Install → update → use, com relatório. Devolve um dict com as MESMAS chaves
    do SDK Node: ``{client, installedVersion, latestVersion, updateAvailable, action}``.

    ``action`` ∈ ``reused | installed | updated | up_to_date | offline_installed |
    failed | unavailable``.

    Estados:
      1. **pipe no ar** ⇒ devolve o cliente conectado (``reused``) + sinaliza
         ``updateAvailable`` comparando ``info.version`` com a release — NÃO baixa,
         NÃO derruba a sessão viva.
      2. **pipe fora** ⇒ re-checa (outro pode ter subido/instalado) e decide:
         ausente/velho ⇒ baixa+VERIFICA(fail-closed)+``install.ps1 -NoStart`` (o LOCK
         de instalação vive DENTRO de ``download_and_run_installer`` — FIX 4);
         offline+instalado ⇒ usa o instalado; offline+ausente ⇒ ``unavailable``.
      3. sobe o daemon instalado e espera o pipe (boot generoso). Falha ⇒ ``failed``.
    """
    pipe = pipe or DEFAULT_PIPE
    connect_timeout = (connect_timeout_ms if connect_timeout_ms is not None
                       else CONNECT_TIMEOUT_MS) / 1000.0
    boot_timeout = (boot_timeout_ms if boot_timeout_ms is not None
                    else BOOT_TIMEOUT_MS) / 1000.0
    result = {"client": None, "installedVersion": None, "latestVersion": None,
              "updateAvailable": False, "action": "unavailable"}

    # ---- (1) reuso: daemon já no ar ----
    client = VoxClient.try_connect(pipe, connect_timeout)
    if client is not None:
        return _reuse_result(client, auto_update=auto_update, http_get=http_get)

    if not autostart:
        result["action"] = "unavailable"
        return result

    # ---- (2) re-checar + decidir + instalar ----
    # FIX 4: NÃO há lock externo aqui — o mesmo processo não pode dar mkdir no mesmo
    # dir duas vezes (deadlock). O lock cross-process vive DENTRO de
    # download_and_run_installer, que também re-checa versão-alvo sob o lock.
    # RE-CHECAR: outro cliente pode ter subido o daemon enquanto conectávamos.
    client = VoxClient.try_connect(pipe, min(connect_timeout, 2.0))
    if client is not None:
        return _reuse_result(client, auto_update=auto_update, http_get=http_get)

    latest = latest_release(http_get=http_get) if auto_update else None
    result["latestVersion"] = latest["version"] if latest else None
    cur = installed_version(python_exe, run=run)

    need_install = latest is not None and (cur is None or is_newer(latest["version"], cur))

    if need_install:
        ok = download_and_run_installer(latest["asset_url"], latest.get("sig_url"),
                                        http_get=http_get, run=run, pipe=pipe,
                                        target_version=latest["version"],
                                        python_exe=python_exe)
        if not ok:
            # verify/download/install/lock falho (fail-closed): usa o existente.
            if cur is None:
                result["action"] = "failed"
                return result
            action, cur_ver = "offline_installed", cur
        else:
            new = installed_version(python_exe, run=run)
            if new is None:
                # install quebrado: NÃO sobe lixo.
                result["action"] = "failed"
                return result
            action = "installed" if cur is None else "updated"
            cur_ver = new
    elif latest is not None:
        action, cur_ver = "up_to_date", cur   # instalado e atual
    else:
        # Sem release (offline ou auto_update=False).
        if cur is None:
            result["action"] = "unavailable"
            return result
        action, cur_ver = "offline_installed", cur

    result["installedVersion"] = cur_ver

    # ---- (3) subir o daemon instalado + esperar o pipe ----
    if not start_installed_daemon(pipe, run=run):
        result["action"] = "failed"
        return result
    client = _wait_for_pipe(pipe, boot_timeout)
    if client is None:
        result["action"] = "failed"
        return result
    result["client"] = client
    result["action"] = action
    try:
        rv = (client.info() or {}).get("version")
        if rv:
            result["installedVersion"] = rv
    except Exception:  # noqa: BLE001
        pass
    return result


def ensure_vox(pipe: "str | None" = None, **opts) -> "VoxClient | None":
    """Instala/atualiza/usa o motor e devolve um :class:`VoxClient` conectado, ou
    ``None`` para o chamador cair no seu fallback. Açúcar sobre
    :func:`ensure_vox_detailed` (mesmos ``opts``)."""
    return ensure_vox_detailed(pipe, **opts)["client"]
