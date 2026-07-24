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
import threading
import traceback
import wave
import vox_sdk
import vox_lifecycle
from capture_session import CaptureSession
from vox_capture_adapter import VoxPipeCaptureAdapter

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


# numpy + vox_stream + sounddevice + vox_audio_devices: TODOS fora do import do worker fino.
# O daemon faz captura/STT/TTS E a enumeração de device (vox.devices()); o worker não toca áudio
# local. numpy é LAZY só no transcribe_file (WAV offline raro) → fork ocioso = numpy-free E
# sounddevice-free (o ganho de RAM + fonte ÚNICA de seleção de mic, a mesma do ditado).

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
# Quanto o stop ESPERA o daemon transcrever a CAUDA antes de fechar a captura. Generoso de
# propósito (default 300s): o fim da fala NUNCA é descartado por um prazo curto. Configurável
# p/ quem quiser afrouxar/apertar. (Ver CaptureSession.close_timeout — era o bug do corte do fim.)
try:
    VOX_CAPTURE_CLOSE_TIMEOUT_S = float(os.environ.get("VOICE_CAPTURE_CLOSE_TIMEOUT_S", "300") or "300")
except ValueError:
    VOX_CAPTURE_CLOSE_TIMEOUT_S = 300.0
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
VOX = None   # cliente do motor (_VoxBridge), publicado pelo main() p/ detect_mic/list_mics reusarem devices()

def set_selected_mic(dev):
    global SELECTED_MIC
    if dev in (None, ""):
        SELECTED_MIC = None
    else:
        try:
            SELECTED_MIC = int(dev)
        except (TypeError, ValueError):
            SELECTED_MIC = dev   # nome (str) — capture_open aceita nome portável também


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
            wav, sr = synth(text, TTS_MODEL, speed)
        finally:
            TTS_IDLE.set()
        # WAV já vem NORMALIZADO da fonte (normalize=True no motor) e codificado — só grava os
        # bytes. Fade anti-clique fica no iframe (Web Audio ramp). ZERO numpy no worker.
        if out:
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            with open(out, "wb") as _f:
                _f.write(wav)
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


def detect_mic():
    """(ok, name, reason) do microfone — REUSA o motor (`vox.devices()`), SEM sounddevice
    local. ok=False quando o motor não vê microfone utilizável (a UI bloqueia a gravação)."""
    info = VOX.devices() if VOX is not None else {"input": [], "default_input": None}
    inputs = info.get("input") or []
    if not inputs:
        return False, "", "Nenhum microfone de entrada disponível."
    name = info.get("default_input") or inputs[0].get("name") or ""
    return True, str(name), ""


def list_mics():
    """Lista os microfones de entrada — REUSA o motor (`vox.devices()` → `list_input_devices`
    daemon-side, dedup-by-name, a MESMA fonte do ditado). SEM sounddevice local. `default` é o
    ÍNDICE do device marcado `is_default` (o iframe casa o default por índice)."""
    info = VOX.devices() if VOX is not None else {"input": [], "default_input": None}
    inputs = info.get("input") or []
    out = [{"index": d.get("index"), "name": d.get("name"),
            "channels": 1, "is_default": bool(d.get("is_default"))} for d in inputs]
    default_index = next((d.get("index") for d in inputs if d.get("is_default")), None)
    return {"devices": out, "current": SELECTED_MIC, "default": default_index}


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
                self._client = vox_lifecycle.ensure_vox(
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
                res = vox_lifecycle.ensure_vox_detailed(
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

    def capture_open(self, session, on_event, **opts):
        """Abre uma captura REMOTA (mic→transcrição no daemon). Conexão de pipe DEDICADA no
        SDK — NÃO usa o handle serializado do bridge (TTS/transcribe seguem em paralelo).
        Garante o motor no ar antes; se não subir, levanta ``CaptureError`` TIPADO p/ o
        adapter surfaçar como evento terminal (o worker trata tudo por ``events()``)."""
        if not self.ensure(boot_timeout=60.0):
            raise vox_sdk.CaptureError(
                "capture_unavailable",
                str(self._last_error) if self._last_error else "motor de voz indisponível")
        return self._client.capture_open(session, on_event, **opts)

    def devices(self, timeout=5.0):
        """Enumeração de dispositivos de ENTRADA REUSANDO o motor (`cmd:devices` →
        `list_input_devices` daemon-side, dedup-by-name, a MESMA fonte do ditado). O worker
        NÃO toca sounddevice. Fail-safe: motor fora/erro → `{input:[], default_input:None}`
        (a UI trata `[]` como 'sem mic'; nunca levanta nem derruba a conexão)."""
        if not self.ensure(boot_timeout=0.0):
            return {"input": [], "default_input": None}
        try:
            return self._call(lambda c: c.devices(timeout=timeout), boot_timeout=0.0)
        except VoxEngineError as exc:
            log(f"vox devices() indisponível: {exc}")
            return {"input": [], "default_input": None}

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
        """(texto) -> (wav_bytes, sample_rate:int) via {cmd:"tts"} do motor único, com a
        NORMALIZAÇÃO na FONTE (``normalize=True``) e o áudio já em WAV codificado — o cliente
        NÃO renormaliza nem toca numpy (o SDK só cria ndarray no fmt "pcm"). Fast-fail. Voz por
        NOME quando definida; vazio => voz padrão. LEVANTA :class:`VoxEngineError` em qualquer
        falha — sem fallback mudo. (O fade anti-clique fica no iframe, Web Audio ramp.)"""
        h, wav = self._call(
            lambda c: c.tts(text, fmt="wav", normalize=True, voice=voice or "",
                            speed=float(speed or 1.0), session=self._session,
                            timeout=max(VOX_REQ_TIMEOUT, 120.0)),
            boot_timeout=0.0)
        sr = int(h.get("sample_rate") or 22050)
        return wav, sr

    def close(self):
        c = self._client
        self._client = None
        if c is not None:
            try:
                c.close()
            except Exception:   # noqa: BLE001
                pass


def main():
    # GUARD (fail-loud): o worker FINO conecta ao daemon SEM numpy no boot — vox_stream/numpy sao
    # LAZY (so o transcribe_file offline os carrega). Se um import de vox_stream/numpy vazar pro
    # topo do worker, o boot FALHA AQUI, alto e claro, em vez de inflar a RAM ociosa em silencio.
    assert "numpy" not in sys.modules, "numpy carregado no boot do worker (vox_stream vazou no import de topo)"
    state = {"language": (os.environ.get("VOICE_LANG", "pt").strip() or "pt"),
             "model": VOX_PROFILE}
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
    global VOX
    VOX = vox   # publica o cliente p/ detect_mic/list_mics reusarem a enumeração do motor (devices())

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
    start_focus_poller()   # emite appFocus (foco do app) na mudança; a UI gateia o áudio conforme o setting


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

    # Worker FINO: a captura vai pro DAEMON (CapturePort) — sem InputStream/wake/monitor
    # local. decode_seg fica só p/ transcribe_file (WAV offline). PTT e mãos-livres usam o
    # MESMO fluxo start/stop/cancel; a diferença hold-vs-tap é só no iframe.
    #   profile=VOX_PROFILE ("dictation"): a captura ao vivo usa o MESMO perfil/modelo RÁPIDO do
    #     ditado (não o large-v3 default do daemon) — regra: nunca modelo pesado p/ ditar.
    #   close_timeout: o stop ESPERA a cauda transcrever em vez de descartá-la num prazo curto.
    capture = CaptureSession(
        VoxPipeCaptureAdapter(vox, profile=VOX_PROFILE, input_device=lambda: SELECTED_MIC),
        emit,
        close_timeout=VOX_CAPTURE_CLOSE_TIMEOUT_S,
    )
    capture_sid = [""]   # sid da captura atual (p/ carimbar build_stop_events no stop)

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
                capture_sid[0] = msg.get("sid", "") or ""
                capture.begin(capture_sid[0])
            elif cmd == "stop":
                emit({"event": "status", "state": "transcribing"})
                res = capture.stop()
                for _ev in build_stop_events(res, capture_sid[0], MIC_SILENCE_PEAK, detect_mic):
                    emit(_ev)
            elif cmd == "cancel":
                capture.cancel()
            elif cmd == "ping":
                emit({"event": "pong"})
            elif cmd == "list_mics":
                emit({"event": "mics", **list_mics()})
            elif cmd == "set_mic":
                # o daemon é dono do mic; a seleção é passada ao capture_open (input_device)
                # na próxima captura. Sem stream local p/ reabrir.
                set_selected_mic(msg.get("device"))
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
            elif cmd == "transcribe_file":
                # Offline one-shot: transcribe a WAV file (no mic). Reuses the same
                # recognizer via decode_seg + segment_audio. Additive — does not
                # touch the live capture pipeline. Used by sibling extensions that
                # borrow the voice engine (e.g. copilot-remote) over /transcribe.
                rid = msg.get("id")
                fpath = msg.get("path")
                try:
                    import numpy as np                      # LAZY: só o transcribe_file usa numpy
                    from vox_stream import StreamSegmenter   # LAZY: idem (segmentação do WAV offline)
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
                break
            elif cmd == "monitor":
                # idle-VU (monitor) NÃO existe no worker fino: o daemon só emite nível
                # DURANTE a captura (capture_level). No-op silencioso — sem "unknown cmd".
                pass
            else:
                log(f"unknown cmd: {cmd}")
        except Exception as exc:
            log("command error:\n" + traceback.format_exc())
            emit({"event": "error", "msg": str(exc)})

    log("worker exiting")


if __name__ == "__main__":
    main()
