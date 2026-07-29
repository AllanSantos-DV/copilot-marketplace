"""vox_cli — ciclo de vida do motor DELEGADO ao próprio motor.

Por que este arquivo substituiu 1415 linhas vendorizadas
-------------------------------------------------------
O plugin carregava ``vox_lifecycle.py`` (1049), ``vox_splash.py`` (190) e ``_ed25519_ref.py``
(176) — resolução de release, download, verificação Ed25519, lock entre processos, reciclagem
de daemon velho, splash e máquina de estados — só para conseguir **subir o motor**. Tudo isso
já existe DENTRO do motor (``vox_engine.bootstrap`` + ``vox_engine.core.updater``); os flats
eram um porte disso para o consumidor.

Agora o motor expõe ``vox ensure`` e ``vox update``, e o plugin só pede. Quem instala, atualiza,
recicla e verifica assinatura é o motor — que é quem sabe. O plugin fica com o CONECTOR
(``vox_sdk.py``, o cliente do pipe) e mais nada.

Ovo-e-galinha do PRIMEIRO install: se o ``vox`` ainda não existe, quem busca o instalador
verificado é o lado Node do plugin (``voice-engine-bootstrap.mjs``), usando o ``engine-kit`` do
engine-registry — que confere SHA-256 e assinatura Ed25519 antes de entregar o arquivo. Daí em
diante, o motor cuida de si.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

#: MAJOR do envelope JSON do CLI que este conector entende.
SUPPORTED_SCHEMA_MAJOR = 1

#: Onde o motor instala o CLI. O instalador cria um venv em ``%LOCALAPPDATA%\vox-engine\venv``
#: e os console-scripts ficam em ``venv\Scripts`` — o mesmo layout que ``bootstrap.daemon_paths``
#: e o SDK usam. Sem o segmento ``venv`` o executável existe e mesmo assim não é achado.
#: Essa é a razão de não bastar procurar no PATH: o venv do motor não é ativado por ninguém.
def _install_root() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "vox-engine")


def _candidate_dirs() -> "tuple[str, ...]":
    root = _install_root()
    return (
        os.path.join(root, "venv", "Scripts"),   # Windows
        os.path.join(root, "venv", "bin"),       # POSIX
    )


def _from_pointer() -> "str | None":
    """O motor PUBLICA onde instalou o CLI (``<raiz>/cli.json``), a partir do executável do
    próprio venv — sem adivinhar. Consultar isso é o que impede o palpite de layout de voltar a
    quebrar quando a instalação mudar de forma."""
    try:
        with open(os.path.join(_install_root(), "cli.json"), encoding="utf-8") as f:
            p = json.load(f).get("vox")
        return p if p and os.path.isfile(p) else None
    except Exception:  # noqa: BLE001 — ausente antes do 1º boot: cai para o palpite
        return None


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
#: Grupo de processo próprio: impede que um Ctrl-C do consumidor derrube o motor no meio.
_NEW_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


class VoxCliError(RuntimeError):
    """Falha ao pedir algo ao motor pelo CLI. Fail-loud, nunca degradação muda."""


def find_vox() -> "str | None":
    """Caminho do executável ``vox``, ou ``None`` se o motor ainda não está instalado.

    Devolve ``None`` em vez de levantar: "motor ausente" é um ESTADO esperado no primeiro uso,
    tratado pelo bootstrap, não uma exceção.
    """
    override = os.environ.get("VOX_CLI")
    if override:
        return override if os.path.isfile(override) else None
    declarado = _from_pointer()
    if declarado:
        return declarado
    for d in _candidate_dirs():
        for name in ("vox.exe", "vox"):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    # PATH por último: só vale se alguém instalou o motor globalmente. Procurar aqui primeiro
    # arriscaria pegar um `vox` de outro projeto em vez do motor que o consumidor depende.
    return shutil.which("vox")


def _run(args: "list[str]", timeout_s: float) -> dict:
    exe = find_vox()
    if not exe:
        raise VoxCliError("motor de voz não instalado (executável 'vox' não encontrado)")

    # Arquivos temporários em vez de pipes — a diferença entre funcionar e travar.
    #
    # Com `capture_output=True`, o `communicate()` só retorna quando o pipe FECHA, e o pipe só
    # fecha quando o último detentor do handle morre. O `vox ensure` sobe o daemon, que é
    # permanente e HERDA esses handles: o comando termina em segundos e a leitura fica presa
    # até o timeout. O sintoma era "o motor não respondeu em 120s" — mas o motor respondia; era
    # este lado que não conseguia ver o fim da saída. Um arquivo não tem esse acoplamento: ele
    # está completo quando o processo sai, independentemente de quem mais herdou o descritor.
    with tempfile.TemporaryDirectory(prefix="voxcli-") as tmp:
        f_out = os.path.join(tmp, "out")
        f_err = os.path.join(tmp, "err")
        try:
            with open(f_out, "wb") as fo, open(f_err, "wb") as fe:
                proc = subprocess.run(
                    [exe, *args], stdout=fo, stderr=fe,
                    stdin=subprocess.DEVNULL, timeout=timeout_s,
                    creationflags=_NO_WINDOW | _NEW_GROUP,
                )
        except subprocess.TimeoutExpired as exc:
            raise VoxCliError(f"o motor não respondeu em {timeout_s:.0f}s") from exc
        except OSError as exc:
            raise VoxCliError(f"não consegui executar {exe}: {exc}") from exc

        with open(f_out, "rb") as fo:
            saida = fo.read()
        with open(f_err, "rb") as fe:
            erro = fe.read()

    stderr = erro.decode("utf-8", "replace").strip()
    raw = saida.decode("utf-8", "replace").strip()
    if not raw:
        raise VoxCliError(f"o motor não devolveu saída (exit {proc.returncode}). {stderr}".strip())
    try:
        env = json.loads(raw.splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise VoxCliError(f"saída do motor não é JSON: {raw[:200]}") from exc

    version = str(env.get("schema_version", ""))
    major = version.split(".", 1)[0]
    if not major.isdigit() or int(major) != SUPPORTED_SCHEMA_MAJOR:
        raise VoxCliError(
            f"schema do motor incompatível: {version or '(ausente)'} — "
            f"este plugin fala a versão {SUPPORTED_SCHEMA_MAJOR}.x"
        )
    if env.get("status") != "ok":
        err = env.get("error") or {}
        raise VoxCliError(f"{err.get('code', 'erro')}: {err.get('message', 'falha sem detalhe')}")
    return env.get("data") or {}


def ensure(pipe: "str | None" = None, *, boot_timeout_s: float = 150.0,
           auto_update: bool = True, recycle: bool = True) -> dict:
    """Pede ao motor que se deixe PRONTO: instala/atualiza/recicla/sobe.

    Devolve ``{action, installed_version, previous_version, running_version, pipe}``.
    ``action`` ∈ ``installed`` | ``updated`` | ``ready``.
    """
    args = ["ensure", "--boot-timeout", str(boot_timeout_s)]
    if pipe:
        args = ["--pipe", pipe, *args]
    if not auto_update:
        args.append("--no-update")
    if not recycle:
        args.append("--no-recycle")
    # Margem sobre o orçamento do motor: ele precisa poder devolver o erro DELE, com razão,
    # em vez de ser morto por este lado e virar um "timeout" genérico sem causa.
    return _run(args, boot_timeout_s + 60.0)


def update(pipe: "str | None" = None, *, force: bool = False, timeout_s: float = 300.0) -> dict:
    """Atualiza o motor AGORA (recycle explícito, a mando do usuário)."""
    args = ["update"]
    if pipe:
        args = ["--pipe", pipe, *args]
    if force:
        args.append("--force")
    return _run(args, timeout_s)
