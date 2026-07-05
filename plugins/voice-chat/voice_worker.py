#!/usr/bin/env python
"""Persistent voice worker for the Copilot voice-chat extension.

Responsibilities:
  - Capture microphone audio on demand (sounddevice, server-side).
  - Transcribe with a local Whisper model via sherpa-onnx (CPU by default; opt-in NVIDIA GPU).
  - Bootstrap-download the model from GitHub releases (HuggingFace is blocked by
    the corporate proxy; GitHub + truststore works).

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


def _ensure_soft_deps():
    """Best-effort install of NON-critical deps. Unlike _ensure_deps, a failure
    here NEVER kills the worker — these only sharpen optional features. psutil
    gives accurate PHYSICAL core counts for hardware-based model auto-selection;
    without it we degrade to logical cores (may over-estimate on hyperthreaded
    CPUs, but auto-selection still works safely)."""
    import importlib.util
    if importlib.util.find_spec("psutil") is not None:
        return
    import subprocess
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install",
                               "--disable-pip-version-check", "psutil"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=300)
        print("[worker] installed soft dep: psutil", file=sys.stderr, flush=True)
    except Exception as exc:  
        print(f"[worker] psutil unavailable (using logical-core fallback): {exc}",
              file=sys.stderr, flush=True)


_ensure_soft_deps()

import numpy as np

MODEL = os.environ.get("VOICE_MODEL", "base").strip() or "base"
MODEL_ROOT = os.environ.get("VOICE_MODEL_ROOT") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "artifacts", "models"
)

VALID_MODELS = ("auto", "tiny", "base", "small", "turbo", "large-v3")
PHYS_CORE_TURBO_THRESHOLD = 6


def _physical_cores():
    """Physical core count. Prefers psutil (accurate); degrades to logical cores
    if psutil is absent. psutil is a SOFT dependency — it must never crash the
    worker, so a missing/broken psutil silently falls back to os.cpu_count()."""
    try:
        import psutil
        n = psutil.cpu_count(logical=False)
        if n:
            return int(n)
    except Exception:
        pass
    return int(os.cpu_count() or 4)


SHERPA_CUDA_INDEX = "https://k2-fsa.github.io/sherpa/onnx/cuda.html"
EFFECTIVE_PROVIDER = "cpu"


def _nvidia_info():
    """NVIDIA GPU name + compute capability via nvidia-smi, or None when absent."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        import subprocess
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            return None
        line = (out.stdout or "").strip().splitlines()
        if not line or not line[0].strip():
            return None
        parts = [p.strip() for p in line[0].split(",")]
        return {"name": parts[0], "compute_cap": parts[1] if len(parts) > 1 else ""}
    except Exception:
        return None


def _sherpa_is_gpu_build():
    """True only when the installed sherpa-onnx wheel is a CUDA build. GPU wheels carry
    a local version like '1.13.3+cuda12.cudnn9'; PyPI CPU wheels have no local part.
    This is what actually matters — sherpa-onnx ships its OWN bundled onnxruntime, so
    the pip 'onnxruntime'/'onnxruntime-gpu' package is irrelevant to its CUDA support."""
    try:
        import sherpa_onnx
        return "+cuda" in (getattr(sherpa_onnx, "__version__", "") or "")
    except Exception:
        return False


def _cuda_runtime_loadable():
    """Probe whether the CUDA 12 + cuDNN 9 runtime DLLs sherpa's bundled onnxruntime
    needs are discoverable. On Windows they must be on PATH (the wheel doesn't bundle
    them). Loading the two anchor libs is a cheap, reliable proxy."""
    import ctypes
    names = (["cudart64_12.dll", "cudnn64_9.dll"] if os.name == "nt"
             else ["libcudart.so.12", "libcudnn.so.9"])
    loader = ctypes.WinDLL if os.name == "nt" else ctypes.CDLL
    for n in names:
        try:
            loader(n)
        except OSError:
            return False
    return True


def gpu_status():
    """Honest, layered GPU readiness for sherpa-onnx. Reports each independent layer
    plus the single 'provider' the worker will really use and a human 'reason'. Never
    fakes acceleration (zero-fallback): every layer must hold for provider='cuda'."""
    nv = _nvidia_info()
    gpu_build = _sherpa_is_gpu_build()
    dlls = _cuda_runtime_loadable() if nv else False
    if not nv:
        provider, reason = "cpu", "Nenhuma GPU NVIDIA detectada (nvidia-smi ausente)."
    elif not dlls and not gpu_build:
        provider, reason = "cpu", ("GPU NVIDIA detectada, mas o sherpa-onnx instalado é CPU e faltam "
                                   "CUDA 12.8 + cuDNN 9 no PATH.")
    elif not dlls:
        provider, reason = "cpu", "GPU NVIDIA detectada, mas CUDA 12.8 + cuDNN 9 não estão no PATH."
    elif not gpu_build:
        provider, reason = "cpu", "CUDA presente, mas o sherpa-onnx instalado é o build de CPU."
    else:
        provider, reason = "cuda", "GPU NVIDIA + sherpa-onnx CUDA + CUDA/cuDNN no PATH."
    return {
        "nvidia": bool(nv),
        "name": (nv or {}).get("name", ""),
        "compute_cap": (nv or {}).get("compute_cap", ""),
        "sherpa_gpu_build": gpu_build,
        "cuda_dlls": dlls,
        "provider": provider,
        "reason": reason,
        "can_setup": bool(nv) and not (gpu_build and dlls),
    }


def _gpu_usable():
    """Backward-compatible boolean gate: usable only when the whole chain holds."""
    return gpu_status()["provider"] == "cuda"


def detect_hardware():
    """Report cores + usable GPU. Pure read of the machine; safe to call anytime."""
    return {
        "logical_cores": int(os.cpu_count() or 4),
        "physical_cores": _physical_cores(),
        "gpu_usable": _gpu_usable(),
    }


def resolve_model(name):
    """Resolve the effective model. 'auto' maps hardware -> model (the rule):
        GPU usable .............. large-v3  (max quality; Phase B, needs CUDA build)
        physical cores >= 6 ..... turbo     (recommended, all target machines)
        otherwise ............... small      (safe, light)
    Any explicit name passes straight through — the user's choice is sovereign
    (they may force large-v3 on a weak CPU; the UI warns but never blocks). 'base'
    is legacy/worst and is NEVER auto-selected."""
    if name != "auto":
        return name
    hw = detect_hardware()
    if hw["gpu_usable"]:
        return "large-v3"
    if hw["physical_cores"] >= PHYS_CORE_TURBO_THRESHOLD:
        return "turbo"
    return "small"


SAMPLE_RATE = 16000
WHISPER_MAX_S = 28.0
CHUNK_TARGET_S = 8.0

# --- Ponte para o motor único (vox-engine) via named pipe --------------------
# Reversível: VOICE_USE_VOX_ENGINE=0 desliga (STT 100% local, comportamento antigo).
# Cliente em STDLIB PURA (o named pipe do Windows abre como arquivo) — não precisa
# de pywin32, então funciona no python do worker (3.14) mesmo o motor sendo 3.13.
VOX_ENGINE_ENABLED = os.environ.get("VOICE_USE_VOX_ENGINE", "1").strip() not in ("0", "false", "")
VOX_PIPE = os.environ.get("VOX_PIPE", r"\\.\pipe\vox")
VOX_PROFILE = os.environ.get("VOICE_VOX_PROFILE", "dictation").strip() or "dictation"
# Teto de sanidade p/ o tamanho de um frame vindo do motor: um header gigante
# (stream desincronizado / peer hostil) é rejeitado ALTO em vez de tentar ler GBs
# (evita OOM/wedge). E um timeout no request evita travar o loop de comandos.
VOX_MAX_FRAME = 64 * 1024 * 1024
VOX_REQ_TIMEOUT = float(os.environ.get("VOX_REQ_TIMEOUT", "30").strip() or "30")
GH_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
TTS_MODEL = (os.environ.get("VOICE_TTS_MODEL", "vits-piper-pt_BR-miro-high").strip()
             or "vits-piper-pt_BR-miro-high")
TTS_GH_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

# Push-to-talk energy gate: discard an utterance whose max peak stays below this
# (suppresses Whisper hallucinations on silence, e.g. "E aí Obrigado"). Tuned to
# sit between the noise floor (~0.0026) and quiet-speech peaks (~0.0038-0.006) on
# low-gain mics; raising it discards quiet real speech, lowering it risks phantom
# transcripts on noise. Override via VOICE_MIC_SILENCE_PEAK.
MIC_SILENCE_PEAK = float(os.environ.get("VOICE_MIC_SILENCE_PEAK", "0.0032") or "0.0032")


def build_stop_events(res, sid, mic_silence_peak, mic_detector):
    """Pure builder for the events emitted when a push-to-talk capture stops.

    The recorder ``sid`` is stamped on EVERY transcript event so the extension can
    route the result to the session that recorded it — independent of any in-memory
    primary/active-session state that a failover may have mutated. Returns a list of
    event dicts (so it is unit-testable without the audio stack)."""
    events = []
    sid = sid or ""
    peak = res.get("peak", 0.0)
    if peak < mic_silence_peak:
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


def model_dir_for(name):
    return os.path.join(MODEL_ROOT, f"sherpa-onnx-whisper-{name}")


def ensure_model(name):
    """Return the model directory, downloading + extracting it if missing."""
    mdir = model_dir_for(name)
    enc = os.path.join(mdir, f"{name}-encoder.int8.onnx")
    dec = os.path.join(mdir, f"{name}-decoder.int8.onnx")
    tok = os.path.join(mdir, f"{name}-tokens.txt")
    if os.path.isfile(enc) and os.path.isfile(dec) and os.path.isfile(tok):
        return mdir

    os.makedirs(MODEL_ROOT, exist_ok=True)
    url = f"{GH_BASE}/sherpa-onnx-whisper-{name}.tar.bz2"
    tar_path = os.path.join(MODEL_ROOT, f"sherpa-onnx-whisper-{name}.tar.bz2")
    emit({"event": "loading", "stage": "download", "model": name,
          "msg": f"Baixando modelo Whisper '{name}'..."})
    log(f"downloading model from {url}")

    def _pct(p):
        emit({"event": "loading", "stage": "download", "model": name,
              "pct": p, "msg": f"Baixando modelo... {round(p)}%"})
    t0 = time.time()
    got = _download_file(url, tar_path, timeout=180, on_pct=_pct)
    log(f"downloaded {got/1e6:.1f} MB in {time.time()-t0:.1f}s")

    emit({"event": "loading", "stage": "extract", "model": name,
          "msg": "Extraindo modelo..."})
    with tarfile.open(tar_path, "r:bz2") as t:
        t.extractall(MODEL_ROOT, filter="data")  
    try:
        os.remove(tar_path)
    except OSError:
        pass
    return mdir


def build_recognizer(name, language):
    import sherpa_onnx
    name = resolve_model(name)          
    mdir = ensure_model(name)

    def pick(suffix):
        for f in os.listdir(mdir):
            if f.endswith(suffix):
                return os.path.join(mdir, f)
        return None

    enc = pick("encoder.int8.onnx") or pick("encoder.onnx")
    dec = pick("decoder.int8.onnx") or pick("decoder.onnx")
    tok = pick("tokens.txt")
    if not (enc and dec and tok):
        raise RuntimeError(f"model files not found in {mdir}")

    emit({"event": "loading", "stage": "init", "model": name,
          "msg": "Carregando modelo..."})
    n_threads = max(2, min(6, (os.cpu_count() or 4) - 4))
    global EFFECTIVE_PROVIDER
    providers = ("cuda", "cpu") if _gpu_usable() else ("cpu",)
    last_exc = None
    for provider in providers:
        try:
            log(f"build_recognizer model={name} provider={provider} threads={n_threads}")
            rec = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=enc,
                decoder=dec,
                tokens=tok,
                language="" if language == "auto" else language,
                task="transcribe",
                num_threads=n_threads,
                decoding_method="greedy_search",
                provider=provider,
            )
            EFFECTIVE_PROVIDER = provider
            return rec
        except Exception as exc:
            last_exc = exc
            log(f"recognizer provider={provider} failed:\n" + traceback.format_exc())
    raise last_exc if last_exc else RuntimeError("recognizer build failed")


_tts_engine = None


def _first_with_suffix(dirpath, suffix):
    if not os.path.isdir(dirpath):
        return None
    for f in sorted(os.listdir(dirpath)):
        if f.endswith(suffix):
            return os.path.join(dirpath, f)
    return None


def ensure_tts_model(name):
    """Return the TTS voice directory, downloading + extracting it if missing."""
    d = os.path.join(MODEL_ROOT, name)
    if _first_with_suffix(d, ".onnx") and os.path.isfile(os.path.join(d, "tokens.txt")):
        return d

    os.makedirs(MODEL_ROOT, exist_ok=True)
    url = f"{TTS_GH_BASE}/{name}.tar.bz2"
    tar_path = os.path.join(MODEL_ROOT, f"{name}.tar.bz2")
    emit({"event": "loading", "stage": "download", "model": name,
          "msg": f"Baixando voz neural '{name}'..."})
    log(f"downloading tts model from {url}")

    def _pct(p):
        emit({"event": "loading", "stage": "download", "model": name,
              "pct": p, "msg": f"Baixando voz... {round(p)}%"})
    _download_file(url, tar_path, timeout=180, on_pct=_pct)

    emit({"event": "loading", "stage": "extract", "model": name,
          "msg": "Extraindo voz..."})
    with tarfile.open(tar_path, "r:bz2") as t:
        t.extractall(MODEL_ROOT, filter="data")  
    try:
        os.remove(tar_path)
    except OSError:
        pass
    return d


def build_tts(name):
    import sherpa_onnx
    d = ensure_tts_model(name)
    onnx = _first_with_suffix(d, ".onnx")
    tokens = os.path.join(d, "tokens.txt")
    data_dir = os.path.join(d, "espeak-ng-data")
    if not (onnx and os.path.isfile(tokens)):
        raise RuntimeError(f"tts model files not found in {d}")

    emit({"event": "loading", "stage": "init", "model": name,
          "msg": "Carregando voz neural..."})
    n_threads = max(1, min(2, (os.cpu_count() or 2) - 2))
    vits = sherpa_onnx.OfflineTtsVitsModelConfig(
        model=onnx, tokens=tokens, data_dir=data_dir,
    )
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=vits, provider="cpu", num_threads=n_threads,
        ),
        max_num_sentences=2,
    )
    return sherpa_onnx.OfflineTts(cfg)


def ensure_tts():
    global _tts_engine
    if _tts_engine is None:
        _tts_engine = build_tts(TTS_MODEL)
    return _tts_engine


def set_tts_voice(name):
    """Rebuild the TTS engine for a new voice at runtime; keep the current voice on failure."""
    global TTS_MODEL, _tts_engine
    name = (name or "").strip()
    if not name or name == TTS_MODEL:
        return
    try:
        engine = build_tts(name)
        _tts_engine = engine
        TTS_MODEL = name
        emit({"event": "tts_voice", "ok": True, "voice": name})
        log(f"tts voice switched to {name}")
    except Exception:
        log("set_tts_voice failed:\n" + traceback.format_exc())
        emit({"event": "tts_voice", "ok": False, "voice": name})


def install_sherpa_gpu():
    """Swap the CPU sherpa-onnx wheel for the CUDA 12.8/cuDNN9 GPU build (the ONLY way
    to enable CUDA for sherpa-onnx — pip onnxruntime-gpu does nothing here). Rolls back
    to the CPU wheel on failure. Does NOT install the CUDA toolkit/cuDNN themselves."""
    import subprocess
    try:
        import sherpa_onnx
        base = (getattr(sherpa_onnx, "__version__", "") or "").split("+")[0]
    except Exception:
        base = ""
    if not base:
        return False, "Versão do sherpa-onnx desconhecida."
    spec = f"sherpa-onnx=={base}+cuda12.cudnn9"
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "uninstall", "-y", "sherpa-onnx",
                               "--disable-pip-version-check"], timeout=300)
        subprocess.check_call([sys.executable, "-m", "pip", "install", spec,
                               "--find-links", SHERPA_CUDA_INDEX,
                               "--disable-pip-version-check"], timeout=1800)
        return True, f"Instalado {spec}. Reinicie a voz para ativar a GPU."
    except Exception as exc:
        log("install_sherpa_gpu failed:\n" + traceback.format_exc())
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", f"sherpa-onnx=={base}",
                                   "--disable-pip-version-check"], timeout=900)
        except Exception:
            log("rollback to CPU wheel failed:\n" + traceback.format_exc())
        return False, f"Falha ao instalar o wheel GPU: {exc}"


def handle_gpu_setup():
    """Opt-in GPU enablement. Reports the diagnosis, and only swaps the wheel when the
    NVIDIA GPU plus the system CUDA 12.8/cuDNN9 DLLs are present; otherwise it instructs
    the user about what to install. Signals 'restart' so Node can respawn the worker."""
    st = gpu_status()
    emit({"event": "gpu_status", **st})
    if not st["nvidia"]:
        emit({"event": "gpu_setup", "ok": False, "msg": st["reason"]})
        return
    if st["provider"] == "cuda":
        emit({"event": "gpu_setup", "ok": True, "restart": False,
              "msg": "GPU já está ativa."})
        return
    if not st["cuda_dlls"]:
        emit({"event": "gpu_setup", "ok": False, "needsCuda": True,
              "msg": ("Faltam CUDA 12.8 + cuDNN 9 no PATH. Instale o CUDA Toolkit 12.8 e o "
                      "cuDNN 9, adicione as pastas bin ao PATH e tente novamente.")})
        return
    emit({"event": "loading", "stage": "deps",
          "msg": "Instalando sherpa-onnx GPU (pode demorar)..."})
    ok, msg = install_sherpa_gpu()
    emit({"event": "gpu_setup", "ok": ok, "restart": ok, "msg": msg})


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


def synthesize_tts(msg):
    _id = msg.get("id")
    text = (msg.get("text") or "").strip() or "Sem conteúdo para ler."
    out = msg.get("out")
    speed = float(msg.get("speed") or 1.0)
    sid = int(msg.get("sid") or 0)
    try:
        engine = ensure_tts()
        TTS_IDLE.clear()
        try:
            audio = engine.generate(text, sid=sid, speed=speed)
        finally:
            TTS_IDLE.set()
        cleaned = clean_tts(audio.samples, audio.sample_rate)
        if out:
            write_wav(out, cleaned, audio.sample_rate)
        emit({"event": "tts", "id": _id, "ok": True, "out": out,
              "sample_rate": int(audio.sample_rate)})
    except Exception as exc:
        log("tts error:\n" + traceback.format_exc())
        emit({"event": "tts", "id": _id, "ok": False, "msg": str(exc)})


class Recorder:
    def __init__(self):
        self._frames = []
        self._lock = threading.Lock()
        self._last_rms = 0.0
        self._last_peak = 0.0
        self._max_peak = 0.0
        self._recording = False
        self._meter_thread = None
        self._decode_fn = None       
        self._streamer = None
        self._tail = None            
        self._partials = []          
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
        with self._lock:
            self._frames.append(block)
        self._last_rms = float(np.sqrt(np.mean(block ** 2)) if block.size else 0.0)
        self._last_peak = float(np.max(np.abs(block)) if block.size else 0.0)
        if self._last_peak > self._max_peak:
            self._max_peak = self._last_peak

    def _meter_loop(self):
        while self._recording:
            emit({"event": "level",
                  "rms": round(self._last_rms, 5),
                  "peak": round(self._last_peak, 4)})
            time.sleep(0.12)

    def _decode_seg(self, seg):
        if self._decode_fn is None or seg.size < int(0.1 * SAMPLE_RATE):
            return
        t0 = time.time()
        try:
            text = self._decode_fn(seg)
        except Exception as exc:
            log(f"decode error: {exc}")
            return
        self._proc_ms += int((time.time() - t0) * 1000)
        if text:
            self._partials.append(text)

    def _pull_frames(self):
        with self._lock:
            blocks = self._frames
            self._frames = []
        if not blocks:
            return
        chunk = np.concatenate(blocks).astype(np.float32)
        self._dur_samples += chunk.size
        self._tail = chunk if self._tail is None else np.concatenate([self._tail, chunk])

    def _target_len(self):
        """Samples for the next block (fixed ~CHUNK_TARGET_S window)."""
        return int(min(CHUNK_TARGET_S, WHISPER_MAX_S) * SAMPLE_RATE)

    def _consume(self, final=False):
        """Pull buffered audio and decode complete blocks. Block size is a fixed
        ~CHUNK_TARGET_S target, but each cut is deferred to a real pause (silence) so a
        word is never sliced; the 28s Whisper ceiling is the only forced cut. On
        final, flush the tail (splitting only if it somehow exceeds the ceiling)."""
        self._pull_frames()
        target = self._target_len()
        while self._tail is not None and self._tail.size >= target:
            cut = _cut_point(self._tail, SAMPLE_RATE, target / SAMPLE_RATE,
                             hard_s=WHISPER_MAX_S, defer=True)
            if cut is None:
                break  
            seg = self._tail[:cut]
            self._tail = self._tail[cut:]
            self._decode_seg(seg)
        if final and self._tail is not None and self._tail.size > 0:
            hard = int(WHISPER_MAX_S * SAMPLE_RATE)
            while self._tail.size > hard:
                cut = _cut_point(self._tail, SAMPLE_RATE, WHISPER_MAX_S)
                self._decode_seg(self._tail[:cut])
                self._tail = self._tail[cut:]
            self._decode_seg(self._tail)
            self._tail = None

    def _stream_loop(self):
        while self._recording:
            time.sleep(0.4)
            try:
                self._consume(final=False)
            except Exception as exc:
                log(f"streamer error: {exc}")

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
        with self._lock:
            self._frames = []
        self._tail = None
        self._partials = []
        self._dur_samples = 0
        self._proc_ms = 0
        self._max_peak = 0.0
        self._recording = True
        if not quiet:
            self._meter_thread = threading.Thread(target=self._meter_loop, daemon=True)
            self._meter_thread.start()
        if self._decode_fn is not None:
            self._streamer = threading.Thread(target=self._stream_loop, daemon=True)
            self._streamer.start()
        if not quiet:
            emit({"event": "recording", "state": True})

    def _end(self):
        """Stop capturing. No stream teardown — AudioHub owns the device."""
        self._recording = False
        if not self._quiet:
            emit({"event": "recording", "state": False})

    def _join_streamer(self):
        if self._streamer is not None:
            try:
                self._streamer.join(timeout=60)
            except Exception:
                pass
            self._streamer = None

    def _reset(self):
        self._tail = None
        self._partials = []
        self._dur_samples = 0
        self._proc_ms = 0
        with self._lock:
            self._frames = []

    def stop(self):
        """Stop recording and return {text, dur_ms, ms, chunks}. Long dictations
        were mostly decoded during recording; only the tail is left here."""
        with self._lock:
            had_frames = bool(self._frames)
        if not self._recording and self._tail is None and not self._partials and not had_frames:
            return {"text": "", "dur_ms": 0, "ms": 0, "chunks": 0}
        self._end()
        self._join_streamer()        
        self._consume(final=True)
        text = " ".join(self._partials).strip()
        res = {"text": text,
               "dur_ms": int(1000 * self._dur_samples / SAMPLE_RATE),
               "ms": self._proc_ms,
               "peak": round(self._max_peak, 5),
               "chunks": len(self._partials)}
        self._reset()
        return res

    def cancel(self):
        self._end()
        self._join_streamer()
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
    listening is a pure flag flip — ZERO PortAudio calls on the hand-off — which
    is what eliminates the two-simultaneous-streams hang that SIGTERM'd the
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

    def _callback(self, indata, frames, time_info, status):  
        block = indata[:, 0].copy()
        if self._rec:
            self._rec_obj.feed(block, status)
        elif self._wake_on:
            self._wake.feed(block)
        if self._monitor_on and not self._rec and block.size:
            import numpy as _np
            p = float(_np.max(_np.abs(block)))
            if p > self._mon_peak:
                self._mon_peak = p
            self._mon_rms = float(_np.sqrt(_np.mean(block * block)))

    def _ensure_open(self):
        if self._stream is not None:
            return
        import sounddevice as sd
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32",
            blocksize=WAKE_BLOCK, callback=self._callback,
            device=SELECTED_MIC)
        self._stream.start()

    def _ensure_closed(self):
        if self._stream is None:
            return
        try:
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

    def start_record(self):
        """Begin push-to-talk. If wake was listening the stream is already open,
        so this only suspends wake + flips the rec flag + starts the recorder's
        decode threads — no audio device call -> can never hang the main thread."""
        with self._lock:
            self._wake.suspend()        
            self._rec = True
            self._ensure_open()         
            self._rec_obj.begin()

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
        while self._monitor_on:
            time.sleep(0.15)
            if not self._monitor_on:
                break
            emit({"event": "monitor_level",
                  "peak": round(self._mon_peak, 5),
                  "rms": round(self._mon_rms, 5)})
            self._mon_peak = 0.0

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


def _frame_rms(samples, sr, frame_ms=20):
    """Return (rms_per_frame, frame_len) for a coarse energy envelope."""
    fl = max(1, int(sr * frame_ms / 1000))
    n = samples.size // fl
    if n == 0:
        val = float(np.sqrt(np.mean(samples ** 2))) if samples.size else 0.0
        return np.array([val], dtype=np.float32), fl
    trimmed = samples[: n * fl].reshape(n, fl)
    rms = np.sqrt(np.mean(trimmed ** 2, axis=1)).astype(np.float32)
    return rms, fl


def _cut_point(samples, sr, max_s=WHISPER_MAX_S, hard_s=None, defer=False):
    """Index (samples) at which to cut a leading chunk, preferring a quiet point so
    words aren't sliced. Builds a 20ms energy envelope and, from (max_s-5s) up to the
    hard ceiling, cuts at the quietest frame. When defer=True it returns None if that
    quietest frame isn't actually a pause (well below the local speech level) and the
    buffer hasn't yet reached hard_s -- telling the caller to wait for more audio so
    the cut lands in real silence instead of mid-word. The hard ceiling (default
    max_s) is the only forced cut. In offline mode (defer=False) a remaining buffer
    that already fits in max_s is returned whole."""
    n = samples.size
    soft = int(max_s * sr)
    hard = int((hard_s if hard_s is not None else max_s) * sr)
    if n <= soft and not defer:
        return n
    rms, fl = _frame_rms(samples, sr)
    lo = max(int(0.5 * sr), soft - int(5 * sr))   
    hi = min(n, hard)                              
    f_lo = lo // fl
    f_hi = min(len(rms) - 1, hi // fl)
    if f_hi <= f_lo:
        if defer and n < hard:
            return None                            
        return min(soft, n)
    win = rms[f_lo : f_hi + 1]
    j = int(np.argmin(win))
    cut = (f_lo + j) * fl
    if cut <= 0:
        cut = min(soft, n)
    if defer:
        speech = max(float(np.percentile(win, 75)), 1e-6)
        is_pause = float(win[j]) < max(0.30 * speech, 0.004)
        if not is_pause and n < hard:
            return None                            
    return cut


def segment_audio(samples, sr, max_s=WHISPER_MAX_S):
    """Split samples into <= max_s chunks, cutting at quiet points. (Used for the
    one-shot offline path; the live recorder decodes incrementally instead.)"""
    segs = []
    start, n = 0, samples.size
    while start < n:
        cut = _cut_point(samples[start:], sr, max_s)
        segs.append(samples[start : start + cut])
        start += cut
    return [s for s in segs if s.size > 0]


def detect_mic():
    """(ok, name, reason) do dispositivo de entrada padrão. ok=False quando não há
    microfone utilizável — a UI então bloqueia a gravação e mostra a causa."""
    try:
        import sounddevice as sd
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
    try:
        dd = sd.default.device
        default_in = int(dd[0]) if hasattr(dd, "__getitem__") else int(dd)
    except Exception:
        default_in = None
    out, seen = [], set()
    try:
        devs = sd.query_devices()
    except Exception as exc:
        return {"devices": [], "current": SELECTED_MIC, "default": default_in, "error": str(exc)}
    for i, d in enumerate(devs):
        if int(d.get("max_input_channels", 0)) < 1:
            continue
        name = str(d.get("name", "") or "").strip()
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        out.append({"index": i, "name": name,
                    "channels": int(d.get("max_input_channels", 0)),
                    "is_default": (default_in is not None and i == default_in)})
    return {"devices": out, "current": SELECTED_MIC, "default": default_in}


def mic_monitor():
    """Vigia o microfone e emite 'mic' só quando o estado muda (conectar/desconectar),
    para a UI refletir hardware em tempo real sem custo."""
    last = None
    while True:
        ok, name, reason = detect_mic()
        cur = (ok, name)
        if cur != last:
            emit({"event": "mic", "ok": ok, "name": name, "reason": reason})
            last = cur
        time.sleep(3.0)


class VoxEngineError(RuntimeError):
    """Motor de voz (vox-engine) indisponível ou falhou. NÃO há fallback silencioso
    para o STT local — o chamador deve reportar o erro ALTO (visível na UI)."""


class _VoxBridge:
    """Cliente STDLIB-puro do motor único (vox-engine) via named pipe.

    Substitui o STT local do voice-chat pelo motor compartilhado (perfil
    ``dictation`` → turbo). Não usa pywin32 (abre o pipe como arquivo), então
    roda em qualquer python do worker. Se o motor não estiver INSTALADO, baixa o
    instalador da release pública e o executa (tudo em STDLIB pura: ``urllib``,
    ``zipfile``, ``tempfile``, ``subprocess`` — não importa ``vox_engine`` nem
    ``pywin32``); depois sobe o daemon INSTALADO. Em qualquer falha (rede,
    release ausente, install.ps1 != 0, sem Python 3.11+), ``transcribe``/``info``
    LEVANTAM :class:`VoxEngineError` — sem fallback silencioso, sem erro mudo
    (regra do projeto: fallback automático introduz ponto de falha e mascara
    problema).
    """

    # Vitrine pública que hospeda a release do motor (tag vox-engine-v*), espelho
    # de vox_engine.core.updater — mas 100% stdlib (o worker não importa o motor).
    # VOX_RELEASES_API permite apontar p/ um espelho/enterprise (e testar a falha
    # de rede de forma determinística) sem tocar no código.
    _RELEASES_API = os.environ.get("VOX_RELEASES_API") or (
        "https://api.github.com/repos/AllanSantos-DV/"
        "copilot-marketplace/releases")
    _TAG_PREFIX = "vox-engine-v"
    _INSTALLER_ASSET = "vox-engine-installer.zip"

    def __init__(self, pipe=VOX_PIPE, profile=VOX_PROFILE, status_cb=None):
        self._pipe_name = pipe
        self._profile = profile
        self._fh = None
        self._lock = threading.Lock()        # serializa 1 request/response (framing)
        self._conn_lock = threading.Lock()   # serializa (re)conexão/spawn/INSTALAÇÃO
        self._rid = 0
        self._next_retry = 0.0               # monotonic: cooldown p/ não bater no motor caído
        self._cooldown = 10.0                # s entre tentativas de spawn quando fora
        self._status_cb = status_cb          # callback p/ progresso VISÍVEL (instalação lenta)
        self._last_error = None              # última falha DETALHADA (instalação OU boot do daemon) p/ surfacing ALTO em info()

    def _status(self, msg):
        """Sinal de progresso VISÍVEL (ex.: instalação lenta que levaria minutos).
        Best-effort: sempre loga; se houver callback, emite p/ a UI. Nunca quebra o
        boot se o callback falhar (blindado) — mas NUNCA fica mudo no log."""
        log(f"vox-engine: {msg}")
        cb = self._status_cb
        if cb is not None:
            try:
                cb(msg)
            except Exception as exc:   # noqa: BLE001 — status é best-effort
                log(f"vox-engine: status_cb falhou: {exc}")

    def _close_fh(self):
        try:
            if self._fh:
                self._fh.close()
        except OSError:
            pass
        self._fh = None

    # ---- conexão ----
    def _open(self):
        try:
            self._fh = open(self._pipe_name, "r+b", buffering=0)  # noqa: SIM115
            # Conectou: LIMPA o erro detalhado e o cooldown. Sem isto, um
            # ``_last_error`` ANTIGO (de uma instalação/boot que falhou antes)
            # sobreviveria a uma recuperação bem-sucedida e poderia ser
            # re-levantado por ``info()`` num drop+cooldown POSTERIOR (erro
            # enganoso). É o ÚNICO ponto onde ``_fh`` vira válido, então limpar
            # aqui cobre todos os caminhos de sucesso do ``ensure``.
            self._last_error = None
            self._next_retry = 0.0
            return True
        except OSError:
            self._fh = None
            return False

    # ---- instalação do motor (STDLIB pura; espelha vox_engine.core.updater) ----
    # O worker roda 3.14 e o venv do motor é 3.13; a ponte é STDLIB-PURA (sem
    # pywin32, sem importar vox_engine), então a lógica de install/updater do
    # pacote é INALCANÇÁVEL daqui. Reimplementamos o mínimo em stdlib: baixar o
    # instalador da vitrine pública e rodar install.ps1 -NoStart.
    def _installed_pyw(self):
        """Caminho do pythonw.exe do venv INSTALADO (%LOCALAPPDATA%\\vox-engine)."""
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "vox-engine", "venv", "Scripts", "pythonw.exe")

    def _boot_log_path(self):
        """Log de boot do daemon (stdout/stderr do import ANTES do --log-file dele).
        Compartilhado por ``_start_installed_daemon`` (escreve) e ``ensure`` (lê o
        tail p/ surfaçar ALTO um crash de import quando o pipe nunca aparece)."""
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "vox-engine", "logs", "daemon-boot.log")

    @staticmethod
    def _parse_version(v):
        """'0.1.2' | 'vox-engine-v0.1.2' | 'v0.1.2' -> (0,1,2). Robusto a sufixos."""
        v = (v or "").strip()
        if v.startswith(_VoxBridge._TAG_PREFIX):
            v = v[len(_VoxBridge._TAG_PREFIX):]
        v = v.lstrip("vV")
        nums = []
        for part in v.split("."):
            digits = ""
            for ch in part:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            nums.append(int(digits) if digits else 0)
        return tuple(nums) or (0,)

    def _http_get(self, url, timeout=60):
        """GET stdlib com headers do GitHub. LEVANTA em erro de rede/HTTP (nunca
        retorna mudo) — o chamador converte em VoxEngineError ALTO."""
        req = urllib.request.Request(url, headers={
            "User-Agent": "voice-chat-vox-bridge",
            "Accept": "application/vnd.github+json",
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310
            return r.read()

    def _latest_release(self):
        """Release mais nova do motor na vitrine: {'version','tag','asset_url'} ou
        None se a API não trouxe NENHUMA release utilizável (tag ``vox-engine-v*``
        com o asset ``vox-engine-installer.zip``). LEVANTA em erro de rede/parse
        (não mascara ausência de rede como "sem release")."""
        data = json.loads(self._http_get(self._RELEASES_API).decode("utf-8"))
        best = None
        for rel in data if isinstance(data, list) else []:
            tag = rel.get("tag_name", "") or ""
            if not tag.startswith(self._TAG_PREFIX):
                continue
            asset_url = None
            for a in rel.get("assets", []) or []:
                if a.get("name") == self._INSTALLER_ASSET:
                    asset_url = a.get("browser_download_url")
                    break
            if not asset_url:
                continue
            ver = tag[len(self._TAG_PREFIX):]
            if best is None or self._parse_version(ver) > self._parse_version(best["version"]):
                best = {"version": ver, "tag": tag, "asset_url": asset_url}
        return best

    def _download_and_install(self, asset_url):
        """Baixa o installer.zip, extrai e roda ``install.ps1 -NoStart`` (a ponte
        sobe o daemon depois). LEVANTA :class:`VoxEngineError` em QUALQUER falha
        (download, zip corrompido, install.ps1 ausente, timeout, exit != 0 — incl.
        "nenhum Python 3.11+") — nunca retorna mudo. Timeout generoso (1800s): a 1ª
        instalação baixa deps (incl. wheels CUDA) e pode levar minutos."""
        try:
            blob = self._http_get(asset_url, timeout=120)
        except Exception as exc:   # noqa: BLE001 — rede: erro ALTO
            raise VoxEngineError(
                f"falha ao baixar o instalador do motor ({asset_url}): {exc}") from exc
        tmp = tempfile.mkdtemp(prefix="vox-install-")
        zpath = os.path.join(tmp, self._INSTALLER_ASSET)
        try:
            with open(zpath, "wb") as f:
                f.write(blob)
            try:
                with zipfile.ZipFile(zpath) as z:
                    z.extractall(tmp)
            except Exception as exc:   # noqa: BLE001 — zip corrompido / download parcial
                raise VoxEngineError(
                    f"instalador do motor corrompido (zip inválido): {exc}") from exc
            install_ps1 = os.path.join(tmp, "install.ps1")
            if not os.path.exists(install_ps1):
                raise VoxEngineError(
                    "instalador do motor inválido: install.ps1 ausente no zip")
            # -NoStart: a ponte sobe o daemon depois. VOX_INSTALL_EXTRA_ARGS é um
            # escape hatch (espelha o extra_args do updater): permite -Cpu/-NoBoot
            # (ex.: máquina sem rede p/ CUDA, ou testes sem registrar autostart).
            # Passado como ARGV separado (sem shell) — sem injeção.
            extra = (os.environ.get("VOX_INSTALL_EXTRA_ARGS") or "").split()
            args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", install_ps1, "-NoStart", *extra]
            # A saída do install.ps1 vai para um ARQUIVO (não para pipes de
            # capture_output) e o stdin é FECHADO (DEVNULL). Motivo: install.ps1
            # gera uma árvore de netos (py.exe/venv/pip). Com capture_output, o
            # stdin do worker (um pipe VIVO ligado ao host) é HERDADO pelos netos
            # e um deles (ex.: a checagem "py -3.13 -c ...") pode BLOQUEAR nesse
            # pipe; além disso o write-end do pipe de stdout herdado adia o EOF do
            # communicate() → deadlock que trava a instalação por minutos. Arquivo
            # + DEVNULL elimina os dois: sem pipe p/ herdar, sem espera por EOF; e
            # ainda persiste o log p/ lermos o tail em caso de falha (LOUD).
            out_path = os.path.join(tmp, "install-output.log")
            # Timeout generoso (1800s) — a 1ª instalação baixa deps (incl. wheels
            # CUDA) e leva minutos. VOX_INSTALL_TIMEOUT permite ajustar (link lento)
            # e deixa o caminho de timeout TESTÁVEL (o gate baixa p/ poucos seg).
            to = self._install_timeout()
            timed_out = False
            proc = None
            try:
                with open(out_path, "wb") as outf:
                    proc = subprocess.Popen(
                        args, stdin=subprocess.DEVNULL, stdout=outf,
                        stderr=subprocess.STDOUT, close_fds=True)
                    rc = proc.wait(timeout=to)
            except subprocess.TimeoutExpired:
                # Mata a ÁRVORE INTEIRA (powershell + py/venv/pip): matar só o
                # powershell-pai deixaria netos órfãos mutando a pasta do motor, e um
                # retry depois iniciaria uma 2ª instalação concorrente (corromperia o
                # venv a meio caminho).
                timed_out = True
                self._kill_tree(proc)
                rc = -1
            except Exception as exc:   # noqa: BLE001 — powershell ausente, wait etc.
                # Se o processo JÁ subiu, NÃO deixa a árvore órfã em NENHUM erro
                # (defense-in-depth além do timeout) — senão um retry poderia iniciar
                # uma 2ª instalação sobre um venv meio-escrito.
                if proc is not None:
                    self._kill_tree(proc)
                raise VoxEngineError(f"falha ao executar install.ps1: {exc}") from exc
            # outf JÁ fechado aqui (e a árvore morta em timeout/erro) → lemos o tail
            # sem contenda de handle no Windows e sem neto órfão segurando o arquivo.
            if timed_out:
                raise VoxEngineError(
                    f"instalação do motor excedeu {int(to)}s "
                    "(deps/CUDA muito lentas): " + self._read_tail(out_path, 800))
            if rc != 0:
                raise VoxEngineError(
                    f"install.ps1 falhou (código {rc}): "
                    + self._read_tail(out_path, 800))
            return True
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @staticmethod
    def _kill_tree(proc):
        """Mata o processo do install E TODA a árvore de netos (py/venv/pip).

        No Windows, ``proc.kill()`` derruba só o processo raiz (powershell); os
        netos que o install.ps1 gerou (py.exe, o python do venv, pip) ficam
        ÓRFÃOS e continuam mutando ``%LOCALAPPDATA%\\vox-engine``. Um retry
        posterior poderia então iniciar uma 2ª instalação CONCORRENTE sobre um
        venv meio-escrito. ``taskkill /F /T`` (ferramenta nativa do Windows, sem
        dep nova) derruba a árvore inteira a partir da raiz — que no timeout ainda
        está viva, logo a árvore está intacta e é alcançável pelo PID pai.
        Best-effort com fallbacks; NUNCA levanta (o chamador já vai levantar o
        VoxEngineError do timeout)."""
        pid = getattr(proc, "pid", None)
        if pid is not None:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=30)
            except Exception:   # noqa: BLE001 — fallback abaixo
                pass
        try:
            proc.kill()
        except Exception:   # noqa: BLE001
            pass
        try:
            proc.wait(timeout=10)   # reap: evita zumbi/handle preso
        except Exception:   # noqa: BLE001
            pass

    @staticmethod
    def _read_tail(path, n):
        """Lê o final (n chars) do log do install.ps1 p/ compor o erro LOUD."""
        try:
            with open(path, "rb") as f:
                data = f.read()
            return data.decode("utf-8", "replace").strip()[-n:]
        except Exception:   # noqa: BLE001
            return "(sem saída capturada)"

    @staticmethod
    def _install_timeout():
        """Timeout (s) do install.ps1 a partir de VOX_INSTALL_TIMEOUT, com fallback
        SEGURO p/ 1800. Rejeita nan/inf/<=0: ``float()`` aceita 'nan'/'inf', que
        passariam pelo ``except (TypeError, ValueError)`` e depois QUEBRARIAM o
        ``proc.wait(timeout=…)`` (OverflowError/ValueError) DEPOIS do processo já
        estar no ar — reabrindo o risco de árvore órfã. Normaliza lixo → 1800."""
        raw = os.environ.get("VOX_INSTALL_TIMEOUT")
        if not raw:
            return 1800.0
        try:
            to = float(raw)
        except (TypeError, ValueError):
            return 1800.0
        if not math.isfinite(to) or to <= 0:
            return 1800.0
        return to

    def _ensure_installed(self):
        """Garante o motor INSTALADO (pyw presente). No-op se já existe. Se ausente,
        sinaliza progresso VISÍVEL (instalação é lenta) e baixa+roda o instalador da
        release pública. LEVANTA :class:`VoxEngineError` em qualquer falha (sem rede,
        sem release, install.ps1 != 0, pyw ainda ausente) — NUNCA retorna False mudo.
        Serializado pelo ``_conn_lock`` do chamador (ensure), logo roda 1x por vez."""
        pyw = self._installed_pyw()
        if os.path.exists(pyw):
            return True
        self._status("Instalando o motor de voz pela primeira vez "
                     "(pode levar alguns minutos)…")
        try:
            rel = self._latest_release()
        except Exception as exc:   # noqa: BLE001 — rede/parse: erro ALTO (não mudo)
            raise VoxEngineError(
                f"não foi possível consultar as releases do motor: {exc}") from exc
        if rel is None:
            raise VoxEngineError(
                f"nenhuma release do motor ('{self._TAG_PREFIX}*' com "
                f"'{self._INSTALLER_ASSET}') encontrada em {self._RELEASES_API}")
        self._status(f"Baixando e instalando o motor v{rel['version']} "
                     "(pode incluir wheels CUDA)…")
        self._download_and_install(rel["asset_url"])   # levanta VoxEngineError em falha
        if not os.path.exists(pyw):
            raise VoxEngineError(
                f"o instalador terminou mas o motor não apareceu ({pyw} ausente): "
                "instalação incompleta")
        self._status("Motor de voz instalado. Iniciando o daemon…")
        return True

    def _start_installed_daemon(self, allow_install=True):
        """Sobe o daemon INSTALADO (destacado, sem janela). Com ``allow_install``
        (caminho de boot), INSTALA o motor antes se ele não existir — o que pode
        LEVANTAR :class:`VoxEngineError` (surfacing ALTO da falha de instalação).
        No caminho de decode (``allow_install=False``) NUNCA instala (fast-fail):
        se pyw falta, retorna False na hora (não trava o thread por minutos).

        stdout/stderr do daemon vão p/ um LOG DE BOOT (não DEVNULL) para CAPTURAR um
        crash de import que acontece ANTES do próprio ``--log-file`` do daemon subir
        (era por isso que a outra máquina falhava "sem log nenhum")."""
        if allow_install:
            self._ensure_installed()   # levanta VoxEngineError se a instalação falhar
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        root = os.path.join(base, "vox-engine")
        pyw = os.path.join(root, "venv", "Scripts", "pythonw.exe")
        if not os.path.exists(pyw):
            return False
        log_path = os.path.join(root, "logs", "daemon.log")
        boot_log = self._boot_log_path()
        try:
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            flags = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
            # Captura o boot do daemon (import-time) num arquivo append — um crash
            # ANTES do --log-file do daemon fica registrado em vez de sumir. O filho
            # herda um dup do handle; fechamos o nosso após o Popen (padrão).
            bf = open(boot_log, "ab")   # noqa: SIM115
            try:
                subprocess.Popen([pyw, "-m", "vox_engine", "--pipe", self._pipe_name,
                                  "--log-file", log_path], creationflags=flags,
                                 close_fds=True, stdin=subprocess.DEVNULL,
                                 stdout=bf, stderr=bf)
            finally:
                bf.close()
            return True
        except Exception as exc:   # NUNCA deixa escapar como erro mudo (ex.: OSError/NameError)
            log(f"vox-engine: falha ao subir daemon instalado: {exc}")
            # No caminho de BOOT (allow_install), uma falha SÍNCRONA de lançamento
            # (makedirs/open/Popen) é surfaçada ALTO — info() reporta a causa real
            # em vez do genérico "indisponível". No decode (allow_install=False) o
            # contrato é fast-fail QUIETO (não trava/levanta no thread de áudio).
            if allow_install:
                raise VoxEngineError(
                    f"falha ao iniciar o daemon do motor: {exc}") from exc
            return False

    def ensure(self, boot_timeout=60.0):
        """Garante conexão SEM segurar o lock de request e SEM erro mudo.

        Retorna True/False (nunca levanta). Respeita um cooldown: quando o motor
        está fora, não fica re-spawnando nem esperando ``boot_timeout`` a cada
        chamada — fast-fail até ``_next_retry``. Só o boot (boot_timeout>0)
        aguarda o daemon subir E instala o motor ausente (baixando a release); o
        caminho de decode usa boot_timeout=0, NUNCA instala, e um acquire
        NÃO-bloqueante: se o boot estiver segurando o conn_lock (ex.: instalando),
        retorna False na hora (não trava o thread de decode/wake — MED-2). Uma
        falha de INSTALAÇÃO ou de BOOT do daemon não some: fica em
        ``self._last_error`` p/ ``info()`` levantar a mensagem detalhada (erro
        ALTO na UI)."""
        if self._fh is not None:
            return True
        if boot_timeout <= 0:
            if not self._conn_lock.acquire(blocking=False):
                return False
        else:
            self._conn_lock.acquire()
        try:
            if self._fh is not None:
                return True
            if self._open():
                return True
            if time.monotonic() < self._next_retry:
                return False                       # cooldown: não bate no motor caído
            # Só o caminho de BOOT (boot_timeout>0) instala o motor ausente — a
            # instalação leva minutos e NÃO pode bloquear o thread de decode/wake.
            attempt_install = boot_timeout > 0.0
            if attempt_install:
                self._last_error = None             # tentativa nova: limpa erro anterior
            try:
                started = self._start_installed_daemon(allow_install=attempt_install)
            except VoxEngineError as exc:           # FALHA DE INSTALAÇÃO/LANÇAMENTO → erro ALTO
                # Guarda a mensagem detalhada (tail do install.ps1, ou causa do
                # lançamento) p/ info() reportar em vez do genérico "indisponível".
                # NÃO fica mudo: info() levanta isto.
                self._last_error = exc
                log(f"vox-engine: subida do motor falhou: {exc}")
                self._next_retry = time.monotonic() + self._cooldown
                return False
            except Exception as exc:               # blindagem total (sem erro mudo)
                log(f"vox-engine ensure erro: {exc}")
                started = False
            if not started:
                self._next_retry = time.monotonic() + self._cooldown
                return False
            deadline = time.time() + max(0.0, boot_timeout)
            while time.time() < deadline:
                if self._open():
                    return True
                time.sleep(0.5)
            # Daemon SUBIU mas o pipe NUNCA apareceu: quase sempre um crash de import
            # ANTES do --log-file do daemon (o "sem log nenhum" da outra máquina).
            # Surfaçamos o tail do daemon-boot.log (que capturamos justamente p/ isso)
            # como erro ALTO — só no boot; o decode fica quieto (fast-fail).
            if attempt_install:
                tail = self._read_tail(self._boot_log_path(), 800)
                self._last_error = VoxEngineError(
                    f"o daemon do motor iniciou mas não respondeu no pipe em "
                    f"{boot_timeout:.0f}s (provável crash de import). "
                    f"daemon-boot.log: {tail}")
            self._next_retry = time.monotonic() + self._cooldown
            return False
        finally:
            self._conn_lock.release()

    # ---- protocolo (framed: [u32 json_len][u32 audio_len][json][audio]) ----
    def _read_exact(self, fh, n):
        """Lê n bytes de UM handle específico (passado explicitamente). Nunca
        relê self._fh — assim uma thread leitora abandonada fica presa no SEU
        pipe e não migra p/ um pipe reconectado (HIGH-1)."""
        buf = b""
        while len(buf) < n:
            chunk = fh.read(n - len(buf))
            if not chunk:
                raise EOFError("pipe fechado")
            buf += chunk
        return buf

    def _request(self, header, audio=b"", timeout=VOX_REQ_TIMEOUT):
        """Envia 1 frame e lê a resposta com TETO de tamanho e TIMEOUT.

        A leitura roda numa thread separada presa ao handle ``fh`` capturado
        aqui; o chamador faz join(timeout). Se o motor travar no meio do frame,
        o loop de comandos NÃO congela — vira erro ALTO (VoxEngineError), nunca
        wedge mudo. Header de tamanho absurdo é rejeitado sem ler o corpo."""
        fh = self._fh
        if fh is None:
            raise EOFError("pipe fechado")
        jb = json.dumps(header).encode("utf-8")
        fh.write(struct.pack(">II", len(jb), len(audio)) + jb + audio)
        fh.flush()
        out = {}

        def _read_reply():
            try:
                head = self._read_exact(fh, 8)
                jl, al = struct.unpack(">II", head)
                if jl > VOX_MAX_FRAME or al > VOX_MAX_FRAME:
                    raise ValueError(f"frame absurdo do motor (jl={jl}, al={al})")
                body = self._read_exact(fh, jl)
                audio_out = self._read_exact(fh, al) if al else b""
                out["resp"] = (json.loads(body.decode("utf-8")), audio_out)
            except Exception as exc:   # noqa: BLE001 — vira VoxEngineError no chamador
                out["err"] = exc

        rt = threading.Thread(target=_read_reply, daemon=True)
        rt.start()
        rt.join(timeout)
        if rt.is_alive():
            # Motor travado no meio do frame. NÃO chamamos .close() (fechar com um
            # read() pendente noutra thread BLOQUEIA no lock interno do objeto e
            # travaria o loop — era o wedge). A thread leitora fica presa NO SEU
            # próprio ``fh`` (capturado acima), então nunca lê de um pipe novo, e
            # morre quando esse handle fechar. Soltamos só a referência viva.
            if self._fh is fh:
                self._fh = None
            raise EOFError(f"timeout ({timeout:.0f}s) aguardando resposta do motor")
        if "err" in out:
            raise out["err"]
        return out["resp"]

    def info(self, boot_timeout=60.0):
        """{model, provider, stt_ready, ...} do motor, ou levanta VoxEngineError.

        Se o motor não subiu, levanta a mensagem DETALHADA capturada em ``ensure``
        (tail do install.ps1: "nenhum Python 3.11+…"; falha de lançamento; ou o
        tail do daemon-boot.log num crash de import) em vez do genérico
        "indisponível" — o erro chega ALTO e ÚTIL na UI."""
        if not self.ensure(boot_timeout=boot_timeout):
            raise self._last_error or VoxEngineError(
                "motor de voz (vox-engine) indisponível")
        with self._lock:
            if self._fh is None:
                raise VoxEngineError("conexão com o motor caiu")
            try:
                self._rid += 1
                h, _ = self._request({"cmd": "info", "req_id": str(self._rid)})
                return h
            except Exception as exc:   # QUALQUER falha de framing → erro ALTO (sem mudo)
                self._close_fh()
                raise VoxEngineError(f"falha ao consultar o motor: {exc}") from exc

    def transcribe(self, seg, language):
        """seg (float32 16k numpy) -> texto (str). LEVANTA :class:`VoxEngineError`
        em qualquer falha — sem fallback silencioso, sem erro mudo. Fast-fail
        (boot_timeout=0): não trava o thread de decode esperando o daemon subir."""
        if not self.ensure(boot_timeout=0.0):
            raise VoxEngineError("motor de voz (vox-engine) indisponível")
        with self._lock:
            if self._fh is None:
                raise VoxEngineError("conexão com o motor caiu")
            try:
                self._rid += 1
                pcm = np.ascontiguousarray(seg, dtype="<f4").tobytes()
                h, _ = self._request({"cmd": "transcribe", "req_id": str(self._rid),
                                      "session": "voice-chat", "lang": language or "",
                                      "profile": self._profile}, pcm)
            except Exception as exc:   # OSError/EOFError/ValueError/struct.error/numpy… → ALTO
                self._close_fh()   # reconecta na próxima chamada
                raise VoxEngineError(f"falha ao falar com o motor: {exc}") from exc
            if h.get("event") == "result":
                return (h.get("text") or "").strip()
            raise VoxEngineError(
                f"motor retornou {h.get('event')}/{h.get('code')}: {h.get('message') or ''}")

    def close(self):
        try:
            if self._fh:
                self._fh.close()
        except OSError:
            pass
        self._fh = None


def main():
    state = {"language": (os.environ.get("VOICE_LANG", "pt").strip() or "pt"),
             "model": MODEL}
    recorder = Recorder()

    rec_lock = threading.Lock()

    def _vox_status(msg):
        """Progresso VISÍVEL do motor (ex.: instalação de 1ª vez, que leva minutos):
        evento 'loading' (NÃO 'error') — a UI mostra estado de carregamento com a
        mensagem, sem acender o erro fatal nem incrementar o contador de falhas.
        Garante que a UI NÃO fique muda enquanto o install baixa deps/CUDA."""
        emit({"event": "loading", "source": "vox-engine", "msg": msg})

    vox = _VoxBridge(status_cb=_vox_status)
    recognizer = None

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
                  "device": state.get("device", "?")}
        log("vox-engine recuperado")
        emit(ev)

    if VOX_ENGINE_ENABLED:
        # MODO MOTOR (padrão): o STT vem SÓ do vox-engine. Sem recognizer local,
        # sem fallback silencioso — se o motor falhar, erro ALTO na UI. O boot
        # roda em background (não trava o loop de comandos) e retenta; o 1º erro
        # é fatal p/ a UI mostrar "motor indisponível", e um 'ready' posterior
        # recupera sozinho quando o motor sobe.
        log(f"vox-engine: modo motor (pipe={VOX_PIPE}, profile={VOX_PROFILE}); sem fallback local")

        def _motor_boot():
            attempt = 0
            while True:
                try:
                    nfo = vox.info()
                    dev = nfo.get("provider") or "?"
                    mdl = nfo.get("model") or VOX_PROFILE
                    state["device"] = dev
                    state["model"] = mdl
                    log(f"vox-engine pronto (model={mdl}, device={dev})")
                    with _vox_state_lock:
                        _vox_fail[0] = 0
                        _vox_fatal_shown[0] = False
                    emit({"event": "ready", "model": mdl, "source": "vox-engine",
                          "language": state["language"], "device": dev})
                    return
                except VoxEngineError as exc:
                    attempt += 1
                    _emit_vox_error(f"{exc} (tentativa {attempt})", force_fatal=True)
                    if attempt >= 12:
                        log("vox-engine: boot desistiu após várias tentativas; segue em erro")
                        return
                    time.sleep(min(5.0, float(attempt)))
        threading.Thread(target=_motor_boot, daemon=True).start()
    else:
        # MODO LOCAL EXPLÍCITO (VOICE_USE_VOX_ENGINE=0): escolha deliberada do
        # usuário, NÃO um fallback automático.
        try:
            recognizer = build_recognizer(state["model"], state["language"])
        except Exception as exc:
            log("model load failed:\n" + traceback.format_exc())
            emit({"event": "error", "fatal": True,
                  "msg": f"Falha ao carregar modelo: {exc}"})
            return
        emit({"event": "ready", "model": state["model"],
              "language": state["language"], "device": EFFECTIVE_PROVIDER})
        log(f"ready LOCAL (model={state['model']}, language={state['language']}, device={EFFECTIVE_PROVIDER})")

    try:
        emit({"event": "gpu_status", **gpu_status()})
    except Exception as exc:
        log(f"gpu_status failed: {exc}")
    _mok, _mname, _mreason = detect_mic()
    emit({"event": "mic", "ok": _mok, "name": _mname, "reason": _mreason})
    emit({"event": "mics", **list_mics()})
    threading.Thread(target=mic_monitor, daemon=True).start()

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

        MOTOR-ONLY quando VOX_ENGINE_ENABLED: sem fallback local, sem erro mudo.
        Falha do motor → erro ALTO na UI e o segmento é descartado (o worker
        segue vivo e reconecta no próximo). Modo LOCAL só quando
        VOICE_USE_VOX_ENGINE=0 (opt-out deliberado, não fallback automático).

        ``raise_on_motor_fail`` (usado por transcribe_file) propaga a
        :class:`VoxEngineError` p/ o chamador reportar ``ok:false`` — em vez de
        um "" indistinguível de silêncio (falha muda na fronteira da API).
        """
        TTS_IDLE.wait(timeout=6.0)
        if VOX_ENGINE_ENABLED:
            try:
                text = vox.transcribe(seg, state["language"])
                _vox_recovered()   # motor respondeu: limpa estado de erro se havia
                return text
            except VoxEngineError as exc:
                _emit_vox_error(str(exc))
                if raise_on_motor_fail:
                    raise
                return ""
        with rec_lock:
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, seg)
            recognizer.decode_stream(stream)
            return (stream.result.text or "").strip()

    recorder.set_decoder(decode_seg)

    wake = WakeListener(decode_seg, WAKE_PHRASES)
    hub = AudioHub(recorder, wake)

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
                new_model = (msg.get("model") or state["model"]).strip()
                if new_lang != state["language"] or new_model != state["model"]:
                    if VOX_ENGINE_ENABLED:
                        # MODO MOTOR: nada de recognizer local. A língua é passada
                        # ao motor por transcrição; o modelo é decidido pelo perfil
                        # do motor. Só registra e reconfirma prontidão.
                        state["language"] = new_lang
                        state["model"] = new_model
                        emit({"event": "ready", "model": new_model, "source": "vox-engine",
                              "language": new_lang, "device": state.get("device", "?")})
                    else:
                        emit({"event": "loading", "stage": "init",
                              "msg": "Reconfigurando..."})
                        new_recognizer = build_recognizer(new_model, new_lang)
                        with rec_lock:
                            recognizer = new_recognizer
                        state["language"] = new_lang
                        state["model"] = new_model
                        emit({"event": "ready", "model": new_model,
                              "language": new_lang, "device": EFFECTIVE_PROVIDER})
            elif cmd == "tts":
                synthesize_tts(msg)
            elif cmd == "tts_voice":
                set_tts_voice(msg.get("voice"))
            elif cmd == "gpu_status":
                emit({"event": "gpu_status", **gpu_status()})
            elif cmd == "gpu_setup":
                handle_gpu_setup()
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
                    parts = [decode_seg(seg, raise_on_motor_fail=True)
                             for seg in segment_audio(arr, SAMPLE_RATE)]
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
