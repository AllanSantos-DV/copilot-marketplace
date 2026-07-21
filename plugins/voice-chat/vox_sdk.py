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
from typing import Literal

# ---------------------------------------------------------------------------
# CONFIG canônica — fonte única (os MESMOS valores no SDK Node irmão).
# ---------------------------------------------------------------------------
SDK_VERSION = "1.10.0"

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
INSTALLED_DICTATE = os.path.join(INSTALL_ROOT, "venv", "Scripts", "vox-dictate.exe")
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

# ---------------------------------------------------------------------------
# SUPERFÍCIE DE CAPACIDADES — tipos permitidos que o cliente importa (autocomplete)
# em vez de garimpar no código-fonte. Estas constantes ESPELHAM o daemon
# (``vox_engine.core.profiles``/``hardware``/``audio_encode`` + ``daemon.inference``);
# o teste anti-drift (tests/test_sdk_capabilities_parity.py) TRAVA a paridade — se o
# daemon mudar e o SDK não, o CI quebra. Para o estado REAL desta máquina em runtime
# (perfil→modelo resolvido, formatos servíveis, vozes), use ``VoxClient.capabilities()``.
# ---------------------------------------------------------------------------
ProfileName = Literal["dictation", "translator", "transcription", "transcription_hq"]
ModelName = Literal["base", "small", "turbo", "large-v3"]
Priority = Literal["interactive", "batch"]
AudioFormat = Literal["pcm", "wav", "opus", "vorbis", "mp3"]

PROFILES: tuple[str, ...] = ("dictation", "translator", "transcription", "transcription_hq")
PROFILE_PURPOSE: dict[str, str] = {
    "dictation": "ditado / trecho curto — velocidade (streaming)",
    "translator": "tradução — qualidade",
    "transcription": "arquivo completo — rápido (padrão; mesmo motor do ditado)",
    "transcription_hq": "arquivo completo — qualidade máxima (áudio difícil/ruidoso)",
}
MODELS: tuple[str, ...] = ("base", "small", "turbo", "large-v3")
PRIORITIES: tuple[str, ...] = ("interactive", "batch")
DEFAULT_PRIORITY = "interactive"
AUDIO_FORMATS: tuple[str, ...] = ("pcm", "wav", "opus", "vorbis", "mp3")
DEFAULT_AUDIO_FORMAT = "pcm"


class Capabilities:
    """Retrato TIPADO do que o motor oferece NESTA máquina — uma chamada
    (:meth:`VoxClient.capabilities`) e o cliente sabe tudo, sem hardcode. Combina o
    handshake em RUNTIME (``info``: perfil→modelo já resolvido pro hardware, modelos
    residentes/permitidos, formatos servíveis, vozes) com as listas ESTÁTICAS conhecidas
    do SDK (``*_known``/``priorities``) — o padrão de mercado (typed + discovery).

    Classe simples (NÃO ``@dataclass``) de propósito: o SDK é vendorável e pode ser
    carregado standalone via ``importlib`` sem registrar em ``sys.modules``; um
    ``@dataclass`` sob ``from __future__ import annotations`` resolve as anotações via
    ``sys.modules[__module__]`` e QUEBRA nesse cenário. Um ``__init__`` explícito é imune."""

    def __init__(self, *, version=None, provider=None, hardware=None, profiles=None,
                 models_resident=None, models_allowed=None, models_known=MODELS,
                 audio_formats_available=None, audio_formats_known=AUDIO_FORMATS,
                 priorities=PRIORITIES, voices=None, supported_voices=None,
                 default_voice=None):
        self.version = version
        self.provider = provider
        self.hardware = hardware
        self.profiles = profiles if profiles is not None else {}       # runtime: nome -> {model,...}
        self.models_resident = models_resident if models_resident is not None else []
        self.models_allowed = models_allowed if models_allowed is not None else []
        self.models_known = models_known                                # estático (superset)
        self.audio_formats_available = (audio_formats_available
                                        if audio_formats_available is not None else [])
        self.audio_formats_known = audio_formats_known                  # estático (superset)
        self.priorities = priorities                                    # estático
        self.voices = voices if voices is not None else []
        self.supported_voices = supported_voices if supported_voices is not None else []
        self.default_voice = default_voice

    def __repr__(self) -> str:
        return (f"Capabilities(version={self.version!r}, provider={self.provider!r}, "
                f"profiles={list(self.profiles)}, models_resident={self.models_resident})")


__all__ = [
    "SDK_VERSION", "DEFAULT_PIPE", "PUBKEYS", "RELEASES_API", "TAG_PREFIX",
    "INSTALLER_ASSET", "SIG_ASSET",
    "PROFILES", "PROFILE_PURPOSE", "MODELS", "PRIORITIES", "DEFAULT_PRIORITY",
    "AUDIO_FORMATS", "DEFAULT_AUDIO_FORMAT", "Capabilities",
    "ProfileName", "ModelName", "Priority", "AudioFormat",
    "VoxClient", "VoxEngineError", "ProtocolError",
    "CaptureError", "CaptureHandle",
    "verify_installer", "encode_message", "read_message", "make_recv_exact",
    "parse_version", "is_newer", "latest_release", "installed_version",
    "download_and_run_installer", "check_and_update",
    "start_installed_daemon", "ensure_vox", "ensure_vox_detailed",
    "stop_daemon", "update_engine",
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


# numpy é OPCIONAL e LAZY: NÃO importa no topo (front-load) — só sob demanda, quando um
# consumidor DECODIFICA PCM. Assim um consumidor que só usa wav/transcrito (ex.: o worker fino do
# voice-chat) fica NUMPY-FREE no import → economia real de RAM por fork (numpy é o grosso do USS).
# Cacheado após a 1ª sondagem; devolve o módulo ou None se indisponível (Python sem wheels).
_np = None
_np_probed = False
_np_lock = threading.Lock()


def _numpy():
    """Importa numpy SOB DEMANDA (cacheado, thread-safe). None se indisponível — mantém numpy
    OPCIONAL. Double-checked locking: um 2º thread que vê ``_np_probed`` True enxerga ``_np`` já
    setado (a escrita de ``_np`` precede ``_np_probed=True`` sob o lock) — nunca um None espúrio."""
    global _np, _np_probed
    if not _np_probed:
        with _np_lock:
            if not _np_probed:
                try:  # pragma: no cover - depende do ambiente
                    import numpy as _mod
                except Exception:  # noqa: BLE001
                    _mod = None
                _np = _mod
                _np_probed = True
    return _np


def _pcm_reply(h: dict, audio: bytes):
    """Decodifica o payload PCM float32 LE em ndarray se numpy houver; senão devolve os bytes
    crus. numpy é carregado LAZY aqui — quem nunca chama isto nunca importa numpy."""
    np = _numpy()
    if np is not None:
        return h, (np.frombuffer(audio, dtype="<f4") if audio else np.zeros(0, np.float32))
    return h, audio


def _to_pcm_bytes(audio) -> bytes:
    """Converte ``audio`` para PCM float32 little-endian.

    Aceita ``bytes``/``bytearray`` (repassa), ``numpy.ndarray`` (se numpy houver)
    ou qualquer iterável de floats (fallback stdlib via ``array``)."""
    if isinstance(audio, (bytes, bytearray)):
        return bytes(audio)
    np = _numpy()
    if np is not None:
        try:
            return np.ascontiguousarray(audio, dtype="<f4").tobytes()
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


class _PartialSend(Exception):
    """Frame enviado só EM PARTE antes de falhar: NÃO é repetível (bytes já
    chegaram ao motor -> reenviar corromperia o stream / duplicaria o pedido)."""

    def __init__(self, sent: int):
        super().__init__(f"envio parcial ({sent} bytes)")
        self.sent = sent


# ---------------------------------------------------------------------------
# Transporte de pipe OVERLAPPED (ctypes/kernel32) — SÓ para a captura (stream).
# ---------------------------------------------------------------------------
# Um handle SÍNCRONO (``open(pipe,"r+b")``) serializa TODA a I/O do handle: um
# ``ReadFile`` bloqueado (thread-leitora) trava um ``WriteFile`` concorrente (o
# ``close`` do consumidor) no MESMO handle -> deadlock. Por isso o daemon e o
# ``pipe_client`` interno usam ``FILE_FLAG_OVERLAPPED``. O ``VoxClient`` síncrono
# deste SDK é seguro só porque é estritamente serial (escreve-então-lê sob lock,
# sem thread-leitora persistente). A CAPTURA tem thread-leitora + escrita
# concorrente, então PRECISA de overlapped — aqui em stdlib puro (``ctypes``) para
# o SDK vendorável não exigir ``pywin32``. Só Windows (o transporte é named pipe).
_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_OPEN_EXISTING = 3
_FILE_FLAG_OVERLAPPED = 0x40000000
_PIPE_READMODE_BYTE = 0x00000000
_ERROR_IO_PENDING = 997
_ERROR_PIPE_BUSY = 231
_INVALID_HANDLE_VALUE = (1 << (8 * struct.calcsize("P"))) - 1  # (void*)-1, largura do ponteiro

_win_api_cache = None
_win_api_lock = threading.Lock()


def _win_api():
    """Configura (uma vez) os protótipos ``kernel32`` da captura. LAZY: só toca em ``WinDLL``
    quando uma captura é aberta — o import do SDK segue cross-platform e stdlib-puro. Devolve
    ``(kernel32, _OVERLAPPED, ctypes, wintypes)`` cacheado."""
    global _win_api_cache
    if _win_api_cache is not None:
        return _win_api_cache
    with _win_api_lock:
        if _win_api_cache is not None:
            return _win_api_cache
        import ctypes
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)

        class _OVERLAPPED(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p),
                        ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                        ("hEvent", wintypes.HANDLE)]

        _lpovl = ctypes.POINTER(_OVERLAPPED)
        _lpdw = ctypes.POINTER(wintypes.DWORD)
        k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k.CreateFileW.restype = wintypes.HANDLE
        k.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        k.CreateEventW.restype = wintypes.HANDLE
        k.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, _lpdw, _lpovl]
        k.ReadFile.restype = wintypes.BOOL
        k.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_char_p, wintypes.DWORD, _lpdw, _lpovl]
        k.WriteFile.restype = wintypes.BOOL
        k.GetOverlappedResult.argtypes = [wintypes.HANDLE, _lpovl, _lpdw, wintypes.BOOL]
        k.GetOverlappedResult.restype = wintypes.BOOL
        k.SetNamedPipeHandleState.argtypes = [wintypes.HANDLE, _lpdw, ctypes.c_void_p,
                                              ctypes.c_void_p]
        k.SetNamedPipeHandleState.restype = wintypes.BOOL
        k.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
        k.WaitNamedPipeW.restype = wintypes.BOOL
        k.CancelIoEx.argtypes = [wintypes.HANDLE, _lpovl]
        k.CancelIoEx.restype = wintypes.BOOL
        k.ResetEvent.argtypes = [wintypes.HANDLE]
        k.ResetEvent.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        _win_api_cache = (k, _OVERLAPPED, ctypes, wintypes)
        return _win_api_cache


class _OverlappedPipe:
    """fh duck-typed (``read``/``write``/``flush``/``close``) sobre um named pipe com I/O
    OVERLAPPED — leitura (thread-leitora) e escrita (consumidor) CONCORRENTES no MESMO handle
    sem deadlock. Cada operação tem seu próprio ``OVERLAPPED``; a leitura e a escrita usam
    EVENTOS separados (um leitor, escritas serializadas pelo handle) — nunca colidem."""

    def __init__(self, pipe_name: str, connect_timeout: float = 5.0):
        self._k, self._OVL, self._ctypes, self._wintypes = _win_api()
        self._closed = False
        self._close_lock = threading.Lock()
        self._h = self._connect(pipe_name, connect_timeout)
        self._read_evt = self._k.CreateEventW(None, True, False, None)
        self._write_evt = self._k.CreateEventW(None, True, False, None)
        if not self._read_evt or not self._write_evt:
            # fail-loud: sem os eventos manuais a I/O overlapped concorrente (a razão desta classe)
            # degradaria em silêncio p/ sinalização no próprio handle. Só sob exaustão de recursos.
            err = self._ctypes.get_last_error()
            for evt in (self._read_evt, self._write_evt):
                if evt:
                    try:
                        self._k.CloseHandle(evt)
                    except Exception:  # noqa: BLE001
                        pass
            try:
                self._k.CloseHandle(self._h)
            except Exception:  # noqa: BLE001
                pass
            raise OSError(f"CreateEvent falhou na captura: Win32 {err}")

    def _connect(self, pipe_name: str, timeout: float):
        ct = self._ctypes
        deadline = time.time() + max(0.0, timeout)
        while True:
            h = self._k.CreateFileW(pipe_name, _GENERIC_READ | _GENERIC_WRITE, 0, None,
                                    _OPEN_EXISTING, _FILE_FLAG_OVERLAPPED, None)
            if h and h != _INVALID_HANDLE_VALUE:
                mode = self._wintypes.DWORD(_PIPE_READMODE_BYTE)
                self._k.SetNamedPipeHandleState(h, ct.byref(mode), None, None)
                return h
            err = ct.get_last_error()
            if time.time() >= deadline:
                raise OSError(f"não abriu o pipe de captura {pipe_name}: erro Win32 {err}")
            if err == _ERROR_PIPE_BUSY:
                self._k.WaitNamedPipeW(pipe_name, 500)   # aguarda uma instância livre
            else:
                time.sleep(0.05)                          # ainda não existe/transiente: retenta

    def read(self, n: int) -> bytes:
        h = self._h
        if n <= 0 or self._closed or h is None:
            return b""
        ct = self._ctypes
        buf = ct.create_string_buffer(n)
        ov = self._OVL()
        ov.hEvent = self._read_evt
        self._k.ResetEvent(self._read_evt)
        ok = self._k.ReadFile(h, buf, n, None, ct.byref(ov))
        if not ok and ct.get_last_error() != _ERROR_IO_PENDING:
            return b""                        # pipe quebrado/abortado -> EOF (a leitora nunca cai)
        nread = self._wintypes.DWORD(0)
        if not self._k.GetOverlappedResult(h, ct.byref(ov), ct.byref(nread), True):
            return b""
        return buf.raw[:nread.value]

    def write(self, data) -> int:
        ct = self._ctypes
        h = self._h
        if self._closed or h is None:
            raise OSError("WriteFile da captura: conexão fechada")   # fail-loud
        data = bytes(data)
        ov = self._OVL()
        ov.hEvent = self._write_evt
        self._k.ResetEvent(self._write_evt)
        ok = self._k.WriteFile(h, data, len(data), None, ct.byref(ov))
        if not ok:
            err = ct.get_last_error()
            if err != _ERROR_IO_PENDING:
                raise OSError(f"WriteFile da captura falhou: Win32 {err}")  # fail-loud
        nwritten = self._wintypes.DWORD(0)
        if not self._k.GetOverlappedResult(h, ct.byref(ov), ct.byref(nwritten), True):
            raise OSError(f"WriteFile da captura incompleto: Win32 {ct.get_last_error()}")
        return nwritten.value

    def flush(self) -> None:
        pass

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            h, revt, wevt = self._h, self._read_evt, self._write_evt
            self._h = None                      # read/write posteriores desistem (sentinela) —
            #                                     nunca reusam um valor de handle já fechado
        try:
            self._k.CancelIoEx(h, None)         # destrava um ReadFile pendente de OUTRA thread
        except Exception:  # noqa: BLE001
            pass
        for evt in (revt, wevt):
            try:
                self._k.CloseHandle(evt)
            except Exception:  # noqa: BLE001
                pass
        try:
            self._k.CloseHandle(h)
        except Exception:  # noqa: BLE001
            pass


class CaptureError(VoxEngineError):
    """Falha TIPADA de captura — ``code`` estável para o cliente mapear em UI SEM parsear texto.
    Códigos do daemon: ``busy`` / ``mic_busy`` / ``already_open`` / ``mic_open_failed`` /
    ``capture_timeout`` / ``not_open`` / ``not_owner`` / ``capture_internal`` /
    ``capture_unavailable`` / ``no_session``; e o client-side ``pipe_broken`` (a conexão de
    captura caiu no meio)."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message


_cap_rid_lock = threading.Lock()
_cap_rid_n = 0


def _cap_rid() -> str:
    """req_id monotônico para frames de captura (conexão própria, independente do VoxClient)."""
    global _cap_rid_n
    with _cap_rid_lock:
        _cap_rid_n += 1
        return f"cap-{_cap_rid_n}"


class CaptureHandle:
    """Handle de UMA captura de sessão (mic → transcrição no daemon) sobre uma conexão de pipe
    DEDICADA. Ao contrário do :class:`VoxClient` (1 request → 1 resposta), a captura é um STREAM:
    o daemon empurra N frames assíncronos numa thread-leitora e CADA um é entregue a
    ``on_event(frame)`` — o único ``emit`` que o consumidor liga na sua ponte (callback→iterador).

    Formas do ``frame`` (discrimine por ``frame['event']``):
      * ``{event:"capture_segment", session, idx, text}``  — trecho transcrito (pipeline no daemon)
      * ``{event:"capture_level",   session, rms, peak, silent}`` — VU (~10 Hz); dica de exibição
      * ``{event:"capture_error",   session, code, message}``     — erro de device (``device_fail``)
        ou, client-side, ``code="pipe_broken"`` quando a conexão cai.

    ``close()`` (drena a cauda) / ``cancel()`` (aborta, descarta) fecham a captura e devolvem o
    ``capture_closed`` (texto + métricas). Fail-loud: conexão morta ⇒ ``capture_error`` tipado ao
    consumidor + desbloqueio de qualquer espera pendente. A instância É o read-loop; o consumidor
    só liga o ``on_event`` e chama ``close``/``cancel``."""

    def __init__(self, fh, session: str, on_event, *, open_header: dict,
                 open_timeout: float = 8.0):
        self._fh = fh
        self._session = session
        self._on_event = on_event
        self._lock = threading.Lock()
        self._opened = threading.Event()
        self._closed = threading.Event()
        self._open_ack: "dict | None" = None
        self._result: "dict | None" = None
        self._end_sent = False
        self._reader = threading.Thread(target=self._read_loop, name="vox-capture-reader",
                                        daemon=True)
        self._reader.start()
        # dispara o capture_open DEPOIS de o leitor estar de pé (segmentos/levels podem chegar
        # ANTES do ack — o feeder do mic já roda; o leitor os entrega ao on_event, sem perder).
        try:
            self._send_frame(open_header)
        except Exception as exc:  # noqa: BLE001 — pipe já morto no envio do open: fail-loud tipado
            self._teardown()
            raise CaptureError("pipe_broken", f"falha ao enviar capture_open: {exc}") from exc
        if not self._opened.wait(open_timeout):
            self._teardown()
            raise CaptureError("capture_timeout",
                               f"capture_open sem ack em {open_timeout:.1f}s")
        ack = self._open_ack or {}
        if ack.get("event") != "capture_open" or not ack.get("ok", False):
            self._teardown()
            raise CaptureError(ack.get("code") or "capture_failed",
                               ack.get("message") or "capture_open falhou")

    @property
    def session(self) -> str:
        return self._session

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def close(self, timeout: float = 8.0) -> dict:
        """Fecha a captura (drena a cauda transcrita) e devolve o ``capture_closed``
        (``text``/``peak``/``duration_s``/``chunks``/``errors``/``mic_ok``…)."""
        return self._end("capture_close", timeout)

    def cancel(self, timeout: float = 8.0) -> dict:
        """Aborta a captura (DESCARTA a cauda sem transcrever) e devolve o ``capture_closed``
        (``cancelled=True``)."""
        return self._end("capture_cancel", timeout)

    def _end(self, cmd: str, timeout: float) -> dict:
        with self._lock:
            already = self._end_sent
            self._end_sent = True
        if not already:
            try:
                self._send_frame({"cmd": cmd, "session": self._session, "req_id": _cap_rid()})
            except Exception as exc:  # noqa: BLE001 — pipe morto: o leitor já sinaliza pipe_broken
                self._closed.wait(timeout)
                self._teardown()
                if self._result is not None:
                    return self._result
                raise CaptureError("pipe_broken", f"falha ao enviar {cmd}: {exc}") from exc
        if not self._closed.wait(timeout):
            self._teardown()
            raise CaptureError("capture_timeout",
                               f"{cmd} sem capture_closed em {timeout:.1f}s")
        self._teardown()
        return self._result or {"event": "capture_closed", "session": self._session, "ok": False}

    # ------------------------------------------------------------ read-loop
    def _read_loop(self) -> None:
        recv_exact = make_recv_exact(self._fh.read)
        while True:
            try:
                header, _ = read_message(recv_exact)
            except (EOFError, ProtocolError, OSError, ValueError):
                self._fail_closed_local("pipe_broken", "conexão de captura caiu")
                return
            ev = header.get("event")
            if ev == "capture_open":
                self._open_ack = header
                self._opened.set()
                continue
            if ev == "capture_closed":
                self._result = header
                self._opened.set()             # defensivo: destrava um open ainda pendente
                self._closed.set()
                return
            if ev == "error":
                # erro de CONTROLE (no_session/capture_unavailable/not_open/not_owner/…): termina.
                if not self._opened.is_set():
                    self._open_ack = header     # falhou no open → o ctor levanta CaptureError
                else:
                    self._result = header       # falhou no close → vira o resultado
                self._opened.set()
                self._closed.set()
                return
            self._emit(header)                  # stream: capture_segment / capture_level / erro

    def _emit(self, header: dict) -> None:
        try:
            self._on_event(header)
        except Exception:  # noqa: BLE001 — o callback do consumidor NUNCA derruba o leitor
            pass

    def _fail_closed_local(self, code: str, message: str) -> None:
        """A conexão morreu (ou nunca respondeu): fabrica um ``capture_error`` TIPADO local,
        entrega ao consumidor e desbloqueia open/close pendentes com um resultado fail-loud."""
        self._emit({"event": "capture_error", "session": self._session,
                    "code": code, "message": message})
        if self._open_ack is None:
            self._open_ack = {"event": "error", "session": self._session,
                              "code": code, "message": message}
        if self._result is None:
            self._result = {"event": "capture_closed", "session": self._session,
                            "ok": False, "code": code, "message": message}
        self._opened.set()
        self._closed.set()

    def _send_frame(self, header: dict) -> None:
        data = encode_message(header)
        total = len(data)
        sent = 0
        while sent < total:
            n = self._fh.write(data if sent == 0 else data[sent:])
            if n is None:                       # handle não conta bytes (mocks) → assume tudo
                break
            if n <= 0:
                raise OSError("write da captura não progrediu")
            sent += n
        self._fh.flush()

    def _teardown(self) -> None:
        try:
            self._fh.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if not self._closed.is_set():
            try:
                self.close()
            except Exception:  # noqa: BLE001 — o exit nunca mascara a exceção original
                pass


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

    def __init__(self, pipe: str = DEFAULT_PIPE, connect_timeout: float = 5.0, *,
                 auto_reconnect: bool = False, reconnect_timeout: float = 0.25):
        self.pipe_name = pipe
        self._lock = threading.Lock()   # serializa 1 request/resposta
        self._fh = None
        self._rid = 0
        # auto_reconnect (opt-in, retrocompatível): quando o handle morre, o cliente o
        # REABRE sozinho — o consumidor não reimplementa a camada de reconexão. Disciplina
        # (idêntica à do ditado/voice-chat, validada): REPETE o request só na falha de
        # ESCRITA (o frame comprovadamente NÃO chegou -> idempotente-seguro); NUNCA repete
        # em leitura/timeout (o motor PODE ter processado -> evita double-process). O handle
        # morto é descartado e a PRÓXIMA chamada reconecta. reconnect_timeout é o "cushion"
        # (curto: absorve um ERROR_PIPE_BUSY transitório do pipe compartilhado sem o stall
        # do connect inicial).
        self._auto_reconnect = bool(auto_reconnect)
        self._reconnect_timeout = max(0.0, reconnect_timeout)
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
                    connect_timeout: float = 2.0, *,
                    auto_reconnect: bool = False,
                    reconnect_timeout: float = 0.25) -> "VoxClient | None":
        """Conecta se o daemon existir; senão devolve ``None`` (não levanta).

        É a política "reusa se existe": tenta o motor único e, se não estiver no
        ar, o chamador cai para outra estratégia. ``auto_reconnect`` propaga para o
        cliente (self-healing opt-in)."""
        try:
            return cls(pipe, connect_timeout, auto_reconnect=auto_reconnect,
                       reconnect_timeout=reconnect_timeout)
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

    def _try_reopen(self) -> bool:
        """Reabre o handle do pipe com o cushion (``reconnect_timeout``). True se
        reconectou. Só age com ``auto_reconnect``. Best-effort, nunca levanta.

        DEVE ser chamado com ``self._lock`` já retido (é chamado de dentro do
        ``_request``, que serializa) — não readquire o lock."""
        if not self._auto_reconnect:
            return False
        self._close_fh()
        deadline = time.time() + self._reconnect_timeout
        while True:
            try:
                self._fh = open(self.pipe_name, "r+b", buffering=0)  # noqa: SIM115
                return True
            except OSError:
                if time.time() >= deadline:
                    self._fh = None
                    return False
                time.sleep(0.05)

    def _send_frame(self, fh, header: dict, audio: bytes) -> None:
        """Escreve UM frame COMPLETO. ``FileIO.write`` (buffering=0) pode fazer um
        *short write* e devolver menos bytes SEM levantar — então escrevemos em laço
        até esgotar. Distinção crítica p/ o auto_reconnect:
          - 0 byte enviado antes da falha  -> levanta normal (frame NÃO chegou =>
            o chamador pode reconectar+repetir com segurança);
          - >0 byte enviado antes da falha -> levanta :class:`_PartialSend` (o frame
            chegou EM PARTE => reenviar duplicaria/corromperia -> NÃO repetir)."""
        data = encode_message(header, audio)
        total = len(data)
        sent = 0
        try:
            while sent < total:
                # bytes (não memoryview): handles/mocks fazem .decode/slice sobre bytes.
                n = fh.write(data if sent == 0 else data[sent:])
                if n is None:          # handle não conta bytes (convenção/mocks) -> assume tudo
                    sent = total
                    break
                if n <= 0:             # sem progresso: não laça infinito
                    raise OSError("write não progrediu (motor não consumiu o frame)")
                sent += n
            fh.flush()
        except Exception as exc:  # noqa: BLE001
            if sent > 0:
                raise _PartialSend(sent) from exc
            raise

    def _read_reply(self, fh, timeout: float) -> "tuple[dict, bytes]":
        """Lê a resposta de ``fh`` com TETO de tamanho e TIMEOUT numa thread presa ao
        handle. Timeout -> solta o handle e levanta; erro de frame -> fecha e levanta.
        NUNCA é repetido pelo chamador (o motor pode já ter processado)."""
        out: dict = {}

        def _do_read():
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

        rt = threading.Thread(target=_do_read, daemon=True)
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

    def _request(self, header: dict, audio: bytes = b"",
                 timeout: float = 120.0) -> "tuple[dict, bytes]":
        """Envia 1 frame e lê a resposta com TETO de tamanho e TIMEOUT.

        Serializado pelo lock (single-in-flight). Com ``auto_reconnect``: um handle
        morto é REABERTO de forma preguiçosa antes do envio, e uma falha de ESCRITA
        dispara reconectar + REPETIR o envio UMA vez (o frame não chegou ao motor —
        idempotente-seguro). Falha de LEITURA/TIMEOUT NUNCA é repetida (o motor pode
        ter processado) — só solta o handle e levanta; a próxima chamada reconecta."""
        with self._lock:
            # (1) handle morto -> reconecta preguiçoso (auto_reconnect) antes de enviar.
            if self._fh is None and self._auto_reconnect:
                self._try_reopen()
            fh = self._fh
            if fh is None:
                raise VoxEngineError("conexão com o motor caiu")

            # (2) envio; falha de ESCRITA => frame não chegou => reconecta + repete 1x.
            #     envio PARCIAL (_PartialSend) => bytes já chegaram => NÃO repete.
            try:
                self._send_frame(fh, header, audio)
            except _PartialSend as exc:
                self._close_fh()
                raise VoxEngineError(
                    f"envio parcial ao motor ({exc.sent} bytes) — não repetível") from exc
            except Exception as exc:  # noqa: BLE001
                self._close_fh()
                if not (self._auto_reconnect and self._try_reopen()):
                    raise VoxEngineError(f"falha ao enviar ao motor: {exc}") from exc
                fh = self._fh
                try:
                    self._send_frame(fh, header, audio)
                except _PartialSend as exc2:
                    self._close_fh()
                    raise VoxEngineError(
                        f"envio parcial ao motor ({exc2.sent} bytes) — não repetível") from exc2
                except Exception as exc2:  # noqa: BLE001
                    self._close_fh()
                    raise VoxEngineError(f"falha ao enviar ao motor: {exc2}") from exc2

            # (3) leitura; o envio JÁ foi bem-sucedido -> NÃO repete (evita double-process).
            return self._read_reply(fh, timeout)

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

    def devices(self, timeout: float = 5.0) -> dict:
        """Microfones vistos pelo daemon — a MESMA enumeração/seleção do ditado (UMA fonte).

        Devolve ``{"input": [{"index", "name", "is_default"}], "default_input": <nome|None>}``;
        ``input`` já vem DEDUPLICADO por nome (uma entrada por mic físico, na melhor host API).
        Passe o ``name`` escolhido em ``capture_open(input_device=<name>)`` — PORTÁVEL (o índice
        do PortAudio muda ao plugar/desplugar USB; o nome é estável). Reusar isto deixa o
        consumidor SEM ``sounddevice`` local (casca fina). Fail-safe: sem PortAudio → ``input=[]``
        (só o 'Automático'). Só ENTRADA — a saída do TTS é playback do consumidor (não do daemon)."""
        h, _ = self._request({"cmd": "devices", "req_id": self._next_rid()}, timeout=timeout)
        return {"input": h.get("input") or [], "default_input": h.get("default_input")}

    def update_check(self, timeout: float = 8.0) -> dict:
        """Pergunta ao motor se há release ASSINADA mais nova (endpoint READ-ONLY
        ``update_check``) — o consumidor decide quando chamar :meth:`update`. Nunca levanta;
        daemon legado sem o comando → ``update_available=None``. Retorna
        ``{'current','latest','update_available'}``."""
        try:
            h, _ = self._request({"cmd": "update_check", "req_id": self._next_rid()},
                                 timeout=timeout)
        except Exception:  # noqa: BLE001
            return {"current": None, "latest": None, "update_available": None}
        if h.get("event") != "update_check":         # daemon legado (bad_cmd) → desconhecido
            return {"current": h.get("version"), "latest": None, "update_available": None}
        return {"current": h.get("current"), "latest": h.get("latest"),
                "update_available": h.get("update_available")}

    def update(self, *, force: bool = False, with_translation: bool = True,
               boot_timeout_ms: "int | None" = None) -> dict:
        """Pede a ATUALIZAÇÃO do motor via o comando COORDENADO ``update`` (contrato seguro:
        só recicla OCIOSO DE VERDADE, ENFILEIRA se ocupado → ``deferred``, e responde
        ``in_progress`` a um update concorrente). Retorna ``{action, from, to, ...}`` NA HORA
        (a troca acontece em background). Daemon LEGADO sem o coordenador (``bad_cmd``) → cai
        para o update orquestrado pelo cliente (:func:`update_engine`, só com o guard de sessão).
        ``force`` atualiza mesmo com trabalho em voo."""
        try:
            h, _ = self._request({"cmd": "update", "force": bool(force),
                                  "req_id": self._next_rid()}, timeout=15.0)
        except Exception:  # noqa: BLE001
            h = None
        if isinstance(h, dict) and h.get("event") == "update":
            return {k: v for k, v in h.items() if k not in ("event", "req_id")}
        return update_engine(self.pipe_name, force=force, with_translation=with_translation,
                             boot_timeout_ms=boot_timeout_ms)

    def update_status(self, timeout: float = 8.0) -> dict:
        """Estado do update no motor (``state``/``current``/``latest``/``update_available``/
        ``pending``), via o endpoint READ-ONLY ``update_status``. Daemon legado → ``state``
        ``unknown`` + o que o ``update_check`` souber. Nunca levanta."""
        try:
            h, _ = self._request({"cmd": "update_status", "req_id": self._next_rid()},
                                 timeout=timeout)
        except Exception:  # noqa: BLE001
            return {"state": "unknown"}
        if h.get("event") != "update_status":
            return {"state": "unknown", **self.update_check(timeout=timeout)}
        return {k: v for k, v in h.items() if k not in ("event", "req_id")}

    def capabilities(self, timeout: float = 5.0) -> Capabilities:
        """Retrato TIPADO das capacidades desta máquina (uma chamada → cliente sabe tudo).

        Faz o handshake ``info`` e devolve um :class:`Capabilities`: perfis já resolvidos
        pro hardware (``transcription``→turbo, ``transcription_hq``→large-v3 na GPU), modelos
        residentes/permitidos, formatos de áudio servíveis + as listas estáticas conhecidas.
        É a forma nativa de descoberta — o cliente não hardcoda nem lê o código-fonte."""
        h = self.info(timeout=timeout)
        # Coerção defensiva de TIPO (não só falsy): um daemon degradado/hostil pode mandar
        # ``models`` como lista etc. — degradamos para vazio em vez de quebrar/devolver lixo.
        def _d(v):
            return v if isinstance(v, dict) else {}

        def _l(v):
            return v if isinstance(v, list) else []
        return Capabilities(
            version=h.get("version"),
            provider=h.get("provider"),
            hardware=h.get("hardware") if isinstance(h.get("hardware"), dict) else None,
            profiles=_d(h.get("profiles")),
            models_resident=sorted(_d(h.get("models")).keys()),
            models_allowed=_l(h.get("allowed_models")),
            audio_formats_available=_l(h.get("encode_formats")),
            voices=_l(h.get("tts_voices")),
            supported_voices=_l(h.get("supported_voices")),
            default_voice=h.get("default_voice"),
        )

    def transcribe(self, audio, lang: str = "", session: str = "default",
                   priority: str = "interactive", profile: "str | None" = None,
                   model: "str | None" = None, timeout: float = 120.0) -> str:
        """Transcreve ``audio`` (float32 16k mono: bytes, ndarray ou iterável) e
        devolve o texto. Levanta :class:`VoxEngineError` se o motor não retornar
        ``result``.

        ``profile`` ('dictation'|'translator') deixa o daemon escolher o modelo pelo
        hardware — ``translator`` usa large-v3 na GPU (turbo no CPU) para tradução de
        qualidade; ``dictation`` (default do daemon) usa turbo. ``model`` força um
        modelo específico (ex.: 'large-v3'), tendo precedência sobre o profile."""
        pcm = _to_pcm_bytes(audio)
        header: dict = {"cmd": "transcribe", "req_id": self._next_rid(),
                        "session": session, "lang": lang or "",
                        "priority": priority}
        if profile is not None:
            header["profile"] = profile
        if model is not None:
            header["model"] = model
        h, _ = self._request(header, pcm, timeout=timeout)
        if h.get("event") == "result":
            return (h.get("text") or "").strip()
        raise VoxEngineError(
            f"motor retornou {h.get('event')}/{h.get('code')}: {h.get('message') or ''}")

    def transcribe_file(self, audio, lang: str = "", session: str = "default",
                        priority: str = "interactive", profile: "str | None" = None,
                        model: "str | None" = None, timeout: float = 300.0) -> str:
        """Transcreve um áudio COMPLETO (gravação inteira) e devolve o texto TODO.

        Diferente de :meth:`transcribe` (que assume um trecho curto <30s, o caso do
        ditado streaming), esta trilha manda o áudio inteiro e o motor SEGMENTA no
        servidor (VAD nos vales de silêncio / janela fixa), transcrevendo tudo sem o teto
        de ~30s do Whisper. É o caso "gateway com o áudio pronto" (batch/arquivo).

        ``timeout`` é maior (batch). Sem ``model``/``profile``, usa o profile
        ``transcription`` = **turbo** (rápido, mesmo motor do ditado, zero VRAM nova).
        Qualidade máxima p/ áudio difícil/ruidoso: ``profile='transcription_hq'`` ou
        ``model='large-v3'`` (sobe lazy sob demanda).
        Levanta :class:`VoxEngineError` se o motor não retornar ``result``."""
        pcm = _to_pcm_bytes(audio)
        header: dict = {"cmd": "transcribe_file", "req_id": self._next_rid(),
                        "session": session, "lang": lang or "",
                        "priority": priority}
        if profile is not None:
            header["profile"] = profile
        if model is not None:
            header["model"] = model
        h, _ = self._request(header, pcm, timeout=timeout)
        if h.get("event") == "result":
            return (h.get("text") or "").strip()
        raise VoxEngineError(
            f"motor retornou {h.get('event')}/{h.get('code')}: {h.get('message') or ''}")

    def tts(self, text: str, fmt: str = "pcm", voice: "str | None" = None,
            speed: float = 1.0, session: str = "default",
            priority: str = "interactive", normalize: bool = False,
            timeout: float = 120.0):
        """Sintetiza ``text``.

        Com ``fmt="pcm"`` (default) devolve ``(header, samples)`` — ``samples`` é um
        ``numpy.ndarray`` float32 quando numpy existe, senão os ``bytes`` PCM crus
        (numpy é opcional no consumidor). Com um formato comprimido
        (``opus``/``mp3``/``wav``/``vorbis``) devolve ``(header, bytes)`` já
        codificados. O tipo do retorno depende SÓ do ``fmt`` deste request.

        ``normalize=True`` pede o peak-normalize na FONTE (pico->0.92 antes do
        PCM/encode) — nível consistente entre chamadas sem renormalizar no cliente;
        default OFF = PCM cru byte-idêntico. Fade NÃO é da fonte (é playback)."""
        req = {"cmd": "tts", "req_id": self._next_rid(), "session": session,
               "text": text, "voice": voice, "speed": speed, "priority": priority}
        if normalize:
            req["normalize"] = True
        if fmt and fmt != "pcm":
            req["format"] = fmt
        h, audio = self._request(req, timeout=timeout)
        if fmt and fmt != "pcm":
            return h, audio                      # bytes codificados, sem interpretar
        return _pcm_reply(h, audio)              # PCM→ndarray (numpy lazy) ou bytes crus

    def capture_open(self, session: str, on_event, *, lang: str = "",
                     model: "str | None" = None, profile: "str | None" = None,
                     input_device: "str | int | None" = None, min_rms: float = 0.0,
                     connect_timeout: float = 5.0, open_timeout: float = 8.0) -> "CaptureHandle":
        """Abre uma captura de sessão (mic → transcrição no daemon) e devolve um
        :class:`CaptureHandle`. ``on_event(frame)`` recebe CADA evento assíncrono —
        ``capture_segment`` {idx,text} / ``capture_level`` {rms,peak,silent} / ``capture_error``
        {code,message} — discrimine por ``frame['event']``. ``handle.close()`` (drena) /
        ``handle.cancel()`` (aborta) devolvem o ``capture_closed`` com o resultado.

        Levanta :class:`CaptureError` TIPADO se o mic estiver ocupado/indisponível ou o ack não
        vier (``busy``/``mic_busy``/``mic_open_failed``/``capture_unavailable``/``capture_timeout``…).
        Fase 0 = single-owner: uma 2ª captura concorrente responde ``busy``.

        Usa uma conexão de pipe DEDICADA (a captura é stream, não request/resposta) — NÃO
        compartilha o handle serializado deste cliente, então TTS/transcribe seguem em paralelo."""
        if not session:
            raise ValueError("capture_open requer session")
        header: dict = {"cmd": "capture_open", "req_id": _cap_rid(), "session": session}
        if lang:
            header["lang"] = lang
        if model:
            header["model"] = model
        if profile:
            header["profile"] = profile
        if input_device is not None:
            header["input_device"] = input_device
        if min_rms:
            header["min_rms"] = float(min_rms)
        fh = self._open_capture_pipe(connect_timeout)
        return CaptureHandle(fh, session, on_event, open_header=header, open_timeout=open_timeout)

    def _open_capture_pipe(self, connect_timeout: float):
        """Conexão de pipe NOVA e OVERLAPPED (ctypes) para a captura (stream): a thread-leitora
        pode ficar bloqueada num ``ReadFile`` enquanto o consumidor escreve o ``close`` no MESMO
        handle — o que um handle SÍNCRONO serializaria (deadlock). O handle síncrono
        (``open(pipe,"r+b")``) só é seguro no ``VoxClient`` serial de request/resposta."""
        return _OverlappedPipe(self.pipe_name, connect_timeout)

    def encode_formats(self, timeout: float = 5.0) -> "list[str]":
        """Formatos de saída de TTS servíveis pelo daemon (capability discovery)."""
        return list(self.info(timeout=timeout).get("encode_formats") or ["pcm"])

    def translate(self, audio, from_lang: "str | None" = None, to_lang: str = "pt",
                  session: str = "default", whisper_model: "str | None" = None,
                  priority: str = "interactive", speak: bool = False,
                  dub_voice: "str | None" = None, dub_sid: int = 0, dub_fmt: str = "pcm",
                  timeout: float = 120.0):
        """Traduz ``audio`` (float32 16k mono) -> texto no idioma ``to_lang`` e, com
        ``speak=True``, também a VOZ dublada no idioma-alvo (Fase B).

        Retorno (depende SÓ de ``speak``/``dub_fmt`` deste request):

        - ``speak=False`` -> ``dict`` (header do resultado: ``text``/``source_text``/
          ``src_lang``/``tgt_lang``/…) — compat total com a Fase A.
        - ``speak=True, dub_fmt="pcm"`` -> ``(header, samples)``: ``samples`` é um
          ``numpy.ndarray`` float32 quando numpy existe (senão os ``bytes`` PCM crus);
          ``ndarray`` vazio se o daemon marcou ``dub_skipped``.
        - ``speak=True, dub_fmt!="pcm"`` -> ``(header, bytes)`` já codificados.

        A voz de dublagem é escolhida pelo idioma-ALVO no daemon (NÃO é a voz do
        ``cmd tts``); ``dub_voice`` só força uma alternativa compatível com o alvo."""
        pcm = _to_pcm_bytes(audio)
        header: dict = {"cmd": "translate", "req_id": self._next_rid(),
                        "session": session, "to_lang": to_lang, "priority": priority}
        if from_lang is not None:                 # presente (mesmo "") = explícito
            header["from_lang"] = from_lang
        if whisper_model is not None:
            header["whisper_model"] = whisper_model
        if speak:
            header["speak"] = True
            if dub_voice:
                header["dub_voice"] = dub_voice
            if dub_sid:
                header["dub_sid"] = dub_sid
            if dub_fmt and dub_fmt != "pcm":
                header["dub_fmt"] = dub_fmt
        h, audio_out = self._request(header, pcm, timeout=timeout)
        if not speak:
            return h                              # compat: só o header (dict)
        if dub_fmt and dub_fmt != "pcm":
            return h, audio_out                   # bytes codificados, sem interpretar
        return _pcm_reply(h, audio_out)           # PCM→ndarray (numpy lazy) ou bytes crus

    def translate_text(self, text: str, from_lang: str, to_lang: str = "pt", *,
                       session: str = "default", priority: str = "interactive",
                       speak: bool = False, dub_voice: "str | None" = None,
                       dub_sid: int = 0, dub_fmt: str = "pcm", timeout: float = 120.0):
        """Traduz TEXTO -> texto no idioma ``to_lang`` (pula o STT: o chamador JÁ
        transcreveu a fala) e, com ``speak=True``, também a VOZ dublada (Fase B).

        ``from_lang`` é OBRIGATÓRIO — o Argos NÃO auto-detecta idioma de TEXTO. Retorno
        idêntico ao :meth:`translate` (depende SÓ de ``speak``/``dub_fmt``):

        - ``speak=False`` -> ``dict`` (só o header do resultado);
        - ``speak=True, dub_fmt="pcm"`` -> ``(header, samples)`` (``numpy.ndarray``
          float32 quando numpy existe, senão ``bytes`` PCM crus; vazio se ``dub_skipped``);
        - ``speak=True, dub_fmt!="pcm"`` -> ``(header, bytes)`` já codificados."""
        header: dict = {"cmd": "translate_text", "req_id": self._next_rid(),
                        "session": session, "text": text, "from_lang": from_lang,
                        "to_lang": to_lang, "priority": priority}
        if speak:
            header["speak"] = True
            if dub_voice:
                header["dub_voice"] = dub_voice
            if dub_sid:
                header["dub_sid"] = dub_sid
            if dub_fmt and dub_fmt != "pcm":
                header["dub_fmt"] = dub_fmt
        h, audio_out = self._request(header, timeout=timeout)   # sem payload de áudio
        if not speak:
            return h                              # compat: só o header (dict)
        if dub_fmt and dub_fmt != "pcm":
            return h, audio_out                   # bytes codificados, sem interpretar
        return _pcm_reply(h, audio_out)           # PCM→ndarray (numpy lazy) ou bytes crus

    def prepare_translation(self, from_lang: str, to_lang: str,
                            whisper_model: "str | None" = None, speak: bool = False,
                            dub_voice: "str | None" = None, dub_sid: int = 0,
                            timeout: float = 600.0) -> dict:
        """Baixa/instala o modelo faster-whisper + par(es) Argos ANTES de traduzir (o
        caminho de inferência nunca baixa). Com ``speak=True`` também faz o warm-up da
        voz de dublagem do idioma-alvo, FORA do worker — a resposta ``ready`` ganha
        ``dub_voice/dub_sample_rate/dub_provider/dub_ready``. Bloqueia até ``ready``
        (ou erro); ``timeout`` folgado (pode baixar centenas de MB na 1ª vez)."""
        header: dict = {"cmd": "prepare_translation", "req_id": self._next_rid(),
                        "from_lang": from_lang, "to_lang": to_lang}
        if whisper_model is not None:
            header["whisper_model"] = whisper_model
        if speak:
            header["speak"] = True
            if dub_voice:
                header["dub_voice"] = dub_voice
            if dub_sid:
                header["dub_sid"] = dub_sid
        h, _ = self._request(header, timeout=timeout)
        return h

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


def _zip_assert_safe(z: "zipfile.ZipFile", dest: str) -> None:
    """GUARD de Zip Slip (defense-in-depth, CWE-22) para a extração do instalador — self
    contido no SDK (vendorável, stdlib-pura). Levanta ``ValueError`` ANTES de escrever se
    QUALQUER membro tentar escapar ``dest``: componente ``..``/caminho absoluto, alvo
    resolvido fora do destino, ou SYMLINK (o ``zipfile`` do Python não protege symlink;
    detectado nos 16 bits altos do ``external_attr`` = modo Unix, máscara S_IFLNK 0o120000).
    O blob já é verificado por Ed25519 antes daqui — isto é cinto-e-suspensório."""
    dest_abs = os.path.realpath(dest)
    prefix = dest_abs + os.sep
    for info in z.infolist():
        name = info.filename
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError(f"symlink recusado no zip: {name!r}")
        if os.path.isabs(name) or name.startswith(("/", "\\")):
            raise ValueError(f"caminho absoluto recusado no zip: {name!r}")
        target = os.path.realpath(os.path.join(dest_abs, name))
        if target != dest_abs and not target.startswith(prefix):
            raise ValueError(f"caminho fora do destino recusado no zip: {name!r}")


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
                _zip_assert_safe(z, tmp)   # GUARD Zip Slip (fail-loud) antes de escrever
                z.extractall(tmp)
        except Exception:  # noqa: BLE001 — zip corrompido / download parcial / traversal
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
                     connect=None, lock_dir: "str | None" = None,
                     with_translation: bool = True) -> dict:
    """Decide e executa a atualização. Devolve
    ``{'action','installed','latest'}`` com ``action`` ∈
    ``up_to_date|installed|updated|offline_installed|unavailable|failed``.

    Regras (fail-closed): sem release e sem instalado ⇒ ``unavailable``; sem
    release mas instalado ⇒ ``offline_installed`` (usa o existente); atual ⇒
    ``up_to_date`` (NÃO baixa); ausente/velho ⇒ baixa+verifica+instala; verify/
    download falho ⇒ NÃO roda install.ps1 (usa o existente se houver, senão
    ``failed``); pós-install não importável ⇒ ``failed`` (não sobe lixo).

    ``with_translation`` (padrão True): quando o install.ps1 REALMENTE roda, passa
    ``-WithTranslation`` — o consumidor já ganha o extra de tradução (faster-whisper
    + Argos) por padrão. Libs seguem LAZY em runtime; só a POLÍTICA de instalação
    muda. Passe False para o motor base apenas.

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
                                    python_exe=python_exe, lock_dir=lock_dir,
                                    extra_args=(["-WithTranslation"] if with_translation else None))
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
        # DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB: o motor é um SINGLETON de
        # LONGA VIDA — precisa ROMPER o Job Object do consumidor que o lança (worker/sessão do app),
        # senão o Windows o MATA junto quando esse consumidor EFÊMERO cai (sem shutdown gracioso).
        # Era o loop start↔kill que derrubava a voz no multi-sessão. Se o Job PROÍBE breakaway
        # (ERROR_ACCESS_DENIED — sem JOB_OBJECT_LIMIT_BREAKAWAY_OK), CAI para só destacado.
        base = 0x00000008 | 0x08000000
        breakaway = 0x01000000
        bf = open(DAEMON_BOOT_LOG, "ab")   # noqa: SIM115
        try:
            args = [pyw, "-m", "vox_engine", "--pipe", pipe, "--log-file", DAEMON_LOG]
            common = dict(close_fds=True, stdin=subprocess.DEVNULL, stdout=bf, stderr=bf)
            try:
                subprocess.Popen(args, creationflags=base | breakaway, **common)
            except OSError:
                subprocess.Popen(args, creationflags=base, **common)  # job proíbe breakaway
        finally:
            bf.close()
        return True
    except Exception:  # noqa: BLE001 — lançamento falhou
        return False


def _wait_for_pipe(pipe: str, boot_timeout: float, *,
                   auto_reconnect: bool = False,
                   reconnect_timeout: float = 0.25) -> "VoxClient | None":
    """Espera o pipe subir (poll) até ``boot_timeout`` e devolve o cliente, ou
    ``None`` se não apareceu (provável crash de import no daemon)."""
    deadline = time.time() + max(0.0, boot_timeout)
    while time.time() < deadline:
        c = VoxClient.try_connect(pipe, connect_timeout=1.0, auto_reconnect=auto_reconnect,
                                  reconnect_timeout=reconnect_timeout)
        if c is not None:
            return c
        time.sleep(0.5)
    return None


# ---------------------------------------------------------------------------
# stop_daemon — reciclagem: derruba um daemon rodando para o update valer (e o
# hook do daemon subir o ditado com a versão nova). Paridade com o SDK Node.
# ---------------------------------------------------------------------------
def _pidfile_path(pipe: str) -> str:
    """Pidfile que o daemon escreve no boot (chaveado pelo pipe; espelha
    ``__main__._pidfile_path``). sha1(pipe)[:12] — derivação idêntica no daemon."""
    import hashlib
    digest = hashlib.sha1(pipe.encode("utf-8")).hexdigest()[:12]
    return os.path.join(INSTALL_ROOT, "run", f"daemon-{digest}.pid")


def _read_pidfile(pipe: str) -> "int | None":
    try:
        with open(_pidfile_path(pipe), encoding="utf-8") as f:
            pid = int(f.read().strip())
        return pid if pid > 0 else None
    except Exception:  # noqa: BLE001
        return None


def _daemon_match_regex(pipe: str) -> str:
    """Regex p/ casar o argumento ``--pipe <pipe>`` como TOKEN ancorado (seguido de
    espaço/fim), para que ``\\.\\pipe\\vox`` nunca case um ``\\.\\pipe\\vox2`` vizinho."""
    import re as _re
    return r"--pipe\s+" + _re.escape(pipe) + r"(\s|$)"


def _find_daemon_pid(pipe: str) -> "int | None":
    """Último recurso p/ daemon LEGADO (sem pidfile, sem pid no info): acha o processo
    rodando ``-m vox_engine --pipe <pipe>`` (token ANCORADO) e devolve o PID. Windows-only."""
    try:
        esc = pipe.replace("'", "''")
        ps = ("$re = '--pipe\\s+' + [regex]::Escape('" + esc + "') + '(\\s|$)'; "
              "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR "
              "Name='python.exe'\" | Where-Object { $_.CommandLine -like '*vox_engine*' "
              "-and $_.CommandLine -match $re } | "
              "Select-Object -First 1 -ExpandProperty ProcessId")
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, timeout=15)
        pid = int((r.stdout or "").strip())
        return pid if pid > 0 else None
    except Exception:  # noqa: BLE001
        return None


def _daemon_pid_matches(pid: int, pipe: str) -> bool:
    """True sse ``pid`` É um daemon vox_engine NESTE pipe exato — p/ nunca matar um PID
    reciclado por um processo alheio (pidfile obsoleto)."""
    try:
        esc = pipe.replace("'", "''")
        ps = ("$re = '--pipe\\s+' + [regex]::Escape('" + esc + "') + '(\\s|$)'; "
              f"$p = Get-CimInstance Win32_Process -Filter \"ProcessId={int(pid)}\"; "
              "if ($p -and $p.CommandLine -like '*vox_engine*' -and "
              "$p.CommandLine -match $re) { 'yes' }")
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, timeout=15)
        return (r.stdout or "").strip() == "yes"
    except Exception:  # noqa: BLE001
        return False


def _kill_pid(pid: int) -> None:
    """Mata o processo ``pid`` e a árvore (taskkill /T /F). Best-effort, nunca levanta."""
    try:
        subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
    except Exception:  # noqa: BLE001
        pass


def _daemon_up(pipe: str) -> bool:
    c = VoxClient.try_connect(pipe, connect_timeout=0.4)
    if c is None:
        return False
    try:
        c.close()
    except Exception:  # noqa: BLE001
        pass
    return True


def _wait_pipe_down(pipe: str, timeout: float, *, is_up, monotonic, sleep) -> bool:
    deadline = monotonic() + timeout
    while True:
        try:
            up = is_up(pipe)
        except Exception:  # noqa: BLE001 — erro na sonda ⇒ assume ainda no ar
            up = True
        if not up:
            return True
        if monotonic() >= deadline:
            return False
        sleep(0.5)


def stop_daemon(pipe: str = DEFAULT_PIPE, *, pid: "int | None" = None,
                connect=None, kill=None, is_up=None, read_pidfile=None,
                find_pid=None, pid_matches=None, monotonic=None, sleep=None,
                graceful_timeout: float = 8.0, kill_timeout: float = 6.0,
                force: bool = False) -> bool:
    """Para o daemon do ``pipe`` para reciclar (o update valer + o ditado subir com a
    versão nova). 1) shutdown GRACIOSO pelo pipe (daemon 0.9.0+); se o daemon responde
    BUSY (sessão abriu na corrida) e ``force`` é False, ABORTA — nunca mata. Com ``force``
    manda ``force=True`` (o daemon derruba MESMO ocupado — uso iniciado pelo usuário). 2) espera
    o pipe cair; 3) fallback KILL por pid: explícito/info (confiável) → pidfile (VERIFICADO) →
    scan (ancorado+verificado); nunca mata um PID não verificado. 4) espera de novo. True sse o
    pipe caiu. Nunca levanta."""
    connect = connect or (lambda pp: VoxClient.try_connect(pp, connect_timeout=1.0))
    kill = kill or _kill_pid
    is_up = is_up or _daemon_up
    read_pidfile = read_pidfile or _read_pidfile
    find_pid = find_pid or _find_daemon_pid
    pid_matches = pid_matches or _daemon_pid_matches
    monotonic = monotonic or time.monotonic
    sleep = sleep or time.sleep

    learned_pid = pid   # pid explícito é confiável (responsabilidade do chamador)
    refused_busy = False
    # 1) shutdown gracioso pelo pipe (+ aprende o pid p/ o fallback).
    try:
        c = connect(pipe)
        if c is not None:
            try:
                if learned_pid is None:
                    try:
                        learned_pid = (c.info() or {}).get("pid")
                    except Exception:  # noqa: BLE001
                        learned_pid = None
                try:
                    resp, _ = c._request({"cmd": "shutdown", "force": bool(force),
                                          "req_id": c._next_rid()}, timeout=2.0)
                    if isinstance(resp, dict) and resp.get("event") == "busy":
                        refused_busy = True
                except Exception:  # noqa: BLE001 — daemon legado: bad_cmd / socket caiu
                    pass
            finally:
                try:
                    c.close()
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        pass

    # Daemon respondeu BUSY (sessão abriu na corrida) → NÃO mata; o chamador segue servindo.
    if refused_busy:
        return False

    # 2) espera a saída graciosa.
    if _wait_pipe_down(pipe, graceful_timeout, is_up=is_up, monotonic=monotonic, sleep=sleep):
        return True

    # 3) fallback: mata o processo EXATO (legado ou travado). Verifica pids não confiáveis.
    kill_pid = learned_pid                         # confiável: explícito ou info.pid
    if kill_pid is None:
        from_file = read_pidfile(pipe)             # pidfile: VERIFICA (pode estar obsoleto)
        if from_file is not None and pid_matches(from_file, pipe):
            kill_pid = from_file
    if kill_pid is None:
        kill_pid = find_pid(pipe)                  # scan: ancorado + auto-verificado
    if kill_pid is not None:
        try:
            kill(kill_pid)
        except Exception:  # noqa: BLE001
            pass
        if _wait_pipe_down(pipe, kill_timeout, is_up=is_up, monotonic=monotonic, sleep=sleep):
            return True
    # 4) veredito final.
    try:
        return not is_up(pipe)
    except Exception:  # noqa: BLE001
        return False


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
                        auto_update: bool = True, recycle_stale: bool = True,
                        auto_reconnect: bool = False,
                        reconnect_timeout: float = 0.25,
                        connect_timeout_ms: "int | None" = None,
                        boot_timeout_ms: "int | None" = None,
                        python_exe: "str | None" = None,
                        with_translation: bool = True,
                        http_get=None, run=None, stop=None) -> dict:
    """Install → update → use, com relatório. Devolve um dict com as MESMAS chaves
    do SDK Node: ``{client, installedVersion, latestVersion, updateAvailable, action}``.

    ``action`` ∈ ``reused | installed | updated | up_to_date | offline_installed |
    failed | unavailable``.

    ``auto_reconnect`` (opt-in): o :class:`VoxClient` devolvido se auto-cura — reabre o
    handle quando o motor cai/recicla e repete o request só na falha de escrita (nunca
    em leitura/timeout). O consumidor não reimplementa reconexão.

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
    stop = stop or stop_daemon
    connect_timeout = (connect_timeout_ms if connect_timeout_ms is not None
                       else CONNECT_TIMEOUT_MS) / 1000.0
    boot_timeout = (boot_timeout_ms if boot_timeout_ms is not None
                    else BOOT_TIMEOUT_MS) / 1000.0
    result = {"client": None, "installedVersion": None, "latestVersion": None,
              "updateAvailable": False, "action": "unavailable"}

    # ---- (1) daemon já no ar: reusar OU reciclar (se velho e ocioso) ----
    client = VoxClient.try_connect(pipe, connect_timeout, auto_reconnect=auto_reconnect,
                                   reconnect_timeout=reconnect_timeout)
    if client is not None:
        running_ver = running_sessions = running_pid = None
        try:
            info = client.info() or {}
            running_ver = info.get("version")
            running_sessions = info.get("sessions")
            running_pid = info.get("pid")
        except Exception:  # noqa: BLE001
            pass
        latest = latest_release(http_get=http_get) if auto_update else None
        latest_ver = latest["version"] if latest else None
        stale = bool(latest and running_ver and is_newer(latest_ver, running_ver))

        # RECICLA um daemon VELHO para o update valer e o hook do daemon subir o ditado
        # com a versão nova — só quando é SEGURO: dá p/ subir (autostart), está OCIOSO
        # (sessions == 0) e o venv arranca (installed != None). ``installed_version`` gera
        # um subprocesso, então é avaliado POR ÚLTIMO (só quando o resto já qualifica) —
        # mantém o caminho comum "atual → reusa" sem spawn desnecessário.
        idle = running_sessions == 0
        if (stale and recycle_stale and autostart and idle
                and installed_version(python_exe, run=run) is not None):
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                stopped = stop(pipe, pid=running_pid)
            except Exception:  # noqa: BLE001 — stop é best-effort; nunca quebra o ensure
                stopped = False
            if stopped:
                client = None   # cai no (2)/(3): instala a última + sobe o daemon novo
            else:
                re = VoxClient.try_connect(pipe, connect_timeout,
                                           auto_reconnect=auto_reconnect,
                                           reconnect_timeout=reconnect_timeout)
                return {"client": re, "installedVersion": running_ver,
                        "latestVersion": latest_ver, "updateAvailable": True,
                        "action": "reused"}
        else:
            return {"client": client, "installedVersion": running_ver,
                    "latestVersion": latest_ver, "updateAvailable": stale,
                    "action": "reused"}

    if not autostart:
        result["action"] = "unavailable"
        return result

    # ---- (2) re-checar + decidir + instalar ----
    # FIX 4: NÃO há lock externo aqui — o mesmo processo não pode dar mkdir no mesmo
    # dir duas vezes (deadlock). O lock cross-process vive DENTRO de
    # download_and_run_installer, que também re-checa versão-alvo sob o lock.
    # RE-CHECAR: outro cliente pode ter subido o daemon enquanto conectávamos.
    # RE-CHECAR: outro cliente pode ter subido o daemon enquanto conectávamos. Propaga
    # auto_reconnect/cushion — senão o cliente 'reused' desta corrida perde o self-healing.
    client = VoxClient.try_connect(pipe, min(connect_timeout, 2.0),
                                   auto_reconnect=auto_reconnect,
                                   reconnect_timeout=reconnect_timeout)
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
                                        python_exe=python_exe,
                                        extra_args=(["-WithTranslation"] if with_translation else None))
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
    client = _wait_for_pipe(pipe, boot_timeout, auto_reconnect=auto_reconnect,
                            reconnect_timeout=reconnect_timeout)
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


# ---------------------------------------------------------------------------
# update_engine — ENDPOINT EXPLÍCITO de atualização a mando do consumidor.
# ---------------------------------------------------------------------------
def update_engine(pipe: "str | None" = None, *, force: bool = False,
                  with_translation: bool = True, boot_timeout_ms: "int | None" = None,
                  http_get=None, python_exe: "str | None" = None, stop=None, run=None) -> dict:
    """Atualiza o motor para a ÚLTIMA release ASSINADA AGORA, a mando do consumidor
    (voice-chat/Action chamam ``client.update()``). É o mesmo recycle da auto-cura, porém
    DISPARADO sob demanda: reusa ``stop_daemon`` (gracioso) + ``check_and_update`` (baixa+VERIFICA
    fail-closed + ``install.ps1 -NoStart`` sob lock cross-process) + ``start_installed_daemon``
    (o ditado sobe com a versão nova).

    ``force=True`` recicla MESMO com sessão aberta (uso iniciado pelo usuário: aceita o breve
    reinício); sem ``force``, RECUSA quando o motor está ocupado (``busy``).

    Retorna ``{'action': <estado>, 'from': <ver|None>, 'to': <ver|None>[, 'sessions']}`` onde
    ``action`` ∈ ``up_to_date`` | ``updated`` | ``busy`` | ``no_release`` | ``failed``.
    Nunca levanta (best-effort — sempre tenta deixar um motor no ar no fim)."""
    pipe = pipe or DEFAULT_PIPE
    stop = stop or stop_daemon
    boot_timeout = (boot_timeout_ms if boot_timeout_ms is not None else BOOT_TIMEOUT_MS) / 1000.0

    latest = latest_release(http_get=http_get)
    to = latest["version"] if latest else None

    c = VoxClient.try_connect(pipe, CONNECT_TIMEOUT_MS / 1000.0)
    running_ver = running_sessions = running_pid = None
    if c is not None:
        try:
            info = c.info() or {}
            running_ver = info.get("version")
            running_sessions = info.get("sessions")
            running_pid = info.get("pid")
        except Exception:  # noqa: BLE001
            pass
    cur = running_ver or installed_version(python_exe, run=run)

    if to is None:                                   # sem release (offline)
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        return {"action": "no_release", "from": cur, "to": None}

    if cur and not is_newer(to, cur):                # já na última
        if c is None:
            start_installed_daemon(pipe, run=run)
        else:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        return {"action": "up_to_date", "from": cur, "to": to}

    if c is not None:                                # motor no ar e velho → reciclar
        if running_sessions not in (0, None) and not force:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
            return {"action": "busy", "from": cur, "to": to, "sessions": running_sessions}
        try:
            c.close()
        except Exception:  # noqa: BLE001
            pass
        if not stop(pipe, pid=running_pid, force=force):
            return {"action": "busy", "from": cur, "to": to}

    res = check_and_update(python_exe, http_get=http_get, run=run, latest=latest,
                           pipe=pipe, with_translation=with_translation)
    if res.get("action") in ("failed", "unavailable"):
        start_installed_daemon(pipe, run=run)        # não deixa o consumidor sem motor
        return {"action": "failed", "from": cur, "to": to}
    if not start_installed_daemon(pipe, run=run):
        return {"action": "failed", "from": cur, "to": to}
    nc = _wait_for_pipe(pipe, boot_timeout)
    if nc is not None:
        try:
            nc.close()
        except Exception:  # noqa: BLE001
            pass
        return {"action": "updated", "from": cur, "to": to}
    return {"action": "failed", "from": cur, "to": to, "reason": "boot_timeout"}
