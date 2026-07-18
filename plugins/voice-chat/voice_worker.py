#!/usr/bin/env python
"""Persistent voice worker for the Copilot voice-chat extension.

Responsibilities:
  - Capture microphone audio on demand (sounddevice, server-side).
  - Bridge STT + TTS to the single shared engine (vox-engine) over a named pipe:
    there is NO local recognizer and no fallback (the engine picks the model by
    hardware; the extension never runs Whisper/TTS locally).
  - Gate wake-word / command capture with the sherpa-onnx Silero VAD (the only
    local model; bootstrap-downloaded from a GitHub release via truststore).

Protocol: newline-delimited JSON.
  stdin  (Node -> worker): {"cmd": "start"|"stop"|"cancel"|"ping"|"set", ...}
  stdout (worker -> Node): {"event": "ready"|"loading"|"level"|"recording"|
                            "transcript"|"error"|"pong", ...}
  stderr: human-readable logs only (never parsed).
"""
import sys
import os
import json
import time
import struct
import subprocess
import tarfile
import threading
import traceback
import wave
import re
import queue
import shutil
import tempfile
import zipfile
import urllib.request
import math
import unicodedata
from collections import deque
import vox_sdk

try:
    import truststore
    truststore.inject_into_ssl()
except Exception as exc:  
    print(f"[worker] truststore unavailable: {exc}", file=sys.stderr, flush=True)


def _run_pip_install(pkgs, label, timeout=1200):
    """pip install with a HARD timeout, streaming the child's output to stderr (the
    log) and a ~2s UI heartbeat with elapsed seconds. A slow/stuck install is thus
    always VISIBLE in the log and the panel — never an infinite silent spinner —
    and is killed at the deadline so the worker exits loudly and the supervisor can
    retry, instead of hanging forever. Raises on non-zero exit or timeout."""
    import subprocess
    import threading
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *pkgs]
    print(f"[worker] pip install ({label}): {' '.join(pkgs)} [timeout={timeout}s]",
          file=sys.stderr, flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)

    def _pump():
        try:
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    print(f"[pip] {line}", file=sys.stderr, flush=True)
        except Exception:
            pass

    threading.Thread(target=_pump, daemon=True).start()
    start = time.time()
    while True:
        try:
            proc.wait(timeout=2)
            break
        except subprocess.TimeoutExpired:
            elapsed = int(time.time() - start)
            sys.stdout.write(json.dumps({"event": "loading", "stage": "deps",
                "msg": f"Instalando {label}… {elapsed}s (pacotes nativos; 1ª vez pode demorar)"}) + "\n")
            sys.stdout.flush()
            if elapsed > timeout:
                try:
                    proc.kill()
                except Exception:
                    pass
                raise TimeoutError(f"pip install ({label}) excedeu {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(f"pip install ({label}) falhou (codigo {proc.returncode})")
    print(f"[worker] pip install ({label}) ok em {int(time.time() - start)}s",
          file=sys.stderr, flush=True)


def _ensure_deps():
    """First-run bootstrap. The heavy native deps (numpy / sherpa-onnx / sounddevice /
    httpx) are NOT bundled with the extension; on a clean machine a bare ImportError
    would be cryptic. Detect any missing package, tell the UI, and pip-install them once
    into the active interpreter. Runs at import time, before numpy is first needed."""
    import importlib.util
    required = {
        "numpy": "numpy",
        "sherpa_onnx": "sherpa-onnx",
        "sounddevice": "sounddevice",
        "httpx": "httpx",
    }
    missing = [pkg for mod, pkg in required.items()
               if importlib.util.find_spec(mod) is None]
    if not missing:
        return
    sys.stdout.write(json.dumps({"event": "loading", "stage": "deps",
                                 "msg": "Instalando dependências de voz (primeira execução)..."}) + "\n")
    sys.stdout.flush()
    print(f"[worker] installing missing deps: {missing}", file=sys.stderr, flush=True)
    try:
        _run_pip_install(missing, "dependências de voz", timeout=1200)
    except Exception as exc:
        cmd = '"' + sys.executable + '" -m pip install ' + " ".join(missing)
        sys.stdout.write(json.dumps({"event": "error", "fatal": True,
                                     "msg": f"Não consegui instalar as dependências ({exc}). Rode manualmente: {cmd}"}) + "\n")
        sys.stdout.flush()
        print(f"[worker] pip install failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)


_ensure_deps()


import numpy as np

# SDK flats re-vendorizados (vox-engine SDK 1.7.0): segmentação+STT em streaming
# (StreamingTranscriber/StreamSegmenter) e enumeração/resolução de dispositivos de
# entrada (vox_audio_devices). vox_stream depende de numpy -> importado APÓS numpy.
from vox_stream import StreamingTranscriber, StreamSegmenter
import vox_audio_devices

MODEL_ROOT = os.environ.get("VOICE_MODEL_ROOT") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "artifacts", "models"
)


SAMPLE_RATE = 16000
WHISPER_MAX_S = 28.0
CHUNK_TARGET_S = 8.0

# --- Ponte para o motor único (vox-engine) via named pipe --------------------
# O motor é o ÚNICO caminho de STT+TTS: NÃO há opt-out nem fallback local. Cliente
# em STDLIB PURA (o named pipe do Windows abre como arquivo) — não precisa de
# pywin32, então funciona no python do worker (3.14) mesmo o motor sendo 3.13.
VOX_PIPE = os.environ.get("VOX_PIPE", r"\\.\pipe\vox")
VOX_PROFILE = os.environ.get("VOICE_VOX_PROFILE", "dictation").strip() or "dictation"
# Teto de sanidade p/ o tamanho de um frame vindo do motor: um header gigante
# (stream desincronizado / peer hostil) é rejeitado ALTO em vez de tentar ler GBs
# (evita OOM/wedge). E um timeout no request evita travar o loop de comandos.
VOX_MAX_FRAME = 64 * 1024 * 1024
VOX_REQ_TIMEOUT = float(os.environ.get("VOX_REQ_TIMEOUT", "30").strip() or "30")
# Cushion de conexão da RECONEXÃO (daemon UP, pipe idle stale): ~250ms = ~2-3 tentativas de
# open a 0.1s no SDK, absorvendo um ERROR_PIPE_BUSY transitório do pipe COMPARTILHADO sem
# reintroduzir o stall de ~2s. O PROBE de decode (daemon fora) segue 0ms (fast-fail).
_RECONNECT_CONNECT_MS = 250
GH_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
# Voz de TTS: vazio = usa a voz PADRÃO do motor (default_voice). Não cravamos um nome
# aqui — o catálogo e o padrão são do vox-engine (fonte única, sem lista local).
TTS_MODEL = os.environ.get("VOICE_TTS_MODEL", "").strip()

# Push-to-talk energy gate: discard an utterance whose max peak stays below this
# (suppresses Whisper hallucinations on silence, e.g. "E aí Obrigado"). Tuned to
# sit between the noise floor (~0.0026) and quiet-speech peaks (~0.0038-0.006) on
# low-gain mics; raising it discards quiet real speech, lowering it risks phantom
# transcripts on noise. Override via VOICE_MIC_SILENCE_PEAK.
MIC_SILENCE_PEAK = float(os.environ.get("VOICE_MIC_SILENCE_PEAK", "0.0032") or "0.0032")

# --- Guarda de silêncio AO VIVO (push-to-talk) ------------------------------------------
# Avisa (SEM parar a captura) após este tempo de entrada CONTÍNUA abaixo do limiar. Usa o
# MESMO limiar de pico do veredito final -> aviso ao vivo e veredito no release nunca se
# contradizem (princípio de design já existente no projeto). Override por env.
SILENCE_WARN_S = float(os.environ.get("VOICE_SILENCE_WARN_S", "3.0") or "3.0")
# Um bipe curto que o mic capte NÃO pode "curar" o aviso: só limpa após este tempo de sinal
# CONTÍNUO (um tom de ~100ms nunca alcança). Recuperação sustentada.
SIGNAL_RECOVER_S = float(os.environ.get("VOICE_SIGNAL_RECOVER_S", "0.3") or "0.3")
# Veredito no_audio: a captura só conta como "com áudio real" se teve um RUN DE VOZ (tempo
# contínuo acima do limiar) de pelo menos isto. Usar o MAIOR run (não o pico da captura
# inteira) torna o veredito imune ao bipe de aviso — um tom curto nunca forma um run longo,
# e bipes esparsos nunca se juntam num run só. Protege contra o pico do bipe mascarar a falha.
MIN_VOICED_RUN_MS = int(os.environ.get("VOICE_MIN_VOICED_RUN_MS", "200") or "200")
# Dado de captura mais velho que isto = SEM sinal: um callback de áudio morto (device
# desconectado no meio) deixa _last_peak congelado; a idade transforma isso em silêncio real.
FEED_STALE_S = float(os.environ.get("VOICE_FEED_STALE_S", "0.35") or "0.35")
# Heartbeat da gravação: renova a lease do mic + re-afirma um aviso ativo (à prova de
# reconexão SSE) a cada N s enquanto grava, INDEPENDENTE do nível de áudio.
REC_HEARTBEAT_S = float(os.environ.get("VOICE_REC_HEARTBEAT_S", "5.0") or "5.0")


def build_stop_events(res, sid, mic_silence_peak, mic_detector,
                      min_voiced_run_ms=MIN_VOICED_RUN_MS):
    """Pure builder for the events emitted when a push-to-talk capture stops.

    The recorder ``sid`` is stamped on EVERY transcript event so the extension can
    route the result to the session that recorded it — independent of any in-memory
    primary/active-session state that a failover may have mutated. Returns a list of
    event dicts (so it is unit-testable without the audio stack)."""
    events = []
    sid = sid or ""
    peak = res.get("peak", 0.0)
    run_ms = res.get("voiced_run_ms")
    # "SEM áudio real" = nenhum RUN DE VOZ sustentado (imune ao bipe: um tom curto/esparso
    # nunca forma um run longo, então o pico do bipe não mascara a falha). Cai para o gate de
    # pico quando o run não é reportado (chamadores antigos / caminho quiet).
    no_audio = (run_ms < min_voiced_run_ms) if run_ms is not None else (peak < mic_silence_peak)
    if no_audio:
        mok, mname, mreason = mic_detector()
        if not mok:
            events.append({"event": "mic", "ok": False, "name": mname, "reason": mreason})
        events.append({"event": "transcript", "text": "", "ms": 0, "sid": sid,
                       "note": "no_audio", "peak": peak, "micOk": mok})
    elif not res.get("text") and res.get("dur_ms", 0) < 200:
        events.append({"event": "transcript", "text": "", "ms": 0, "sid": sid,
                       "note": "too_short"})
    else:
        events.append({"event": "transcript", "text": res.get("text", ""), "sid": sid,
                       "ms": res.get("ms", 0), "dur_ms": res.get("dur_ms", 0),
                       "chunks": res.get("chunks", 0)})
    return events


def _parse_mic_env():
    v = os.environ.get("VOICE_MIC_DEVICE", "").strip()
    if not v:
        return None
    try:
        return int(v)
    except ValueError:
        return None

SELECTED_MIC = _parse_mic_env()

def set_selected_mic(dev):
    global SELECTED_MIC
    SELECTED_MIC = (int(dev) if dev is not None else None)


# --- Seguir o microfone PADRÃO do Windows -------------------------------------------
# O PortAudio congela a lista de devices (e o "default") no init do processo. Num worker
# de vida longa, trocar o padrão do Windows NÃO é percebido: ele segue capturando/exibindo
# o device antigo. A correção é re-scanear o PortAudio (Pa_Terminate+Pa_Initialize) quando
# o padrão muda — mas isso é caro (~125ms) e PERIGOSO com stream aberto, então usamos um
# SINAL de mudança barato (Core Audio MMDevice, ~2ms) e só re-scaneamos no modo padrão,
# com o stream fechado e nunca no meio de uma gravação. NÃO seguimos em pino explícito:
# os índices do PortAudio não são estáveis entre re-inits (re-scan num pino trocaria o mic).
HUB = None
_com_tls = threading.local()   # CoInitializeEx uma vez por thread (não re-inicia a cada chamada)
# Serializa TODO re-scan do PortAudio (Pa_Terminate/Pa_Initialize) contra a ENUMERAÇÃO
# (query_devices/default.device) — que roda SEM o hub._lock no mic_monitor e no loop de
# comandos. Sem isso, um Pa_Terminate (libera a tabela de devices) concorrente com um
# query_devices no meio do loop = use-after-free -> segfault, JUSTO no "bluetooth caiu".
_PA_LOCK = threading.Lock()
_MIC_STALL_S = 1.5   # stream 'ativo' sem NENHUM callback por mais que isto = device morto (host APIs que não viram .active=False)


def _now():
    return time.monotonic()


def _default_follow_should_reinit(selected_mic, cur_id, last_id):
    """True só quando vale re-scanear para seguir o padrão do sistema: modo padrão
    (selected_mic is None), com id atual e baseline conhecidos e DIFERENTES."""
    return (selected_mic is None and cur_id is not None
            and last_id is not None and cur_id != last_id)


def _default_capture_id():
    """ID estável do endpoint de captura PADRÃO do Windows via Core Audio (MMDevice),
    ~2ms, SEM tocar no PortAudio. Só um SINAL de mudança; retorna None se indisponível
    (aí degrada para o comportamento atual, sem re-scan)."""
    try:
        import ctypes as _C
        ole32 = _C.oledll.ole32     # calls que retornam HRESULT (auto-raise em falha)
        ole32w = _C.windll.ole32    # void / best-effort (NÃO interpretar retorno como HRESULT)
        ole32w.CoTaskMemFree.restype = None

        class _GUID(_C.Structure):
            _fields_ = [("Data1", _C.c_uint32), ("Data2", _C.c_uint16),
                        ("Data3", _C.c_uint16), ("Data4", _C.c_ubyte * 8)]

        def _guid(s):
            g = _GUID()
            ole32.CLSIDFromString(_C.c_wchar_p(s), _C.byref(g))
            return g

        clsid = _guid("{BCDE0395-E52F-467C-8E3D-C4579291692E}")   # MMDeviceEnumerator
        iid = _guid("{A95664D2-9614-4F35-A746-DE8DB63617E6}")      # IMMDeviceEnumerator
        if not getattr(_com_tls, "inited", False):
            ole32w.CoInitializeEx(None, 0x2)   # APARTMENTTHREADED; best-effort, 1x por thread
            _com_tls.inited = True
        enum = _C.c_void_p()
        if ole32.CoCreateInstance(_C.byref(clsid), None, 0x17,
                                  _C.byref(iid), _C.byref(enum)) < 0:
            return None

        def _call(ptr, idx, argtypes, *a):
            vt = _C.cast(ptr, _C.POINTER(_C.POINTER(_C.c_void_p)))[0]
            # métodos COM são __stdcall -> WINFUNCTYPE (no x64 é unificado, mas fica correto por intenção)
            return _C.cast(vt[idx], _C.WINFUNCTYPE(_C.c_long, _C.c_void_p, *argtypes))(ptr, *a)

        dev = _C.c_void_p()
        try:
            # IMMDeviceEnumerator::GetDefaultAudioEndpoint(eCapture=1, eConsole=0)
            if _call(enum, 4, [_C.c_int, _C.c_int, _C.POINTER(_C.c_void_p)],
                     1, 0, _C.byref(dev)) < 0:
                return None
            pid = _C.c_void_p()
            try:
                if _call(dev, 5, [_C.POINTER(_C.c_void_p)], _C.byref(pid)) < 0:   # IMMDevice::GetId
                    return None
                # GetId aloca a string com CoTaskMemAlloc: copiar e LIBERAR (senão vaza ~230B/chamada)
                return _C.wstring_at(pid) if pid.value else None
            finally:
                if pid.value:
                    ole32w.CoTaskMemFree(pid)
                _call(dev, 2, [])     # dev->Release
        finally:
            _call(enum, 2, [])         # enum->Release
    except Exception:
        return None


def _reinit_portaudio():
    """Re-scaneia o PortAudio (Pa_Terminate+Pa_Initialize) para enxergar o novo padrão/
    hardware. PERIGOSO com stream aberto (Pa_Terminate fecha streams): os chamadores
    garantem stream FECHADO sob lock. Retorna True se re-scaneou. O _terminate é
    best-effort (pode já estar terminado) para SEMPRE tentar o _initialize e nunca
    deixar o PortAudio num estado não-inicializado."""
    try:
        import sounddevice as sd
    except Exception as exc:
        log(f"portaudio reinit failed (import): {exc}")
        return False
    with _PA_LOCK:   # exclui enumeração concorrente (mic_monitor/list_mics/detect_mic) durante terminate+init
        try:
            sd._terminate()
        except Exception:
            pass   # já terminado / estado parcial: segue para reinicializar
        try:
            sd._initialize()
            return True
        except Exception as exc:
            log(f"portaudio reinit failed: {exc}")
            return False


def _open_input_stream(open_fn, selected, on_fallback, log_fn):
    """Abre o InputStream no device SELECIONADO; se ele estiver indisponível (mic
    removido / bateria do bluetooth acabou), CAI para o padrão do Windows (device=None)
    em vez de propagar o erro — o sintoma que o usuário via era justamente um erro de
    ABERTURA de stream ("Error opening InputStream ... PA error code ...").

    Devolve (stream, fell_back:bool). ``open_fn(device)`` abre e devolve o stream
    (levanta em falha); ``on_fallback()`` é chamado quando trocamos para o padrão (p/
    resetar o pino e re-scanear o PortAudio). Se o PRÓPRIO padrão também falhar, RE-levanta
    — aí é honesto (não há microfone algum disponível), sem mascarar em silêncio."""
    if selected is None:
        return open_fn(None), False          # já é o padrão do Windows
    try:
        return open_fn(selected), False      # tenta o mic selecionado (pino)
    except Exception as exc:                  # noqa: BLE001 — QUALQUER falha do device -> cai pro padrão
        try:
            log_fn(f"mic selecionado ({selected}) indisponível: {exc}; voltando ao padrão do Windows")
        except Exception:
            pass
        on_fallback()                         # reset SELECTED_MIC=None + reinit PortAudio p/ ver o default
        return open_fn(None), True            # padrão do Windows; se ISTO falhar, propaga (erro honesto)

WAKE_PHRASES = [p.strip() for p in
                os.environ.get("VOICE_WAKE_PHRASES", "escuta jarvis").split("|")
                if p.strip()] or ["escuta jarvis"]

_stdout_lock = threading.Lock()

TTS_IDLE = threading.Event()
TTS_IDLE.set()


def emit(obj):
    """Write a single JSON line to stdout atomically."""
    line = json.dumps(obj, ensure_ascii=False)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg):
    print(f"[worker] {msg}", file=sys.stderr, flush=True)


# ---- Detecção de FOCO do app (Windows): o app GitHub Copilot é a janela em FOREGROUND? ----
# O áudio toca NO WEBVIEW; quando o app perde o foco do SO mas a janela segue visível,
# document.visibilityState continua 'visible' e o painel continua falando. Só um check NATIVO
# (GetForegroundWindow) distingue "app sem foco" de "outro painel do mesmo app focado"
# (document.hasFocus() é POR-webview). Windows-only; ctypes stdlib; sem dependência nova.
# Funções puras (app_focused_given) separadas das nativas (live) para teste determinístico.

def _norm_exe(p):
    """Normaliza um caminho de exe para comparação (case/sep-insensitive no Windows)."""
    if not p:
        return ""
    try:
        return os.path.normcase(os.path.normpath(str(p)))
    except Exception:
        return str(p).lower()


def app_focused_given(fg_exe, app_exe):
    """PURO (testável): o exe em foreground é o exe do app? Case/sep-insensitive. Vazio/None
    -> False. O caller faz FAIL-OPEN: se a detecção estiver indisponível, NÃO bloqueia o áudio."""
    a = _norm_exe(fg_exe)
    b = _norm_exe(app_exe)
    return bool(a and b and a == b)


def _foreground_exe():
    """Caminho completo do processo dono da janela em FOREGROUND, ou None. Windows-only."""
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.GetForegroundWindow.restype = wintypes.HWND   # handle é pointer-sized: evita truncar em 64-bit
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None
        return _exe_path_of(pid.value) or None
    except Exception:
        return None


def _exe_path_of(pid):
    """Caminho completo do exe de um pid via QueryFullProcessImageNameW (não exige elevação
    para processos do próprio usuário: usa PROCESS_QUERY_LIMITED_INFORMATION). '' se falhar."""
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32.OpenProcess.restype = wintypes.HANDLE   # handle pointer-sized: sem truncar em 64-bit
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                        wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(4096)
            size = wintypes.DWORD(4096)
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return buf.value
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        return ""
    return ""


def _proc_snapshot():
    """{pid: (ppid, exe_basename_lower)} de TODOS os processos via Toolhelp32Snapshot. {} se falhar."""
    out = {}
    try:
        import ctypes
        from ctypes import wintypes
        TH32CS_SNAPPROCESS = 0x00000002
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE   # handle pointer-sized
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD),
                        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

        snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        INVALID = ctypes.c_void_p(-1).value
        if not snap or snap == INVALID:
            return out
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
            while ok:
                out[int(entry.th32ProcessID)] = (int(entry.th32ParentProcessID),
                                                 (entry.szExeFile or "").lower())
                ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snap)
    except Exception:
        pass
    return out


def discover_app_exe(start_pid=None, app_basename="github.exe"):
    """Caminho do exe do app GitHub Copilot. Estratégia: (1) sobe a ANCESTRALIDADE do worker
    (python <- node fork <- copilot.exe CLI <- ... <- github.exe) até um ancestral cujo basename
    == app_basename -> seu caminho; (2) fallback: varre TODOS os processos por app_basename cujo
    caminho contém 'GitHub Copilot'. '' se não achar (aí a detecção fica indisponível -> fail-open)."""
    try:
        snap = _proc_snapshot()
        if not snap:
            return ""
        start = int(start_pid if start_pid is not None else os.getpid())
        seen = set()
        cur = start
        for _ in range(24):   # teto de saltos (anti-ciclo)
            if cur in seen or cur not in snap:
                break
            seen.add(cur)
            ppid, base = snap[cur]
            if base == app_basename:
                p = _exe_path_of(cur)
                if p:
                    return p
            cur = ppid
        for pid, (ppid, base) in snap.items():   # (2) fallback: scan por path
            if base == app_basename:
                p = _exe_path_of(pid)
                if p and "github copilot" in p.lower():
                    return p
    except Exception:
        pass
    return ""


# Poller de foco: emite {event:appFocus, focused} SÓ na MUDANÇA (+ estado inicial). Roda no worker
# PRIMÁRIO (único), compartilhado por todas as sessões — o estado é GLOBAL (app focado ou não); cada
# webview decide GATEAR conforme seu próprio setting. FAIL-OPEN: sem app descoberto ou leitura de
# foreground indisponível -> focused=True (nunca silencia por falha de detecção). Barato (~1 syscall/s).
_focus_thr = [None]
_focus_stop = [None]
_focus_app_exe = [None]   # descoberto 1x (cache); "" = indisponível -> fail-open


def _focus_verdict(app_exe):
    """Estado atual de foco (fail-open). Puro exceto pela leitura nativa do foreground."""
    if not app_exe:
        return True
    fg = _foreground_exe()
    if fg is None:
        return True
    return app_focused_given(fg, app_exe)


def _focus_poll_loop(stop_evt, interval=1.0):
    if _focus_app_exe[0] is None:
        _focus_app_exe[0] = discover_app_exe()
    app = _focus_app_exe[0]
    last = [None]

    def _tick():
        foc = _focus_verdict(app)
        if foc != last[0]:
            last[0] = foc
            emit({"event": "appFocus", "focused": bool(foc)})

    _tick()                                    # estado inicial
    while not stop_evt.wait(interval):
        try:
            _tick()
        except Exception:
            pass


def start_focus_poller():
    if _focus_thr[0] is not None and _focus_thr[0].is_alive():
        return
    ev = threading.Event()
    _focus_stop[0] = ev
    t = threading.Thread(target=_focus_poll_loop, args=(ev,), daemon=True, name="focus-poll")
    _focus_thr[0] = t
    t.start()


def stop_focus_poller():
    if _focus_stop[0] is not None:
        _focus_stop[0].set()
    _focus_thr[0] = None
    _focus_stop[0] = None


def _download_file(url, dst, timeout=180, on_pct=None, attempts=3):
    """Stream a URL to dst atomically (write a .part temp, then os.replace) so an
    interrupted download never leaves a half-written file that later fails to extract.
    Calls on_pct(percent) at most ~2x/sec when the server sends Content-Length. Shared
    by the Whisper / TTS / VAD model bootstrap. Retries with backoff on transient
    network failures (corporate proxy drops mid-stream on a 1.5 GB pull) and always
    clears the .part on failure so a retry starts clean."""
    import httpx
    tmp = dst + ".part"
    last_exc = None
    for attempt in range(1, attempts + 1):
        got = 0
        last = 0.0
        try:
            with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                with open(tmp, "wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        f.write(chunk)
                        got += len(chunk)
                        if on_pct and total:
                            now = time.time()
                            if now - last > 0.5:
                                last = now
                                on_pct(round(100 * got / total, 1))
            os.replace(tmp, dst)
            return got
        except Exception as exc:  
            last_exc = exc
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            if attempt < attempts:
                wait = 2 ** attempt  
                log(f"download attempt {attempt}/{attempts} failed ({exc}); retrying in {wait}s")
                time.sleep(wait)
    raise last_exc


def voices_event(nfo):
    """Monta o evento 'voices' a partir do ``info()`` do motor. O catálogo de vozes
    e a voz padrão são do vox-engine (fonte única) — se o motor não reporta, vai lista
    VAZIA (a UI mostra 'indisponível' ALTO; nunca uma lista local mascarando o erro).
    ``supported`` (SDK 1.5.0) é o catálogo de vozes BAIXÁVEIS sob demanda (cada item
    {name,lang,type,quality,installed}); a UI mostra instaladas + baixáveis e o motor
    baixa a escolhida na 1ª fala — resolve a 'máquina nova só com uma voz feia'."""
    nfo = nfo or {}
    voices = nfo.get("tts_voices")
    supported = nfo.get("supported_voices")
    return {"event": "voices",
            "voices": voices if isinstance(voices, list) else [],
            "supported": supported if isinstance(supported, list) else [],
            "default_voice": nfo.get("default_voice")}


def set_tts_voice(name):
    """Troca a voz do TTS em runtime. O motor é o único caminho: só registra o NOME
    (TTS_MODEL); o vox-engine carrega/baixa a voz sozinho no próximo tts. Sem Piper
    local, sem download aqui."""
    global TTS_MODEL
    name = (name or "").strip()
    if not name or name == TTS_MODEL:
        return
    TTS_MODEL = name
    emit({"event": "tts_voice", "ok": True, "voice": name})
    log(f"tts voice set to {name} (motor)")


def _hann_highpass(x, sr, fc=60.0):
    """Smooth high-pass via Hann-windowed moving-average subtraction (no scipy).
    Removes DC + the sub-fc rumble that dominates the Piper noise floor without
    comb-coloring the voice band (Hann sidelobes are ~-31 dB)."""
    L = int(1.44 * sr / max(20.0, fc))
    if L < 8 or x.size < 2 * L:
        return (x - float(np.mean(x))).astype(np.float32)
    w = np.hanning(L).astype(np.float32)
    w /= float(w.sum())
    lp = np.convolve(x, w, mode="same").astype(np.float32)
    return (x - lp).astype(np.float32)


def _gate_gaps(x, sr, min_gap_ms=130, floor_gain=0.0):
    """Attenuate SUSTAINED silence (inter-sentence/clause pauses) so the normalized
    noise floor doesn't hiss between phrases ('static at the period'). Short
    low-energy sounds (fricatives s/ch/x, brief pauses) are left untouched, and the
    gap edges are guarded + smoothed so word onsets/tails aren't clipped."""
    fl = max(1, int(0.01 * sr))
    n = x.size // fl
    if n < 8:
        return x
    env = np.sqrt(np.mean(x[: n * fl].reshape(n, fl) ** 2, axis=1))
    floor = float(np.percentile(env, 5))
    thr = max(3.0 * floor, 0.006)
    quiet = env < thr
    g = np.ones(n, dtype=np.float32)
    min_run = max(4, int(min_gap_ms / 10))
    guard = 3  
    i = 0
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if j - i >= min_run:
                a, b = i + guard, j - guard
                if b > a:
                    g[a:b] = floor_gain
            i = j
        else:
            i += 1
    gain = np.repeat(g, fl)
    if gain.size < x.size:
        gain = np.concatenate([gain, np.full(x.size - gain.size, g[-1], np.float32)])
    else:
        gain = gain[: x.size]
    k = max(1, int(0.02 * sr))  
    ker = np.hanning(2 * k + 1).astype(np.float32)
    ker /= float(ker.sum())
    gain = np.convolve(gain, ker, mode="same").astype(np.float32)
    return (x * gain).astype(np.float32)


def clean_tts(samples, sr):
    """Clean + normalize the neural TTS at the SOURCE so the client no longer has
    to amplify a noisy, quiet signal. Piper's miro voice comes out at ~-17 dBFS
    with a low-frequency rumble (~55 Hz), noisy edges, and an exposed noise floor in
    the pauses between sentences. We: remove DC + sub-60 Hz rumble, trim the noisy
    edges, gate the inter-sentence gaps (kills the 'static at the period'), normalize
    near full scale, and fade in/out."""
    x = np.asarray(samples, dtype=np.float32).copy()
    if x.size < int(0.05 * sr):
        return x
    x = _hann_highpass(x, sr, 60.0)
    fl = max(1, int(0.01 * sr))
    n = x.size // fl
    if n >= 4:
        env = np.sqrt(np.mean(x[: n * fl].reshape(n, fl) ** 2, axis=1))
        floor = float(np.percentile(env, 10))
        thr = max(3.0 * floor, 0.01)
        voiced = np.where(env > thr)[0]
        if voiced.size:
            s = max(0, voiced[0] * fl - int(0.03 * sr))
            e = min(x.size, (voiced[-1] + 1) * fl + int(0.06 * sr))
            x = x[s:e]
    x = _gate_gaps(x, sr)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 1e-6:
        x = x * (0.92 / peak)
    f = max(1, int(0.012 * sr))
    if x.size > 2 * f:
        x[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32)
        x[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)
    return x.astype(np.float32)


def write_wav(path, samples, sample_rate):
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm16.tobytes())


def synthesize_tts(msg, synth):
    _id = msg.get("id")
    try:
        # Coerções DENTRO do try: um speed/text inválido (p.ex. campo vindo de outra
        # extensão pelo pipe) vira {tts, ok:false} id-correlacionado — nunca escapa mudo.
        text = (msg.get("text") or "").strip() or "Sem conteúdo para ler."
        out = msg.get("out")
        speed = float(msg.get("speed") or 1.0)
        # O TTS vem SÓ do vox-engine (voz por NOME). SEM Piper, SEM fallback: se o
        # motor não está no ar, erro ALTO e VISÍVEL (ok:false), nunca mudo.
        if synth is None:
            raise VoxEngineError("motor de voz (vox-engine) indisponível para TTS")
        TTS_IDLE.clear()
        try:
            samples, sr = synth(text, TTS_MODEL, speed)
        finally:
            TTS_IDLE.set()
        cleaned = clean_tts(samples, sr)
        if out:
            write_wav(out, cleaned, sr)
        emit({"event": "tts", "id": _id, "ok": True, "out": out,
              "sample_rate": int(sr), "source": "vox-engine"})
    except Exception as exc:
        log("tts error:\n" + traceback.format_exc())
        emit({"event": "tts", "id": _id, "ok": False, "msg": str(exc)})


METER_DELTA_RMS = 0.004
METER_DELTA_PEAK = 0.008


def _meter_should_emit(rms, peak, last_rms, last_peak):
    """Delta-gate do medidor de nível: só vale emitir quando o valor muda de forma
    perceptível. Sem isto, o medidor inunda a cadeia worker→Node→SSE→DOM a ~8/s com
    valores repetidos (ex.: silêncio estável). ``last=-1`` (sentinela) força o 1º emit."""
    return abs(rms - last_rms) > METER_DELTA_RMS or abs(peak - last_peak) > METER_DELTA_PEAK


def silence_signal_update(peak, silent_since, sustained_since, warned, now,
                          threshold=MIC_SILENCE_PEAK, warn_s=SILENCE_WARN_S,
                          recover_s=SIGNAL_RECOVER_S):
    """Passo PURO (testável) do guarda de silêncio ao vivo. Recebe o pico atual + o estado
    anterior e devolve ``(silent_since, sustained_since, warned, event_or_None)``.

    - Abaixo do limiar: inicia/continua um run de SILÊNCIO; após ``warn_s`` contínuos, emite
      ``low_signal:true`` UMA vez.
    - No/acima do limiar: inicia/continua um run de SINAL; só após ``recover_s`` CONTÍNUOS
      (um bipe curto não alcança) limpa com ``low_signal:false``.

    Usa ``is None`` (um valor de relógio monotônico 0.0 é válido — não pode virar falsy)."""
    if peak >= threshold:
        silent_since = None
        if sustained_since is None:
            sustained_since = now
        if warned and (now - sustained_since) >= recover_s:
            return (None, sustained_since, False, {"event": "low_signal", "state": False})
        return (silent_since, sustained_since, warned, None)
    # abaixo do limiar
    sustained_since = None
    if silent_since is None:
        silent_since = now
    if not warned and (now - silent_since) >= warn_s:
        return (silent_since, None, True,
                {"event": "low_signal", "state": True, "elapsed": round(now - silent_since, 2)})
    return (silent_since, sustained_since, warned, None)


class _DecodeClient:
    """Adapta o decodificador injetado (``fn(seg) -> texto``, já serializado e com defer
    de TTS) para a interface ``client.transcribe(seg, **kwargs)`` que o
    :class:`StreamingTranscriber` do SDK espera. Ignora os kwargs de roteamento (o closure
    já fixou lang/session/estado) e acumula o tempo de STT para o ``ms`` do envelope. Aplica
    o piso de 0,1s do decode antigo (segmentos ínfimos não vão ao motor)."""

    def __init__(self, fn):
        self._fn = fn
        self.proc_ms = 0

    def transcribe(self, seg, **_kwargs):
        if seg is None or seg.size < int(0.1 * SAMPLE_RATE):
            return ""
        t0 = time.time()
        try:
            return self._fn(seg) or ""
        finally:
            self.proc_ms += int((time.time() - t0) * 1000)


class Recorder:
    def __init__(self):
        self._last_rms = 0.0
        self._last_peak = 0.0
        self._max_peak = 0.0
        self._last_feed_at = 0.0     # monotonic do último feed() — idade delata device morto
        self._cur_run_ms = 0.0       # run de voz atual (tempo contínuo >= limiar)
        self._max_run_ms = 0.0       # MAIOR run da captura -> veredito no_audio (imune ao bipe)
        self._rec_gen = 0            # geração da captura — barra thread de meter antiga numa nova
        self._recording = False
        self._meter_thread = None
        self._decode_fn = None
        self._st = None              # StreamingTranscriber (segmentação+STT do SDK) por captura
        self._client = None          # adaptador _decode_fn -> client.transcribe do SDK
        self._partials = []          # textos dos segmentos (p/ chunks); o texto final vem de finish()
        self._dur_samples = 0
        self._proc_ms = 0
        self._quiet = False

    def set_decoder(self, fn):
        """Inject the decode function (wraps the recognizer)."""
        self._decode_fn = fn

    def feed(self, block, status=None):  
        if status:
            log(f"stream status: {status}")
        if not self._recording:
            return
        # medidor + peak da captura INTEIRA (para o envelope e o mic-health gate): MEU, não do SDK
        # (peak = max-abs; o on_rms do SDK é RMS por-segmento, escala diferente — não substitui).
        self._last_feed_at = time.monotonic()
        self._last_rms = float(np.sqrt(np.mean(block ** 2)) if block.size else 0.0)
        self._last_peak = float(np.max(np.abs(block)) if block.size else 0.0)
        if self._last_peak > self._max_peak:
            self._max_peak = self._last_peak
        # Contabilidade de RUN DE VOZ (health imune ao bipe): acumula tempo CONTÍNUO acima do
        # limiar; o MAIOR run — não o pico da captura inteira — decide o veredito no_audio.
        blk_ms = (1000.0 * int(block.size) / SAMPLE_RATE) if block.size else 0.0
        if self._last_peak >= MIC_SILENCE_PEAK:
            self._cur_run_ms += blk_ms
            if self._cur_run_ms > self._max_run_ms:
                self._max_run_ms = self._cur_run_ms
        else:
            self._cur_run_ms = 0.0
        self._dur_samples += int(block.size)
        # segmentação + STT sobreposto: alimenta o StreamingTranscriber vendorizado (SDK).
        # A segmentação é leve (frame-rms/cut sobre o bloco); o STT pesado roda na thread do SDK.
        if self._st is not None:
            self._st.feed(block)

    def _meter_loop(self, gen):
        last_rms = last_peak = -1.0
        silent_since = sustained_since = None
        warned = False
        last_hb = time.monotonic()
        while self._recording and gen == self._rec_gen:
            now = time.monotonic()
            # STALENESS: um callback de áudio morto (device desconectado no meio) congela
            # _last_peak -> a idade do último feed transforma isso em silêncio real (senão o
            # guarda nunca dispararia justo quando o mic morre — a causa da perda de 30 min).
            fresh = (now - self._last_feed_at) <= FEED_STALE_S
            eff_peak = self._last_peak if fresh else 0.0
            rms = round(self._last_rms if fresh else 0.0, 5)
            peak = round(eff_peak, 4)
            if _meter_should_emit(rms, peak, last_rms, last_peak):
                emit({"event": "level", "rms": rms, "peak": peak})
                last_rms, last_peak = rms, peak
            silent_since, sustained_since, warned, ev = silence_signal_update(
                eff_peak, silent_since, sustained_since, warned, now)
            if ev is not None:
                emit(ev)
            # HEARTBEAT: renova a lease do mic (guarda >60s de gravação longa) + re-afirma um
            # aviso ativo — à prova de reconexão SSE (o one-shot low_signal:true pode se perder).
            if now - last_hb >= REC_HEARTBEAT_S:
                last_hb = now
                emit({"event": "rec_alive"})
                if warned:
                    emit({"event": "low_signal", "state": True, "reassert": True})
            time.sleep(0.12)

    def _on_segment(self, idx, text):
        # on_segment do SDK dispara "" p/ silêncio/falha de STT (mantém a ordem/índice) — FILTRA
        # vazio: não conta como chunk. O texto final agregado vem de finish() (em ordem).
        if text:
            self._partials.append(text)

    def begin(self, quiet=False):
        """Start capturing. The mic stream is owned by AudioHub, which pushes blocks
        in via feed(); here we only reset buffers and spin up the meter + streamer
        threads. No PortAudio call happens here, so the wake<->record hand-off never
        opens a second device stream. `quiet` suppresses the recording/level UI
        events so the hands-free wake-command capture can reuse this exact pipeline
        without lighting up the push-to-talk mic ring."""
        if self._recording:
            return
        self._quiet = quiet
        self._max_peak = 0.0
        self._last_peak = 0.0
        self._last_rms = 0.0
        self._last_feed_at = time.monotonic()   # sem isto, um feed velho pré-captura seria "fresco"
        self._cur_run_ms = 0.0
        self._max_run_ms = 0.0
        self._dur_samples = 0
        self._proc_ms = 0
        self._partials = []
        self._rec_gen += 1
        # StreamingTranscriber do SDK: dono da segmentação (StreamSegmenter) + STT sobreposto
        # numa thread própria (aposenta Recorder._consume/_stream_loop + _cut_point/_frame_rms).
        # O _decode_fn injetado (fn(seg)->texto, serializado, defer de TTS) é adaptado à interface
        # client.transcribe. min_rms=0.0 preserva o comportamento atual (gate anti-silêncio é opt-in).
        if self._decode_fn is not None:
            self._client = _DecodeClient(self._decode_fn)
            self._st = StreamingTranscriber(
                self._client, on_segment=self._on_segment, min_rms=0.0,
                sr=SAMPLE_RATE, chunk_target_s=CHUNK_TARGET_S, hard_s=WHISPER_MAX_S)
        else:
            self._client = None
            self._st = None
        self._recording = True
        if not quiet:
            self._meter_thread = threading.Thread(target=self._meter_loop, args=(self._rec_gen,), daemon=True)
            self._meter_thread.start()
        if not quiet:
            emit({"event": "recording", "state": True})

    def _end(self):
        """Stop capturing. No stream teardown — AudioHub owns the device."""
        self._recording = False
        if not self._quiet:
            emit({"event": "recording", "state": False})

    def _join_streamer(self):
        # StreamingTranscriber.finish()/cancel() já drena/encerra a thread de STT do SDK;
        # não há mais thread de streaming própria do Recorder para juntar. Mantido no-op p/
        # compat com chamadas existentes.
        return

    def _reset(self):
        self._st = None
        self._client = None
        self._partials = []
        self._dur_samples = 0
        self._proc_ms = 0

    def stop(self):
        """Stop recording and return {text, dur_ms, ms, peak, chunks}. Long dictations
        were mostly decoded during recording; finish() drains the tail (STT of the last
        segments) and returns the joined text in order — so 'stop' never loses the last
        utterance."""
        if not self._recording and self._st is None and not self._partials:
            return {"text": "", "dur_ms": 0, "ms": 0, "chunks": 0}
        self._end()
        text = ""
        if self._st is not None:
            text = self._st.finish()          # drena a cauda + espera o worker do SDK + junta em ordem
            for _err in self._st.errors:      # observabilidade: STT/fila do SDK caem em .errors (o
                log(f"decode error: {_err}")  # decode antigo logava direto) — re-superfície no log
        proc_ms = self._client.proc_ms if self._client is not None else self._proc_ms
        res = {"text": text,
               "dur_ms": int(1000 * self._dur_samples / SAMPLE_RATE),
               "ms": int(proc_ms),
               "peak": round(self._max_peak, 5),
               "voiced_run_ms": int(self._max_run_ms),
               "chunks": len(self._partials)}
        self._reset()
        return res

    def cancel(self):
        self._end()
        if self._st is not None:
            self._st.cancel()                 # descarta pendentes SEM transcrever (abort do PTT)
        self._reset()


def _wake_norm(t):
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _lev(a, b):
    """Levenshtein distance (small strings)."""
    m, n = len(a), len(b)
    if not m:
        return n
    if not n:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        ca = a[i - 1]
        for j in range(1, n + 1):
            cost = 0 if ca == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[n]


def _tok_match(tok, tgt, max_d):
    if tok == tgt:
        return True
    if len(tgt) >= 4 and tok.startswith(tgt[: max(4, len(tgt) - 1)]):
        return True
    if (tgt in tok or tok in tgt) and abs(len(tok) - len(tgt)) <= max_d:
        return True
    return _lev(tok, tgt) <= max_d


def match_wake(text, phrases, anchor_window=2, tail_window=4):
    """If `text` starts with a wake phrase (tolerant of accents and ASR slips),
    return {'phrase', 'command'} where `command` is whatever was said after the
    phrase in the same utterance (possibly empty); else None. The anchor token must
    appear near the utterance start, which keeps stray mid-sentence mentions of the
    words from triggering."""
    norm = _wake_norm(text)
    if not norm:
        return None
    toks = norm.split()
    for phrase in phrases:
        ptoks = _wake_norm(phrase).split()
        if not ptoks:
            continue
        joined = " ".join(ptoks)
        if (" " + joined + " ") in (" " + norm + " "):
            idx = norm.find(joined)
            return {"phrase": phrase, "command": norm[idx + len(joined):].strip()}
        anchor, rest = ptoks[0], ptoks[1:]
        for ai in range(min(anchor_window, len(toks))):
            if not _tok_match(toks[ai], anchor, 2 if len(anchor) >= 5 else 1):
                continue
            ti, last, ok = ai + 1, ai, True
            for pt in rest:
                found = -1
                for k in range(ti, min(ti + tail_window, len(toks))):
                    if _tok_match(toks[k], pt, 2 if len(pt) >= 5 else 1):
                        found = k
                        break
                if found < 0:
                    ok = False
                    break
                ti, last = found + 1, found
            if ok:
                return {"phrase": phrase,
                        "command": " ".join(toks[last + 1:]).strip()}
    return None


WAKE_BLOCK = 1600              


def _env_ms(env_name, default_ms):
    """A duration in ms from env, falling back to a default. Lets a future settings
    slider tune the VAD gates without code changes."""
    try:
        v = float(os.environ.get(env_name, "").strip())
        if v > 0:
            return v
    except (TypeError, ValueError):
        pass
    return float(default_ms)


VAD_MODEL_FILE = "silero_vad.onnx"
VAD_SILENCE_S = _env_ms("VOICE_WAKE_CMD_SILENCE_MS", 2800) / 1000.0
VAD_MIN_SPEECH_S = _env_ms("VOICE_WAKE_MIN_SPEECH_MS", 250) / 1000.0
VAD_THRESHOLD = 0.5
VAD_WINDOW = 512              
WAKE_PREROLL_BLOCKS = 10      
WAKE_HEAD_S = 3.0            
WAKE_GUARD_S = 8.0


_vad_lock = threading.Lock()

def ensure_vad_model():
    """Return the Silero VAD model path, downloading it (GitHub release, ~0.6 MB) if
    missing. Same proxy/truststore path as the Whisper/TTS model bootstrap. Serialized
    by _vad_lock so a startup prefetch and a wake-toggle fetch can't download
    concurrently into the same file."""
    path = os.path.join(MODEL_ROOT, VAD_MODEL_FILE)
    if os.path.isfile(path):
        return path
    with _vad_lock:
        if os.path.isfile(path):
            return path
        os.makedirs(MODEL_ROOT, exist_ok=True)
        url = f"{GH_BASE}/{VAD_MODEL_FILE}"
        log(f"downloading silero vad from {url}")
        _download_file(url, path, timeout=120)
    return path


def build_vad():
    """Build the sherpa-onnx Silero VAD used to gate wake/command capture. It owns the
    onset (min_speech) and end-of-speech (min_silence) decision so the listener no
    longer hand-rolls an energy floor. Built on the listener thread, never the main."""
    import sherpa_onnx
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = ensure_vad_model()
    cfg.silero_vad.threshold = VAD_THRESHOLD
    cfg.silero_vad.min_silence_duration = VAD_SILENCE_S
    cfg.silero_vad.min_speech_duration = VAD_MIN_SPEECH_S
    cfg.silero_vad.window_size = VAD_WINDOW
    cfg.silero_vad.max_speech_duration = 300.0   
    cfg.sample_rate = SAMPLE_RATE
    cfg.num_threads = 1
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)


class WakeListener:
    """Always-on background listener. An energy VAD segments utterances; each is
    transcribed with the shared Whisper and fuzzy-matched against the wake phrase.
    On a hit it emits a 'wake' event and the command (spoken in the same breath, or
    the next utterance) as a 'command' event for the extension to inject as a turn.
    It releases the mic around push-to-talk so only one input stream is ever open."""

    def __init__(self, decode_fn, phrases):
        self._decode = decode_fn
        self._phrases = list(phrases) if phrases else ["escuta jarvis"]
        self._q = queue.Queue(maxsize=200)
        self._thread = None
        self._enabled = False      
        self._active = False       
        self._cmd_rec = Recorder()
        self._cmd_rec.set_decoder(decode_fn)
        self._converse_arm = 0.0

    def set_phrases(self, phrases):
        if phrases:
            self._phrases = list(phrases)
            log(f"wake phrases set to {self._phrases}")

    def feed(self, block):
        """Called from the AudioHub mic callback with one block, ONLY when wake is
        active. We never own a stream, so the wake<->record hand-off is a flag flip
        and can never make a blocking PortAudio call on the JSON-RPC main thread."""
        if not self._active:
            return
        try:
            self._q.put_nowait(block)
        except queue.Full:
            pass

    def _drain(self):
        with self._q.mutex:
            self._q.queue.clear()

    def enable(self):
        """Turn wake mode on. AudioHub guarantees the shared mic stream is open."""
        if self._enabled:
            return
        self._enabled = True
        self._active = True
        self._drain()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._emit_listening()
        log(f"wake listening for {self._phrases}")

    def disable(self):
        """Turn wake mode off. The loop exits; AudioHub closes the stream if idle."""
        was = self._enabled
        self._enabled = False
        self._active = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None
        if was:
            emit({"event": "wake", "state": "stopped"})

    def suspend(self):
        """Push-to-talk is taking the mic: stop consuming + reset VAD state. The
        shared stream stays open and just stops routing to us — zero PortAudio calls,
        so this is instant and can never block the main thread (the SIGTERM cause)."""
        self._active = False
        self._drain()

    def resume(self):
        """Push-to-talk finished: resume consuming the shared stream (if still on)."""
        if self._enabled:
            self._drain()
            self._active = True
            self._emit_listening()

    def arm_converse(self, timeout_s):
        """Arm a one-shot onset window for continuous conversation: the NEXT
        utterance is captured directly (no wake phrase), exactly like the bare
        trigger's 'await' state. Only a float assignment — safe to call from the
        stdin thread; _loop picks it up while scanning. No-op while push-to-talk
        owns the mic or wake is off (the loop guards mode == 'scan' too)."""
        if self._enabled and self._active:
            self._converse_arm = time.time() + max(0.5, float(timeout_s))

    def _emit_listening(self):
        emit({"event": "wake", "state": "listening",
              "phrase": self._phrases[0] if self._phrases else ""})

    def _decode_clip(self, samples):
        if self._decode is None or samples.size < int(0.2 * SAMPLE_RATE):
            return ""
        try:
            return self._decode(samples) or ""
        except Exception as exc:
            log(f"wake decode error: {exc}")
            return ""

    def _detect_short(self, blocks):
        """Decode a short complete utterance (one that ended before the head window —
        only reachable with a very short VAD silence gate) and test the wake phrase.
        Returns ("command", text) for a same-breath command, ("await", "") for a bare
        trigger, or ("none", "") otherwise."""
        try:
            samples = np.concatenate(blocks).astype(np.float32)
        except ValueError:
            return ("none", "")
        if samples.size < int(0.3 * SAMPLE_RATE):
            return ("none", "")
        m = match_wake(self._decode_clip(samples), self._phrases)
        if not m:
            return ("none", "")
        emit({"event": "wake", "state": "triggered", "phrase": m["phrase"]})
        cmd = (m["command"] or "").strip()
        return ("command", cmd) if cmd else ("await", "")

    def _start_command_capture(self, prefill):
        """Hand already-buffered audio to the command Recorder and start streaming.
        From here on, every mic block is fed to it (see _loop) and decoded
        progressively — exactly like push-to-talk."""
        self._cmd_rec.begin(quiet=True)
        for b in prefill:
            self._cmd_rec.feed(b)

    def _finish_command(self, expect_wake):
        """Stop the Recorder-backed capture and return (matched, command). The audio
        rode the SAME progressive pipeline as push-to-talk — no cap, never cut mid-word.
        For a scan-origin capture (expect_wake) the transcript must contain the wake
        phrase and the command is what follows it; for an await/converse capture the
        whole transcript is the command. Emitting the event is left to the caller."""
        res = self._cmd_rec.stop()
        self._drain()                      
        text = (res.get("text") or "").strip()
        m = match_wake(text, self._phrases) if text else None
        if expect_wake:
            matched = m is not None
            cmd = (m["command"] or "").strip() if m else ""
        else:
            matched = True
            cmd = ((m["command"] or "").strip() if (m and m["command"]) else text)
        log(f"wake cmd finish: chunks={res.get('chunks')} dur_ms={res.get('dur_ms')} "
            f"raw_len={len(text)} cmd_len={len(cmd)} matched={matched}")
        return matched, cmd

    def _loop(self):
        """SCAN for the wake phrase, then capture the COMMAND through the shared
        push-to-talk Recorder pipeline (progressive chunks, pause-deferred cuts, no
        cap). Onset and end-of-speech are decided by the sherpa-onnx Silero VAD — the
        SAME production endpointer — instead of a hand-rolled energy floor. Because
        is_speech_detected() only drops after VAD_SILENCE_S of CONTINUOUS silence, a
        natural mid-sentence pause never truncates the command the way the old
        percentile-floor heuristic did. State machine: scan -> (await|record|dead) -> scan."""
        vad = None
        last_exc = None
        for _attempt in range(3):
            try:
                vad = build_vad()
                break
            except Exception as exc:
                last_exc = exc
                log(f"wake vad load failed (attempt {_attempt + 1}/3): {exc}")
                time.sleep(2.0)
        if vad is None:
            emit({"event": "wake", "state": "error",
                  "msg": f"Não foi possível carregar o detector de voz (VAD): {last_exc}"})
            log(f"wake disabled: vad unavailable after retries: {last_exc}")
            return

        preroll = deque(maxlen=WAKE_PREROLL_BLOCKS)   
        utter = []                                    
        mode = "scan"                                 
        speaking = False                              
        head_tested = False                           
        expect_wake = True                            
        converse = False                              
        deadline = 0.0
        head_blocks = max(1, int(WAKE_HEAD_S * SAMPLE_RATE / WAKE_BLOCK))

        def go_scan():
            nonlocal mode, speaking, head_tested, expect_wake, converse, utter
            mode, speaking, head_tested, expect_wake, converse = "scan", False, False, True, False
            utter = []
            preroll.clear()
            try:
                vad.reset()
            except Exception:
                pass

        def finish(reason):
            """End a command capture: stop the Recorder, then emit / await / discard."""
            nonlocal mode, expect_wake, converse, deadline
            log(f"wake cmd end: {reason}")
            matched, cmd = self._finish_command(expect_wake)
            if cmd:
                emit({"event": "command", "text": cmd})
                self._emit_listening()
                go_scan()
            elif expect_wake and matched:
                go_scan()
                mode, expect_wake, deadline = "await", False, time.time() + WAKE_GUARD_S
                emit({"event": "wake", "state": "awaiting"})
            else:
                emit({"event": "wake", "state": "empty"})
                go_scan()

        while self._enabled:
            block = self._next_block(0.2)
            now = time.time()

            if not self._active:
                if mode == "record":
                    log("wake cmd cancel: push-to-talk took the mic")
                    self._cmd_rec.cancel()
                if mode != "scan" or speaking:
                    go_scan()
                continue

            if mode == "scan" and self._converse_arm:
                deadline = self._converse_arm
                self._converse_arm = 0.0
                go_scan()
                mode, converse, expect_wake = "await", True, False
                emit({"event": "wake", "state": "awaiting"})
                log("wake converse: armed onset window")

            if block is None:
                if mode == "await" and now > deadline:
                    emit({"event": "wake", "state": "discarded"})
                    go_scan()
                elif mode == "record" and now > deadline:
                    finish("inactivity deadline (stream idle)")
                continue

            try:
                vad.accept_waveform(block.astype(np.float32))
            except Exception:
                pass
            speech = vad.is_speech_detected()
            try:
                while not vad.empty():
                    vad.pop()
            except Exception:
                pass

            if mode == "record":
                self._cmd_rec.feed(block)
                if speech:
                    deadline = now + WAKE_GUARD_S          
                else:
                    finish(f"silence gate (VAD ~{VAD_SILENCE_S:.1f}s"
                           f"{', converse' if converse else '' if expect_wake else ', await'})")
                continue

            if mode == "dead":
                if not speech:
                    go_scan()
                continue

            if mode == "await":
                if now > deadline:
                    emit({"event": "wake", "state": "discarded"})
                    go_scan()
                    continue
                if speech:
                    self._start_command_capture(list(preroll) + [block])
                    log(f"wake cmd capture: start ({'converse' if converse else 'await'} path)")
                    mode, deadline = "record", now + WAKE_GUARD_S
                else:
                    preroll.append(block)
                continue

            if speech:
                if not speaking:
                    speaking, head_tested = True, False
                    utter = list(preroll)          
                utter.append(block)
                if not head_tested and len(utter) >= head_blocks:
                    head_tested = True
                    head = np.concatenate(utter[:head_blocks]).astype(np.float32)
                    if match_wake(self._decode_clip(head), self._phrases):
                        emit({"event": "wake", "state": "triggered",
                              "phrase": self._phrases[0] if self._phrases else ""})
                        self._start_command_capture(utter)   
                        log("wake cmd capture: start (same-breath path)")
                        emit({"event": "wake", "state": "awaiting"})
                        mode, expect_wake, deadline = "record", True, now + WAKE_GUARD_S
                        utter = []
                    else:
                        mode, utter = "dead", []     
            else:
                preroll.append(block)
                if speaking:
                    kind, cmd = self._detect_short(utter)
                    if kind == "command":
                        emit({"event": "command", "text": cmd})
                        self._emit_listening()
                        go_scan()
                    elif kind == "await":
                        emit({"event": "wake", "state": "awaiting"})
                        mode, expect_wake, deadline = "await", False, now + WAKE_GUARD_S
                        speaking, utter = False, []
                    else:
                        speaking, utter = False, []

        try:
            self._cmd_rec.cancel()
        except Exception:
            pass


    def _next_block(self, timeout):
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None


class AudioHub:
    """Owns the ONE and only microphone InputStream. Every captured block is
    routed in the audio callback to whoever should hear it right now:
      - push-to-talk recording in progress  -> recorder.feed(block)
      - else wake mode on                    -> wake.feed(block)
    Because the stream is opened/closed only on genuine transitions (and stays
    open across the wake<->record hand-off), starting push-to-talk while wake is
    listening is a pure flag flip — no stream OPEN/CLOSE on the hand-off (a cheap
    non-draining Pa_IsStreamActive state check may run, but never an open/close) —
    which is what eliminates the two-simultaneous-streams hang that SIGTERM'd the
    extension. All open/close calls happen under _lock from request handlers
    only when the device is otherwise idle, never main-thread-blocking mid-decode."""

    def __init__(self, recorder, wake):
        self._rec_obj = recorder
        self._wake = wake
        self._stream = None
        self._rec = False           
        self._wake_on = False       
        self._monitor_on = False
        self._mon_peak = 0.0
        self._mon_rms = 0.0
        self.capture_sid = ""
        self._mon_thread = None
        self._lock = threading.Lock()
        self._last_cb = 0.0   # monotonic do último callback de áudio (detecta stream 'ativo' mas morto)
        self._last_default_id = _default_capture_id()   # baseline p/ seguir o padrão do sistema

    def _callback(self, indata, frames, time_info, status):  
        self._last_cb = _now()   # heartbeat: um device vivo entrega blocos continuamente (mesmo em silêncio)
        block = indata[:, 0].copy()
        if self._rec:
            self._rec_obj.feed(block, status)
        elif self._wake_on:
            self._wake.feed(block)
        if self._monitor_on and not self._rec and block.size:
            p = float(np.max(np.abs(block)))
            if p > self._mon_peak:
                self._mon_peak = p
            self._mon_rms = float(np.sqrt(np.mean(block * block)))

    def _adopt_or_follow_default(self):
        """(sob lock, stream FECHADO) Se o padrão do Windows mudou, re-scaneia o
        PortAudio para que device=None capture o NOVO padrão. Adota o baseline sem
        re-scan quando ainda não há um. No-op fora do modo padrão. Devolve True se
        re-scaneou."""
        cur = _default_capture_id()
        if SELECTED_MIC is None and cur is not None and self._last_default_id is None:
            self._last_default_id = cur   # primeiro baseline conhecido: adota sem re-scan
            return False
        if _default_follow_should_reinit(SELECTED_MIC, cur, self._last_default_id):
            if _reinit_portaudio():
                self._last_default_id = cur
                return True
        return False

    def _ensure_open(self):
        if self._stream is not None:
            # Device removido no MEIO (ex.: bateria do bluetooth acabou). Dois sinais de MORTE:
            #  (a) o PortAudio aborta o stream -> `.active` vira False; MAS alguns host APIs do
            #  Windows mantêm `.active`=True e só PARAM de entregar blocos -> (b) sem callback há
            #  > _MIC_STALL_S. Qualquer um dos dois = morto -> descarta e reabre (fallback ao padrão).
            try:
                active = bool(getattr(self._stream, "active", True))
            except Exception:
                active = False
            stalled = (self._last_cb > 0.0 and (_now() - self._last_cb) > _MIC_STALL_S)
            if active and not stalled:
                return
            self._ensure_closed(dead=True)
        import sounddevice as sd
        self._adopt_or_follow_default()

        def _open(dev):
            s = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                blocksize=WAKE_BLOCK, callback=self._callback, device=dev)
            try:
                s.start()
            except Exception:
                try:
                    s.close()   # não vaza o stream nativo se start() falhar (device sumiu na janela open->start; em modo padrão não há reinit p/ varrer)
                except Exception:
                    pass
                raise
            return s

        self._stream, fell_back = _open_input_stream(
            _open, SELECTED_MIC, self._reinit_for_default_fallback, log)
        self._last_cb = _now()   # baseline: um stream recém-aberto não conta como 'stalled' até faltar callback
        if fell_back:
            abandoned = SELECTED_MIC   # o pino que MORREU (ainda não resetado) — vai no evento p/ o extension não pisar numa reseleção
            set_selected_mic(None)     # descarta o pino SÓ DEPOIS que o padrão abriu de fato (numa queda total a escolha é preservada)
            self._notify_mic_fallback(abandoned)

    def _reinit_for_default_fallback(self):
        """Pré-abertura do fallback: re-scaneia o PortAudio p/ device=None resolver o padrão
        ATUAL do Windows (o selecionado sumiu). NÃO descarta o pino — isso só ocorre se o
        padrão ABRIR de fato (senão, numa queda TOTAL, a escolha do usuário é preservada)."""
        if _reinit_portaudio():
            self._last_default_id = _default_capture_id()

    def _notify_mic_fallback(self, from_index=None):
        """Avisa a UI (não-fatal): o seletor volta p/ 'Padrão do Windows' (mics.current
        = None) e um evento 'mic-fallback' informa o motivo. `from` = o índice que MORREU,
        p/ o extension limpar o pino persistido SÓ se ainda for esse (não pisar numa
        reseleção do usuário sob flapping do device). Best-effort — nunca levanta, e mesmo
        que 'mic-fallback' não seja repassado, o 'mics' já corrige o seletor."""
        try:
            emit({"event": "mic-fallback", "to": "default", "from": from_index})
        except Exception:
            pass
        try:
            emit({"event": "mics", **list_mics()})
        except Exception:
            pass

    def _ensure_closed(self, dead=False):
        if self._stream is None:
            return
        try:
            if not dead:
                # AUTO-detecta MORTE p/ QUALQUER caller (reopen/stop_record/set_wake/set_monitor,
                # não só o _ensure_open): se o device sumiu, stop() DRENA e pode TRAVAR sob o
                # hub._lock -> BRICA o worker (o loop de stdin fica preso). Só drena com stop()
                # um stream comprovadamente VIVO; um morto/stalled é ABORTADO (descarta na hora).
                try:
                    active = bool(getattr(self._stream, "active", True))
                except Exception:
                    active = False
                stalled = (self._last_cb > 0.0 and (_now() - self._last_cb) > _MIC_STALL_S)
                dead = (not active) or stalled
            if dead:
                try:
                    self._stream.abort()
                except Exception:
                    pass
            else:
                self._stream.stop()
            self._stream.close()
        except Exception as exc:
            log(f"hub stream close error: {exc}")
        self._stream = None

    def reopen(self):
        """Reabre o stream no dispositivo atual (apos troca de microfone)."""
        with self._lock:
            keep = self._rec or self._wake_on or self._monitor_on
            self._ensure_closed()
            if keep:
                self._ensure_open()

    def refresh_and_reopen(self):
        """Segue uma TROCA do padrão do Windows (só no modo padrão). Re-scaneia o
        PortAudio e reabre o stream compartilhado para que captura e enumeração
        passem a usar o NOVO padrão. SEGURO: nunca roda no meio de um push-to-talk
        (devolve False) e só re-inicia o PortAudio com o stream FECHADO. Devolve
        True quando de fato seguiu a troca."""
        with self._lock:
            if self._rec:
                return False   # nunca interrompe uma gravação ativa
            cur = _default_capture_id()
            if SELECTED_MIC is None and cur is not None and self._last_default_id is None:
                self._last_default_id = cur   # adota baseline sem re-scan
                return False
            if not _default_follow_should_reinit(SELECTED_MIC, cur, self._last_default_id):
                return False
            keep = self._wake_on or self._monitor_on
            self._ensure_closed()
            did = _reinit_portaudio()
            if did:
                self._last_default_id = cur   # avança o baseline no sucesso deste re-scan
            if keep:
                # se o re-scan acima falhou, _ensure_open pode re-scanear e avançar o baseline aqui
                self._ensure_open()
            # resultado EFETIVO: seguiu o novo padrão por QUALQUER um dos re-scans (p/ o mic_monitor
            # reemitir 'mics' e a UI trocar o nome). Baseline intocado numa falha total -> reintenta.
            return self._last_default_id == cur

    def start_record(self):
        """Begin push-to-talk. If wake was listening the stream is already open,
        so this only suspends wake + flips the rec flag + starts the recorder's
        decode threads — no audio device call -> can never hang the main thread."""
        with self._lock:
            self._wake.suspend()        
            self._rec = True
            try:
                self._ensure_open()         
                self._rec_obj.begin()
            except Exception:
                # abrir falhou (nem o padrão do Windows abriu): NÃO deixa o hub preso em
                # _rec=True — senão o refresh_and_reopen (auto-recuperação de 3s) recusa p/
                # sempre (guard `if self._rec`) e o hub fica mudo até um stop/start manual.
                self._rec = False
                if self._wake_on:
                    try:
                        self._wake.resume()
                    except Exception:
                        pass
                raise

    def stop_record(self):
        with self._lock:
            res = self._rec_obj.stop()  
            self._rec = False
            if self._wake_on:
                self._wake.resume()     
            elif not self._monitor_on:
                self._ensure_closed()
            return res

    def cancel_record(self):
        with self._lock:
            self._rec_obj.cancel()
            self._rec = False
            if self._wake_on:
                self._wake.resume()
            elif not self._monitor_on:
                self._ensure_closed()

    def set_wake(self, on, phrases=None):
        with self._lock:
            if phrases:
                self._wake.set_phrases(phrases)
            on = bool(on)
            if on == self._wake_on:
                return
            self._wake_on = on
            if on:
                if not self._rec:
                    self._ensure_open()
                self._wake.enable()
            else:
                self._wake.disable()
                if not self._rec and not self._monitor_on:
                    self._ensure_closed()

    def _monitor_loop(self):
        last_rms = last_peak = -1.0
        while self._monitor_on:
            time.sleep(0.15)
            if not self._monitor_on:
                break
            peak = round(self._mon_peak, 5)
            rms = round(self._mon_rms, 5)
            self._mon_peak = 0.0   # sempre reseta a janela (o VU decai); emite só se mudou
            if _meter_should_emit(rms, peak, last_rms, last_peak):
                emit({"event": "monitor_level", "peak": peak, "rms": rms})
                last_rms, last_peak = rms, peak

    def set_monitor(self, on):
        """At-rest VU monitor: opens the shared mic stream (only if idle) to emit
        throttled monitor_level events so the UI can show input level BEFORE
        recording. Never decodes/buffers/transcribes. Reuses the stream if wake or
        recording already owns it. Stops + closes when idle."""
        with self._lock:
            on = bool(on)
            if on == self._monitor_on:
                return
            self._monitor_on = on
            if on:
                self._mon_peak = 0.0
                if not self._rec and not self._wake_on:
                    self._ensure_open()
                self._mon_thread = threading.Thread(target=self._monitor_loop, daemon=True)
                self._mon_thread.start()
            else:
                if not self._rec and not self._wake_on:
                    self._ensure_closed()

    def arm_converse(self, timeout_s):
        """Arm the wake listener's one-shot conversation onset window. No-op while
        push-to-talk owns the mic or wake is off — only meaningful right after the
        assistant finished speaking, so the user can reply without the wake phrase."""
        with self._lock:
            if self._wake_on and not self._rec:
                self._wake.arm_converse(timeout_s)


# Segmentação por pausa (frame_rms/cut_point/segment_audio) foi APOSENTADA: agora vem do SDK
# vendorizado — StreamSegmenter/cut_point/frame_rms em vox_stream.py (byte-idêntico ao canônico).
# O caminho ao vivo usa StreamingTranscriber (segmenta+STT numa thread); o transcribe_file usa
# StreamSegmenter direto. Removidas as cópias locais para não divergir do canônico.


def detect_mic():
    """(ok, name, reason) do dispositivo de entrada padrão. ok=False quando não há
    microfone utilizável — a UI então bloqueia a gravação e mostra a causa."""
    try:
        import sounddevice as sd
        with _PA_LOCK:   # exclui um Pa_Terminate concorrente (reinit) durante a enumeração
            if SELECTED_MIC is not None:
                d = sd.query_devices(SELECTED_MIC, kind="input")
            else:
                d = sd.query_devices(kind="input")
        if not d or int(d.get("max_input_channels", 0)) < 1:
            return False, "", "Nenhum microfone de entrada disponível."
        return True, str(d.get("name", "") or ""), ""
    except Exception as exc:
        return False, "", f"Microfone indisponível: {exc}"


def list_mics():
    """Lista os microfones de entrada (deduplicados por nome), marcando o atual
    e o padrão do sistema, para o usuário escolher na UI."""
    try:
        import sounddevice as sd
    except Exception as exc:
        return {"devices": [], "current": SELECTED_MIC, "default": None, "error": str(exc)}
    default_in = None
    with _PA_LOCK:   # exclui um Pa_Terminate concorrente (reinit) durante a enumeração
        try:
            dd = sd.default.device
            default_in = int(dd[0]) if hasattr(dd, "__getitem__") else int(dd)
        except Exception:
            default_in = None
        try:
            devs = list(sd.query_devices())
            hapis = list(sd.query_hostapis())
        except Exception as exc:
            return {"devices": [], "current": SELECTED_MIC, "default": default_in, "error": str(exc)}
    # Dedup/format delegado ao SDK vendorizado (vox_audio_devices): trata truncação MME (31 chars)
    # e preferência de host API (WASAPI/DirectSound antes de MME/WDM-KS) — melhor que o dedup por
    # nome-cru local. A ENUMERAÇÃO (sob _PA_LOCK) e o lifecycle continuam meus; enriqueço com
    # channels (que o modelo puro do SDK não carrega) para preservar o shape da UI.
    out = []
    for e in vox_audio_devices.list_input_devices(devices=devs, default_index=default_in, hostapis=hapis):
        d = devs[e["index"]] if 0 <= e["index"] < len(devs) else {}
        out.append({"index": e["index"], "name": e["name"],
                    "channels": int(d.get("max_input_channels", 0)) if isinstance(d, dict) else 0,
                    "is_default": bool(e["is_default"])})
    return {"devices": out, "current": SELECTED_MIC, "default": default_in}


def mic_monitor():
    """Vigia o microfone e emite 'mic' só quando o estado muda (conectar/desconectar),
    para a UI refletir hardware em tempo real sem custo. Também SEGUE o padrão do
    Windows: se o endpoint de captura padrão mudou (sinal MMDevice ~2ms), re-scaneia
    o PortAudio (só no modo padrão, com o hub ocioso ou sem gravar) e reemite a lista
    para a UI trocar o nome/seleção sozinha."""
    last = None
    while True:
        hub = HUB
        if hub is not None:
            try:
                if hub.refresh_and_reopen():
                    emit({"event": "mics", **list_mics()})
            except Exception as exc:
                log(f"default-follow refresh failed: {exc}")
        ok, name, reason = detect_mic()
        cur = (ok, name)
        if cur != last:
            emit({"event": "mic", "ok": ok, "name": name, "reason": reason})
            last = cur
        time.sleep(3.0)


# O motor (via SDK) levanta vox_sdk.VoxEngineError. O worker REEXPORTA essa MESMA classe
# (não uma própria) — senão o `except VoxEngineError` do worker nunca casaria o erro real
# do cliente do SDK, matando a reconexão e deixando o STT falhar MUDO (bug pego no gate).
# Reexportado como nome de módulo p/ os call sites (`raise VoxEngineError(...)`, os testes
# e `except VoxEngineError`) continuarem iguais, agora unificados com a classe do SDK.
VoxEngineError = vox_sdk.VoxEngineError


class _VoxBridge:
    """Ponte do worker para o motor único (vox-engine) via SDK VENDORIZADO.

    NÃO reimplementa mais o ciclo de vida do motor (instalar/atualizar/subir/lock):
    isso é do SDK oficial (``vox_sdk``), a FONTE ÚNICA da verdade. O SDK, no primeiro
    turno, instala/atualiza e RECICLA um daemon velho e ocioso (derruba+sobe a versão
    nova, cujo hook do daemon sobe o ditado junto), tudo coordenado por um lock
    CROSS-CONSUMER (``%LOCALAPPDATA%\\vox-engine\\.install.lock``) que sincroniza
    voice-chat + Action + Hermes entre si.

    Este wrapper só: (a) delega o boot ao ``ensure_vox_detailed`` (fast-fail no decode
    via ``ensure_vox`` reuse-only); (b) expõe ``info``/``transcribe``/``synthesize`` no
    formato que o worker já usa; (c) PRESERVA a auto-reconexão no pipe ocioso stale — o
    SDK fecha o handle e levanta ``VoxEngineError`` na falha de ESCRITA; o worker
    reconecta e repete 1x SÓ nesse caso (repetir uma falha de LEITURA reprocessaria um
    request que o motor já recebeu, ex.: transcribe).

    Erros sobem ALTOS como :class:`VoxEngineError` — sem fallback silencioso, sem STT
    local (regra do projeto: fallback automático mascara problema e cria ponto de falha).
    """

    def __init__(self, pipe=VOX_PIPE, profile=VOX_PROFILE, status_cb=None):
        self._pipe = pipe
        self._profile = profile
        self._session = "voice-chat"
        self._status_cb = status_cb
        self._client = None                  # vox_sdk.VoxClient conectado, ou None
        self._boot_lock = threading.Lock()   # serializa boot/instalação (1 por vez)
        self._last_error = None              # última falha DETALHADA p/ info() surfaçar ALTO

    def _status(self, msg, busy=False):
        """Sinal de progresso VISÍVEL (instalação de 1ª vez leva minutos). Best-effort:
        sempre loga; se houver callback, emite p/ a UI (evento 'loading', NÃO 'error').
        ``busy=True`` marca uma fase LONGA e legítima (install/update) — o watchdog do
        Node NÃO auto-reinicia o worker nela (matar no meio orfanaria o instalador)."""
        log(f"vox-engine: {msg}")
        cb = self._status_cb
        if cb is not None:
            try:
                cb(msg, busy)
            except Exception as exc:   # noqa: BLE001 — status é best-effort
                log(f"vox-engine: status_cb falhou: {exc}")

    @property
    def _connected(self):
        c = self._client
        return c is not None and c.connected

    def ensure(self, boot_timeout=60.0, connect_ms=0):
        """Garante um cliente conectado. NUNCA levanta (True/False).

        - ``boot_timeout > 0`` (BOOT): delega ao SDK ``ensure_vox_detailed`` — instala/
          atualiza/RECICLA e sobe o daemon (o hook do ditado sobe junto). Serializado e
          com progresso VISÍVEL (a instalação é silenciosa por minutos).
        - ``boot_timeout <= 0`` (DECODE fast-fail): só REUSA se o pipe já está no ar
          (``autostart``/``auto_update``/``recycle_stale`` desligados) — NUNCA instala
          nem bloqueia o thread de decode/wake; acquire NÃO-bloqueante (se o boot está
          segurando o lock instalando, retorna False na hora). ``connect_ms`` controla o
          timeout de conexão: 0 no PROBE de decode (daemon fora -> fast-fail, sem stall de
          ~2s), mas um CUSHION pequeno na RECONEXÃO (daemon UP -> absorve ERROR_PIPE_BUSY
          transitório do pipe compartilhado)."""
        if self._connected:
            return True
        if boot_timeout <= 0:
            if not self._boot_lock.acquire(blocking=False):
                return False
            try:
                if self._connected:
                    return True
                self._client = vox_sdk.ensure_vox(
                    self._pipe, autostart=False, auto_update=False,
                    recycle_stale=False, with_translation=False,
                    connect_timeout_ms=connect_ms)
                return self._connected
            except Exception as exc:   # noqa: BLE001 — fast-fail NUNCA levanta
                log(f"vox-engine ensure(fast) erro: {exc}")
                return False
            finally:
                self._boot_lock.release()
        with self._boot_lock:
            if self._connected:
                return True
            self._status("Conectando ao motor de voz…")
            try:
                res = vox_sdk.ensure_vox_detailed(
                    self._pipe, autostart=True, auto_update=True,
                    recycle_stale=True, with_translation=True,
                    boot_timeout_ms=int(max(0.0, boot_timeout) * 1000))
            except Exception as exc:   # noqa: BLE001 — blindagem total: vira _last_error/False
                self._last_error = VoxEngineError(f"falha ao subir o motor: {exc}")
                log(f"vox-engine: subida do motor falhou: {exc}")
                return False
            self._client = res.get("client")
            action = res.get("action")
            if self._connected:
                self._last_error = None
                iv = res.get("installedVersion")
                self._status(f"Motor de voz pronto (v{iv or '?'}; ação={action}).")
                return True
            self._last_error = VoxEngineError(
                f"motor de voz (vox-engine) indisponível (ação={action})")
            return False

    @staticmethod
    def _is_send_failure(exc):
        """True se a falha foi de ESCRITA (o request NÃO chegou ao motor — pipe ocioso
        ficou stale, ex.: [Errno 22]/EINVAL após ~40min). SÓ isso pode ser reconectado+
        repetido com segurança; repetir uma falha de LEITURA reprocessaria um request que
        o motor JÁ recebeu. O SDK marca a falha de escrita com o PREFIXO "falha ao enviar
        ao motor". Ancorar no PREFIXO (não substring solta) evita classificar como ESCRITA
        um erro pós-resposta cujo {message} do daemon contenha a frase por acaso."""
        return str(exc).startswith("falha ao enviar ao motor")

    def _reconnect_fast(self):
        """Descarta o handle morto e reconecta SEM instalar (o daemon segue no ar; só o
        handle ocioso ficou stale). Usa um CUSHION de conexão pequeno (não o 0ms do probe
        de decode): a reconexão acontece com o daemon UP, então ~250ms (~2-3 tentativas de
        open a 0.1s no SDK) absorve um ERROR_PIPE_BUSY transitório do pipe COMPARTILHADO
        (voice-chat + Action + Hermes) sem reintroduzir o stall de ~2s. True se reconectou."""
        c = self._client
        if c is not None:
            try:
                c.close()
            except Exception:   # noqa: BLE001
                pass
        self._client = None
        return self.ensure(boot_timeout=0.0, connect_ms=_RECONNECT_CONNECT_MS)

    def _call(self, op, boot_timeout=0.0):
        """Garante o cliente (boot ou fast-fail) e roda ``op(client)``. Numa falha de
        ESCRITA (pipe stale), reconecta e repete 1x SÓ. Qualquer outra falha (leitura/
        framing/timeout/indisponível) sobe ALTA sem retry — sem loop, sem erro mudo."""
        if not self.ensure(boot_timeout=boot_timeout):
            raise self._last_error or VoxEngineError("motor de voz (vox-engine) indisponível")
        client = self._client
        if client is None:
            raise VoxEngineError("conexão com o motor caiu")
        try:
            return op(client)
        except VoxEngineError as exc:
            # O SDK fecha a conexão em QUALQUER falha. REPETE agora SÓ na de ESCRITA
            # (idempotente-seguro: o frame comprovadamente NÃO chegou ao motor). Leitura/
            # timeout/"conexão caiu" NÃO repete (o motor pode ter processado -> duplicaria),
            # mas DESCARTA o cliente morto p/ a PRÓXIMA chamada RECONECTAR (reuse-only) —
            # nunca fica preso num handle morto (evita mudo permanente até restart; achado
            # de robustez do dono do SDK). Um daemon que recicle graciosamente (ack+fecha)
            # cai na trilha de ESCRITA no próximo request e reconecta+repete transparente.
            if self._is_send_failure(exc) and self._reconnect_fast():
                nc = self._client
                if nc is None:
                    raise
                return op(nc)
            self._client = None
            raise

    def info(self, boot_timeout=60.0):
        """{model, provider, version, stt_ready, ...} do motor, ou levanta VoxEngineError
        com a mensagem DETALHADA capturada no boot (erro ALTO e ÚTIL na UI)."""
        try:
            return self._call(lambda c: c.info(), boot_timeout=boot_timeout)
        except VoxEngineError:
            raise
        except Exception as exc:   # noqa: BLE001 — QUALQUER coisa → ALTO (sem mudo)
            raise VoxEngineError(f"falha ao consultar o motor: {exc}") from exc

    def transcribe(self, seg, language):
        """seg (float32 16k numpy) -> texto (str). Fast-fail (boot_timeout=0): não instala
        nem trava o thread de decode. LEVANTA :class:`VoxEngineError` em qualquer falha —
        sem fallback silencioso. Perfil ``dictation`` (turbo) escolhido pelo motor."""
        return self._call(
            lambda c: c.transcribe(seg, lang=language or "", session=self._session,
                                   profile=self._profile),
            boot_timeout=0.0)

    def synthesize(self, text, voice=None, speed=1.0):
        """(texto) -> (samples float32 numpy, sample_rate:int) via {cmd:"tts"} do motor
        único. Fast-fail. Voz por NOME quando definida; vazio => voz padrão do motor.
        LEVANTA :class:`VoxEngineError` em qualquer falha — sem fallback mudo."""
        h, samples = self._call(
            lambda c: c.tts(text, voice=voice or "", speed=float(speed or 1.0),
                            session=self._session, timeout=max(VOX_REQ_TIMEOUT, 120.0)),
            boot_timeout=0.0)
        sr = int(h.get("sample_rate") or 22050)
        return samples, sr

    def close(self):
        c = self._client
        self._client = None
        if c is not None:
            try:
                c.close()
            except Exception:   # noqa: BLE001
                pass


def main():
    state = {"language": (os.environ.get("VOICE_LANG", "pt").strip() or "pt"),
             "model": VOX_PROFILE}
    recorder = Recorder()

    def _vox_status(msg, busy=False):
        """Progresso VISÍVEL do motor (ex.: instalação de 1ª vez, que leva minutos):
        evento 'loading' (NÃO 'error') — a UI mostra estado de carregamento com a
        mensagem, sem acender o erro fatal nem incrementar o contador de falhas.
        Garante que a UI NÃO fique muda enquanto o install baixa deps/CUDA.

        ``busy`` marca uma operação LONGA e LEGÍTIMA (install/update, silenciosa por
        minutos): a ponte Node NÃO auto-reinicia o worker nessa fase (o self-heal só
        vale p/ um wedge MUDO fora de install)."""
        emit({"event": "loading", "source": "vox-engine", "msg": msg, "busy": bool(busy)})

    vox = _VoxBridge(status_cb=_vox_status)

    _last_vox_err = [0.0]
    _vox_fail = [0]            # falhas consecutivas do motor (reset ao recuperar)
    _vox_fatal_shown = [False]  # já sinalizou motor-down persistente?
    _vox_state_lock = threading.Lock()  # RMW dos contadores é de várias threads (LOW-4)

    def _emit_vox_error(msg, force_fatal=False):
        """Erro de motor ALTO e VISÍVEL — NUNCA mudo. Uma falha isolada vira toast;
        falha SUSTENTADA (>=2 seguidas, ou boot) escala p/ estado FATAL persistente
        (motor-down na UI) mostrado 1x. Enquanto fatal, evita spam mas segue visível
        (o estado já está aceso), então nenhum surto fica invisível. Serializado p/
        que o read-modify-write dos contadores não perca escalada entre threads."""
        with _vox_state_lock:
            _vox_fail[0] += 1
            n = _vox_fail[0]
            now = time.time()
            fatal = force_fatal or n >= 2
            if fatal and not _vox_fatal_shown[0]:
                _vox_fatal_shown[0] = True
                _last_vox_err[0] = now
                ev = {"event": "error", "source": "vox-engine", "fatal": True,
                      "msg": f"Motor de voz indisponível: {msg}"}
            elif fatal and now - _last_vox_err[0] > 3.0:
                _last_vox_err[0] = now
                ev = {"event": "error", "source": "vox-engine", "fatal": False,
                      "msg": f"Motor de voz ainda indisponível: {msg}"}
            elif not fatal:
                _last_vox_err[0] = now
                ev = {"event": "error", "source": "vox-engine", "fatal": False,
                      "msg": f"Motor de voz indisponível: {msg}"}
            else:
                ev = None
        log(f"vox-engine ERRO #{n}: {msg}")
        if ev is not None:
            emit(ev)

    def _vox_recovered():
        """Motor respondeu de novo. Só reemite 'ready' se a UI foi realmente
        DERRUBADA (estado fatal aceso) — um blip isolado sub-fatal apenas zera o
        contador em silêncio, sem re-aquecer TTS / re-armar wake a cada falha (MED-3)."""
        with _vox_state_lock:
            was_down = _vox_fatal_shown[0]
            if not (_vox_fail[0] or was_down):
                return
            _vox_fail[0] = 0
            _vox_fatal_shown[0] = False
            if not was_down:
                return  # blip sub-fatal: reset silencioso, sem 'ready' espúrio
            ev = {"event": "ready", "model": state.get("model", VOX_PROFILE),
                  "source": "vox-engine", "language": state["language"],
                  "device": state.get("device", "?"),
                  "engine_version": state.get("engine_version", "?")}
        log("vox-engine recuperado")
        emit(ev)

    # O STT vem SÓ do vox-engine — sem recognizer local, sem fallback. Se o motor
    # falhar, erro ALTO na UI. O boot roda em background (não trava o loop de
    # comandos) e retenta; o 1º erro é fatal p/ a UI mostrar "motor indisponível",
    # e um 'ready' posterior recupera sozinho quando o motor sobe.
    log(f"vox-engine: motor único (pipe={VOX_PIPE}, profile={VOX_PROFILE}); sem fallback local")

    def _motor_boot():
        attempt = 0
        while True:
            try:
                nfo = vox.info()
                dev = nfo.get("provider") or "?"
                mdl = nfo.get("model") or VOX_PROFILE
                ver = nfo.get("version") or "?"
                state["device"] = dev
                state["model"] = mdl
                state["engine_version"] = ver
                log(f"vox-engine pronto (v{ver}, model={mdl}, device={dev})")
                with _vox_state_lock:
                    _vox_fail[0] = 0
                    _vox_fatal_shown[0] = False
                emit({"event": "ready", "model": mdl, "source": "vox-engine",
                      "language": state["language"], "device": dev,
                      "engine_version": ver})
                emit(voices_event(nfo))
                return
            except VoxEngineError as exc:
                attempt += 1
                _emit_vox_error(f"{exc} (tentativa {attempt})", force_fatal=True)
                if attempt >= 12:
                    log("vox-engine: boot desistiu após várias tentativas; segue em erro")
                    return
                time.sleep(min(5.0, float(attempt)))
    threading.Thread(target=_motor_boot, daemon=True).start()

    _mok, _mname, _mreason = detect_mic()
    emit({"event": "mic", "ok": _mok, "name": _mname, "reason": _mreason})
    emit({"event": "mics", **list_mics()})
    threading.Thread(target=mic_monitor, daemon=True).start()
    start_focus_poller()   # emite appFocus (foco do app) na mudança; a UI gateia o áudio conforme o setting

    def _prefetch_vad():
        try:
            ensure_vad_model()
        except Exception as exc:
            log(f"vad prefetch failed (wake will retry when enabled): {exc}")
    threading.Thread(target=_prefetch_vad, daemon=True).start()

    def decode_seg(seg, raise_on_motor_fail=False):
        """Decode one <=28s segment to text. Serialized so the recorder's
        background streaming thread and its final-tail pass never overlap.
        Also defers (bounded) while a TTS synth is running so decode + synth
        never saturate every core and starve the Node event loop.

        MOTOR-ONLY: o STT vem SÓ do vox-engine — sem fallback local, sem erro mudo.
        Falha do motor → erro ALTO na UI e o segmento é descartado (o worker segue
        vivo e reconecta no próximo).

        ``raise_on_motor_fail`` (usado por transcribe_file) propaga a
        :class:`VoxEngineError` p/ o chamador reportar ``ok:false`` — em vez de
        um "" indistinguível de silêncio (falha muda na fronteira da API).
        """
        TTS_IDLE.wait(timeout=6.0)
        try:
            text = vox.transcribe(seg, state["language"])
            _vox_recovered()   # motor respondeu: limpa estado de erro se havia
            return text
        except VoxEngineError as exc:
            _emit_vox_error(str(exc))
            if raise_on_motor_fail:
                raise
            return ""

    recorder.set_decoder(decode_seg)

    wake = WakeListener(decode_seg, WAKE_PHRASES)
    hub = AudioHub(recorder, wake)
    global HUB
    HUB = hub   # publica p/ o mic_monitor seguir o padrão do Windows

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log(f"bad json: {raw[:120]}")
            continue
        cmd = msg.get("cmd")
        try:
            if cmd == "start":
                hub.capture_sid = msg.get("sid", "") or ""
                hub.start_record()
            elif cmd == "stop":
                emit({"event": "status", "state": "transcribing"})
                res = hub.stop_record()
                _sid = getattr(hub, "capture_sid", "") or ""
                for _ev in build_stop_events(res, _sid, MIC_SILENCE_PEAK, detect_mic):
                    emit(_ev)
            elif cmd == "cancel":
                hub.cancel_record()
            elif cmd == "ping":
                emit({"event": "pong"})
            elif cmd == "list_mics":
                emit({"event": "mics", **list_mics()})
            elif cmd == "set_mic":
                set_selected_mic(msg.get("device"))
                try:
                    hub.reopen()
                except Exception as exc:
                    log(f"reopen after set_mic failed: {exc}")
                _mok, _mname, _mreason = detect_mic()
                emit({"event": "mic", "ok": _mok, "name": _mname, "reason": _mreason})
                emit({"event": "mics", **list_mics()})
            elif cmd == "set":
                new_lang = (msg.get("language") or state["language"]).strip()
                if new_lang != state["language"]:
                    # Motor único: nada de recognizer local. A língua vai ao motor na
                    # transcrição; o modelo é decidido pelo perfil do motor.
                    state["language"] = new_lang
                    emit({"event": "ready", "model": state["model"], "source": "vox-engine",
                          "language": new_lang, "device": state.get("device", "?")})
            elif cmd == "tts":
                synthesize_tts(msg, vox.synthesize)
            elif cmd == "tts_voice":
                set_tts_voice(msg.get("voice"))
            elif cmd == "list_voices":
                # Catálogo de vozes SÓ do motor (fonte única). Fast-fail: não bloqueia o
                # loop esperando o daemon subir; se falhar, vai lista vazia + ok:false
                # (a UI mostra 'indisponível' ALTO, sem lista local mascarando o erro).
                try:
                    ev = voices_event(vox.info(boot_timeout=0.0))
                except VoxEngineError as exc:
                    ev = {"event": "voices", "voices": [], "default_voice": None,
                          "ok": False, "msg": str(exc)}
                emit(ev)
            elif cmd == "wake":
                phrases = ([str(p) for p in msg["phrases"] if str(p).strip()]
                           if msg.get("phrases") else None)
                hub.set_wake(msg.get("on"), phrases)
            elif cmd == "converse":
                hub.arm_converse(float(msg.get("timeoutMs", 3000)) / 1000.0)
            elif cmd == "monitor":
                hub.set_monitor(msg.get("on"))
            elif cmd == "transcribe_file":
                # Offline one-shot: transcribe a WAV file (no mic). Reuses the same
                # recognizer via decode_seg + segment_audio. Additive — does not
                # touch the live capture pipeline. Used by sibling extensions that
                # borrow the voice engine (e.g. copilot-remote) over /transcribe.
                rid = msg.get("id")
                fpath = msg.get("path")
                try:
                    with wave.open(fpath, "rb") as wf:
                        nch = wf.getnchannels()
                        sw = wf.getsampwidth()
                        fr = wf.getframerate()
                        raw = wf.readframes(wf.getnframes())
                    if sw == 2:
                        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    elif sw == 4:
                        arr = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
                    elif sw == 1:
                        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
                    else:
                        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    if nch > 1:
                        arr = arr.reshape(-1, nch).mean(axis=1).astype(np.float32)
                    if fr != SAMPLE_RATE and arr.size:
                        n_out = int(round(arr.size * SAMPLE_RATE / float(fr)))
                        if n_out > 0:
                            xp = np.linspace(0.0, 1.0, arr.size, dtype=np.float64)
                            xq = np.linspace(0.0, 1.0, n_out, dtype=np.float64)
                            arr = np.interp(xq, xp, arr).astype(np.float32)
                    _fseg = StreamSegmenter(sr=SAMPLE_RATE)
                    _file_segs = _fseg.feed(arr) + _fseg.flush()
                    parts = [decode_seg(seg, raise_on_motor_fail=True)
                             for seg in _file_segs]
                    text = " ".join(p for p in parts if p).strip()
                    emit({"event": "transcribed", "id": rid, "ok": True, "text": text})
                except VoxEngineError as exc:
                    # Motor caiu no meio: NÃO reporta sucesso vazio (que seria
                    # indistinguível de silêncio). ok:false + erro já emitido alto.
                    log(f"transcribe_file: motor indisponível: {exc}")
                    emit({"event": "transcribed", "id": rid, "ok": False,
                          "msg": f"motor de voz indisponível: {exc}"})
                except Exception as exc:
                    log("transcribe_file error:\n" + traceback.format_exc())
                    emit({"event": "transcribed", "id": rid, "ok": False, "msg": str(exc)})
            elif cmd == "shutdown":
                hub.set_monitor(False)
                hub.set_wake(False)
                break
            else:
                log(f"unknown cmd: {cmd}")
        except Exception as exc:
            log("command error:\n" + traceback.format_exc())
            emit({"event": "error", "msg": str(exc)})

    log("worker exiting")


if __name__ == "__main__":
    main()
