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
import tarfile
import threading
import traceback
import wave
import re
import queue
import shutil
import unicodedata
from collections import deque

try:
    import truststore
    truststore.inject_into_ssl()
except Exception as exc:  
    print(f"[worker] truststore unavailable: {exc}", file=sys.stderr, flush=True)


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
    import subprocess
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install",
                               "--disable-pip-version-check", *missing])
    except Exception as exc:  
        cmd = '"' + sys.executable + '" -m pip install ' + " ".join(missing)
        sys.stdout.write(json.dumps({"event": "error", "fatal": True,
                                     "msg": f"Faltam dependências Python. Rode: {cmd}"}) + "\n")
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
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
                               "--disable-pip-version-check"])
        subprocess.check_call([sys.executable, "-m", "pip", "install", spec,
                               "--find-links", SHERPA_CUDA_INDEX,
                               "--disable-pip-version-check"])
        return True, f"Instalado {spec}. Reinicie a voz para ativar a GPU."
    except Exception as exc:
        log("install_sherpa_gpu failed:\n" + traceback.format_exc())
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", f"sherpa-onnx=={base}",
                                   "--disable-pip-version-check"])
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
        self._lock = threading.Lock()

    def _callback(self, indata, frames, time_info, status):  
        block = indata[:, 0].copy()
        if self._rec:
            self._rec_obj.feed(block, status)
        elif self._wake_on:
            self._wake.feed(block)

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
            keep = self._rec or self._wake_on
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
            else:
                self._ensure_closed()
            return res

    def cancel_record(self):
        with self._lock:
            self._rec_obj.cancel()
            self._rec = False
            if self._wake_on:
                self._wake.resume()
            else:
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
                if not self._rec:
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


def main():
    state = {"language": (os.environ.get("VOICE_LANG", "pt").strip() or "pt"),
             "model": MODEL}
    recorder = Recorder()

    try:
        recognizer = build_recognizer(state["model"], state["language"])
    except Exception as exc:
        log("model load failed:\n" + traceback.format_exc())
        emit({"event": "error", "fatal": True,
              "msg": f"Falha ao carregar modelo: {exc}"})
        return

    emit({"event": "ready", "model": state["model"],
          "language": state["language"], "device": EFFECTIVE_PROVIDER})
    emit({"event": "gpu_status", **gpu_status()})
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
    log(f"ready (model={state['model']}, language={state['language']}, device={EFFECTIVE_PROVIDER})")

    rec_lock = threading.Lock()

    def decode_seg(seg):
        """Decode one <=28s segment to text. Serialized so the recorder's
        background streaming thread and its final-tail pass never overlap.
        Also defers (bounded) while a TTS synth is running so decode + synth
        never saturate every core and starve the Node event loop."""
        TTS_IDLE.wait(timeout=6.0)
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
                hub.start_record()
            elif cmd == "stop":
                emit({"event": "status", "state": "transcribing"})
                res = hub.stop_record()
                peak = res.get("peak", 0.0)
                if peak < MIC_SILENCE_PEAK:
                    mok, mname, mreason = detect_mic()
                    if not mok:
                        emit({"event": "mic", "ok": False, "name": mname, "reason": mreason})
                    emit({"event": "transcript", "text": "", "ms": 0,
                          "note": "no_audio", "peak": peak, "micOk": mok})
                elif not res["text"] and res["dur_ms"] < 200:
                    emit({"event": "transcript", "text": "", "ms": 0,
                          "note": "too_short"})
                else:
                    emit({"event": "transcript", "text": res["text"],
                          "ms": res["ms"], "dur_ms": res["dur_ms"],
                          "chunks": res["chunks"]})
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
            elif cmd == "shutdown":
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
