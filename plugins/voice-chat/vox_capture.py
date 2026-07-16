"""Captura de microfone reutilizável (mic → transcrição) — flat VENDORÁVEL.

Portado FIELMENTE de ``vox_engine/client/capture.py``. Arquivo canônico que os consumidores
copiam BYTE-A-BYTE para o seu ``vendor/`` (o ``sdk/check-drift.mjs`` garante a fidelidade).
Construído SOBRE os flats irmãos ``vox_stream`` (StreamingTranscriber) e ``vox_audio_devices``
(resolução de device) — NUNCA importa ``vox_engine``.

Import-safety (o consumidor pode importar os vendored ANTES de instalar as deps em runtime):
``numpy`` e ``vox_stream`` são importados LAZY dentro de ``start()``; ``sounddevice`` também é
lazy. Então ``import vox_capture`` funciona numa máquina limpa (só puxa ``vox_audio_devices``,
que é stdlib). As deps pesadas só são tocadas quando a captura de fato começa.

``MicCapture`` POSSUI o stream do mic (16 kHz mono float32), copia cada bloco no callback do
PortAudio e segmenta numa thread própria (nunca na thread de áudio), alimenta o
``StreamingTranscriber`` (STT sobreposto) e devolve um :class:`CaptureResult` no ``stop()``.
Fora de escopo (fica no app): paste, overlay/GUI, hotkey, tray, foco de janela.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from vox_audio_devices import resolve_input_device

_log = logging.getLogger("vox.capture")

SAMPLE_RATE = 16000
CHUNK_TARGET_S = 8.0
WHISPER_MAX_S = 28.0

OnSegment = Callable[[int, str], None]
OnRms = Callable[[int, float], None]
OnLevel = Callable[[float], None]
OnError = Callable[[str], None]
SegmentFilter = Callable[[str], bool]


class CaptureOpenError(RuntimeError):
    """O microfone não pôde ser aberto (device escolhido E automático falharam). ``start()``
    levanta isto DEPOIS de desmontar worker/stream — o chamador nunca fica preso em 'ativo'."""


@dataclass
class CaptureResult:
    """Resultado estruturado de uma sessão de captura (devolvido por ``stop()``)."""
    text: str = ""
    peak: float = 0.0
    duration_s: float = 0.0
    chunks: int = 0
    skipped_silence: int = 0
    dropped: int = 0
    errors: list = field(default_factory=list)
    mic_ok: bool = True


class MicCapture:
    """Uma sessão de captura mic→transcrição. Construa, ``start()``, ``stop()->CaptureResult``.
    ``client`` é um VoxClient já pronto (duck-typed: precisa de ``transcribe(samples, ...)``)."""

    def __init__(self, client, *, on_segment: OnSegment, lang: str = "",
                 session: str = "capture", profile: "str | None" = "dictation",
                 input_device: "str | int | None" = None, min_rms: float = 0.0,
                 on_segment_rms: Optional[OnRms] = None, on_level: Optional[OnLevel] = None,
                 on_error: Optional[OnError] = None,
                 segment_filter: Optional[SegmentFilter] = None,
                 priority: str = "interactive", model: "str | None" = None,
                 timeout: float = 60.0, chunk_target_s: float = CHUNK_TARGET_S,
                 hard_s: float = WHISPER_MAX_S, max_pending: int = 64,
                 feed_queue_max: int = 256) -> None:
        self._client = client
        self._on_segment = on_segment
        self._lang = lang
        self._session = session
        self._profile = profile
        self._input_device = input_device
        self._min_rms = min_rms
        self._on_segment_rms = on_segment_rms
        self._on_level = on_level
        self._on_error = on_error
        self._segment_filter = segment_filter
        self._priority = priority
        self._model = model
        self._timeout = timeout
        self._chunk_target_s = chunk_target_s
        self._hard_s = hard_s
        self._max_pending = max_pending

        self._np = None
        self._lock = threading.Lock()
        self._active = False
        self._mic_ok = True
        self._stream = None
        self._trans = None
        self._feeder: Optional[threading.Thread] = None
        self._feed_q: "queue.Queue" = queue.Queue(maxsize=feed_queue_max)
        self._accepted: dict = {}
        self._extra_errors: list = []
        self._peak = 0.0
        self._chunks = 0
        self._dropped = 0
        self._rejected = 0
        self._start_ts = 0.0

    @property
    def active(self) -> bool:
        return self._active

    @property
    def mic_ok(self) -> bool:
        return self._mic_ok

    def start(self) -> None:
        """Abre o microfone e começa a capturar. Se o device pedido falhar, cai no automático;
        se AMBOS falharem, desmonta tudo e levanta :class:`CaptureOpenError`."""
        with self._lock:
            if self._active:
                return
            self._active = True
            self._accepted = {}
            self._extra_errors = []
            self._peak = 0.0
            self._chunks = 0
            self._dropped = 0
            self._rejected = 0
            self._mic_ok = True
        try:
            import numpy as np                       # LAZY: só ao capturar de fato
            import sounddevice as sd
            from vox_stream import StreamingTranscriber
        except Exception as exc:  # noqa: BLE001 — deps de captura ausentes/quebradas (numpy/
            # sounddevice/vox_stream). Converte p/ CaptureOpenError ANTES de subir thread/stream,
            # resetando o estado — senão o consumidor ficaria preso em "ativo" (a exceção crua
            # escaparia do start(), que o chamador só trata como CaptureOpenError).
            with self._lock:
                self._active = False
            raise CaptureOpenError(f"captura de áudio indisponível: {exc}")

        self._np = np
        self._trans = StreamingTranscriber(
            self._client, lang=self._lang, session=self._session, priority=self._priority,
            profile=self._profile, model=self._model, timeout=self._timeout,
            chunk_target_s=self._chunk_target_s, hard_s=self._hard_s,
            max_pending=self._max_pending, min_rms=self._min_rms,
            on_segment=self._handle_segment, on_rms=self._handle_seg_rms)
        self._feeder = threading.Thread(target=self._feed_loop, name="vox-capture-feed",
                                        daemon=True)
        self._feeder.start()
        self._start_ts = time.monotonic()

        def _cb(indata, frames, time_info, status):  # noqa: ANN001 — assinatura do PortAudio
            if not self._active:
                return
            try:
                chunk = np.array(indata, dtype=np.float32).reshape(-1)  # COPIA (buffer reusado)
            except Exception:  # noqa: BLE001
                return
            try:
                self._feed_q.put_nowait(chunk)
            except queue.Full:
                with self._lock:
                    self._dropped += 1

        def _open(dev):
            st = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                callback=_cb, device=dev)
            try:
                st.start()
            except Exception:
                try:
                    st.close()
                except Exception:  # noqa: BLE001
                    pass
                raise
            return st

        requested = self._resolve_device()
        try:
            self._stream = _open(requested)
            self._mic_ok = True
        except Exception as exc:  # noqa: BLE001
            _log.warning("falha ao abrir o microfone (device=%r): %s", requested, exc)
            if requested is not None:
                try:
                    self._stream = _open(None)
                    self._mic_ok = False
                    self._notify_error(
                        f"Não consegui abrir o microfone {self._input_device!r}. "
                        f"Capturando no automático.")
                    return
                except Exception as exc2:  # noqa: BLE001
                    _log.error("fallback p/ microfone automático também falhou: %s", exc2)
                    exc = exc2
            self._teardown_partial()
            raise CaptureOpenError(f"não consegui abrir o microfone: {exc}")

    def _resolve_device(self) -> "int | None":
        dev = self._input_device
        if isinstance(dev, int):
            return dev
        return resolve_input_device(dev)

    def _feed_loop(self) -> None:
        np = self._np
        while True:
            chunk = self._feed_q.get()
            if chunk is None:
                return
            if chunk.size:
                rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
                with self._lock:
                    self._chunks += 1
                    if rms > self._peak:
                        self._peak = rms
                if self._on_level is not None:
                    try:
                        self._on_level(rms)
                    except Exception:  # noqa: BLE001
                        pass
            trans = self._trans
            if trans is not None:
                try:
                    trans.feed(chunk)
                except Exception as e:  # noqa: BLE001
                    with self._lock:
                        self._extra_errors.append(repr(e))

    def _handle_segment(self, idx: int, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        if self._segment_filter is not None:
            try:
                keep = bool(self._segment_filter(text))
            except Exception:  # noqa: BLE001
                keep = True
            if not keep:
                with self._lock:
                    self._rejected += 1
                return
        with self._lock:
            self._accepted[idx] = text
        try:
            self._on_segment(idx, text)
        except Exception:  # noqa: BLE001
            pass

    def _handle_seg_rms(self, idx: int, rms: float) -> None:
        if self._on_segment_rms is not None:
            try:
                self._on_segment_rms(idx, rms)
            except Exception:  # noqa: BLE001
                pass

    def _notify_error(self, msg: str) -> None:
        with self._lock:
            self._extra_errors.append(msg)
        if self._on_error is not None:
            try:
                self._on_error(msg)
            except Exception:  # noqa: BLE001
                pass

    def stop(self) -> CaptureResult:
        """Para o microfone, drena a cauda (transcrita via ``on_segment``) e devolve o
        :class:`CaptureResult`. NÃO levanta: erros de STT vêm em ``result.errors``."""
        with self._lock:
            if not self._active:
                return CaptureResult(mic_ok=self._mic_ok)
            self._active = False
        self._close_stream()
        self._drain_feeder(discard=False)
        trans = self._trans
        self._trans = None
        if trans is not None:
            try:
                trans.finish()
            except Exception as e:  # noqa: BLE001
                with self._lock:
                    self._extra_errors.append(repr(e))
        return self._build_result(trans)

    def cancel(self) -> None:
        """Aborta: para o mic, DESCARTA o áudio pendente sem transcrever e encerra o worker."""
        with self._lock:
            if not self._active:
                return
            self._active = False
        self._close_stream()
        self._drain_feeder(discard=True)
        trans = self._trans
        self._trans = None
        if trans is not None:
            try:
                trans.cancel()
            except Exception:  # noqa: BLE001
                pass

    def _close_stream(self) -> None:
        st = self._stream
        self._stream = None
        if st is not None:
            try:
                st.stop()
                st.close()
            except Exception:  # noqa: BLE001
                pass

    def _drain_feeder(self, *, discard: bool) -> None:
        feeder = self._feeder
        self._feeder = None
        if feeder is None:
            return
        if discard:
            try:
                while True:
                    self._feed_q.get_nowait()
            except queue.Empty:
                pass
        self._feed_q.put(None)
        feeder.join()

    def _teardown_partial(self) -> None:
        with self._lock:
            self._active = False
        self._close_stream()
        self._drain_feeder(discard=True)
        trans = self._trans
        self._trans = None
        if trans is not None:
            try:
                trans.cancel()
            except Exception:  # noqa: BLE001
                pass

    def _build_result(self, trans) -> CaptureResult:
        with self._lock:
            text = " ".join(self._accepted[i] for i in sorted(self._accepted)
                            if self._accepted[i]).strip()
            peak, chunks, dropped = self._peak, self._chunks, self._dropped
            errors = list(self._extra_errors)
            mic_ok = self._mic_ok
        skipped = 0
        if trans is not None:
            errors = list(trans.errors) + errors
            skipped = trans.skipped_silence
        duration = (time.monotonic() - self._start_ts) if self._start_ts else 0.0
        return CaptureResult(text=text, peak=peak, duration_s=duration, chunks=chunks,
                             skipped_silence=skipped, dropped=dropped, errors=errors,
                             mic_ok=mic_ok)


def dictate_stream(client, *, on_segment: OnSegment, **opts) -> MicCapture:
    """Açúcar: constrói uma :class:`MicCapture`, já chama ``start()`` e devolve o handle."""
    cap = MicCapture(client, on_segment=on_segment, **opts)
    cap.start()
    return cap
