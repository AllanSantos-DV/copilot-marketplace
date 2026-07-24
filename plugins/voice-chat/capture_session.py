"""CaptureSession — gravação FINA sobre o ``CapturePort`` (Fase 5 do worker fino).

Substitui o trio ``Recorder`` + ``AudioHub``(InputStream) + ``StreamingTranscriber``
local: em vez de abrir um ``sd.InputStream`` e rodar STT no fork (numpy+sounddevice na
RAM por sessão), abre uma captura no DAEMON via ``CapturePort`` e CONSOME numa thread os
eventos JÁ transcritos. O daemon é dono do mic e da pipeline; o worker só encaminha.
ZERO numpy/sounddevice aqui.

Preserva o contrato do worker:
  * emite os MESMOS eventos de UI (``recording`` / ``level``) que o Recorder emitia;
  * ``stop()`` devolve o MESMO ``res`` ``{text,dur_ms,ms,peak,voiced_run_ms,chunks}``
    que ``build_stop_events`` consome — então o resto do worker/extension não muda.

Mapa de erro (taxonomia do CapturePort → ação do worker):
  * ``busy``/``mic_busy``/``already_open`` (BUSY_CODES) → ``{event:error, code:mic_busy}``
    e NÃO é fatal (outro fork/consumidor tem o mic; a sessão sobrevive).
  * qualquer outro (``device_fail``/``pipe_broken``/``capture_timeout``/…) → FATAL:
    ``{event:error, code:capture_lost}`` (o caller encerra a sessão).
"""
from __future__ import annotations

import threading
import time
from typing import Callable, List, Optional

from capture_port import (
    BUSY_CODES,
    CaptureClosed,
    CaptureError,
    CaptureLevel,
    CapturePort,
    CaptureSegment,
)

EmitFn = Callable[[dict], None]


class CaptureSession:
    """Uma captura PTT (ou mãos-livres — mesmo fluxo) sobre o ``CapturePort``.

    ``begin(sid)`` abre a captura e sobe a thread consumidora; ``stop()`` fecha
    (graceful, drena a cauda) e devolve o ``res``; ``cancel()`` aborta (descarta)."""

    def __init__(self, port: CapturePort, emit: EmitFn, *,
                 now: Callable[[], float] = time.monotonic,
                 join_timeout: float = 10.0, close_timeout: float = 300.0) -> None:
        self._port = port
        self._emit = emit
        self._now = now
        self._join_timeout = join_timeout
        # ``close_timeout``: quanto o ``stop()`` ESPERA o daemon transcrever a CAUDA e devolver o
        # ``capture_closed`` (via ``VoxPipeCaptureStream.close`` → ``handle.close``). Generoso DE
        # PROPÓSITO (default 300s): o fim da fala é transcrito com o modelo do perfil, NUNCA
        # descartado por um prazo curto (era o bug do "corta a última frase": 8s estouravam sob
        # STT lento → o worker derrubava a conexão → o daemon cancelava e descartava a cauda). A
        # morte REAL de device continua fail-loud pelo watchdog do daemon (não espera este teto).
        self._stream = None
        self._thread: Optional[threading.Thread] = None
        self._recording = False
        self._quiet = False
        self._started_at = 0.0
        self._stopped = False              # latch: terminal (stop/cancel) já ocorreu
        self._res: Optional[dict] = None   # res cacheado → stop() idempotente
        self._close_timeout = close_timeout
        self._emit_lock = threading.Lock()  # serializa emit: _consume(thread) × main
        # coletado pela thread consumidora:
        self._partials: List[str] = []
        self._summary: Optional[CaptureClosed] = None
        self._fatal: Optional[CaptureError] = None
        self._busy: Optional[CaptureError] = None
        self._max_peak = 0.0

    def _safe_emit(self, msg: dict) -> None:
        """Emit SERIALIZADO: begin/stop (main) e _consume (thread) chamam o mesmo
        callback — no worker real ele escreve JSON emoldurado no stdout, e 2 threads
        sem lock intercalariam os bytes e corromperiam um frame."""
        with self._emit_lock:
            self._emit(msg)

    # --- ciclo de vida -----------------------------------------------------------
    def begin(self, sid: str, quiet: bool = False) -> None:
        # "ativo" = thread consumidora VIVA (não uma flag): um erro terminal assíncrono
        # encerra a thread mas NÃO limpa a flag — basear-se na thread viva evita o wedge
        # (record-button morto após device_fail/pipe_broken sem um stop() explícito).
        if self._thread is not None and self._thread.is_alive():
            return
        # captura anterior que morreu por erro e não foi fechada pelo caller: cancela
        # best-effort p/ não vazar a captura no daemon antes de abrir a nova.
        if self._stream is not None and not self._stopped:
            try:
                self._stream.cancel()
            except Exception:
                pass
        self._quiet = quiet
        self._partials = []
        self._summary = None
        self._fatal = None
        self._busy = None
        self._max_peak = 0.0
        self._stopped = False
        self._res = None
        self._started_at = self._now()
        self._stream = self._port.open(sid)
        self._recording = True
        if not quiet:
            # ANTES do start: garante recording:true ANTES de qualquer level da thread.
            self._safe_emit({"event": "recording", "state": True})
        self._thread = threading.Thread(target=self._consume, name="capture-consume",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> dict:
        """GRACEFUL: fecha a captura (o daemon drena a cauda transcrita → ``CaptureClosed``),
        junta a thread e devolve o ``res`` para ``build_stop_events``. IDEMPOTENTE: um 2º
        ``stop()`` devolve o MESMO res cacheado sem re-emitir nem re-fechar (senão o comando
        de voz seria despachado 2×)."""
        if self._stopped:
            return self._res if self._res is not None else {"text": "", "dur_ms": 0, "ms": 0, "chunks": 0}
        if self._thread is None and not self._recording:
            self._stopped = True
            self._res = {"text": "", "dur_ms": 0, "ms": 0, "chunks": 0}
            return self._res
        if self._stream is not None:
            self._stream.close(timeout=self._close_timeout)   # ESPERA a cauda transcrever (sem prazo curto)
        joined = self._join()
        self._recording = False
        self._stopped = True
        self._res = self._build_res(stuck=not joined)
        if not self._quiet:
            self._safe_emit({"event": "recording", "state": False})
        return self._res

    def cancel(self) -> None:
        """ABORT: descarta a captura (mic roubado / cancelamento do PTT). IDEMPOTENTE."""
        if self._stopped:
            return
        if self._stream is not None:
            self._stream.cancel()
        self._join()
        self._recording = False
        self._stopped = True
        if not self._quiet:
            self._safe_emit({"event": "recording", "state": False})
    @property
    def fatal(self) -> Optional[CaptureError]:
        """Preenchido quando a captura morreu por erro NÃO-busy (o caller encerra a sessão)."""
        return self._fatal

    # --- thread consumidora ------------------------------------------------------
    def _consume(self) -> None:
        assert self._stream is not None
        for ev in self._stream.events():
            if isinstance(ev, CaptureSegment):
                if ev.text:
                    self._partials.append(ev.text)
            elif isinstance(ev, CaptureLevel):
                if ev.peak > self._max_peak:
                    self._max_peak = ev.peak
                if not self._quiet:
                    self._safe_emit({"event": "level", "rms": round(ev.rms, 5),
                                     "peak": round(ev.peak, 4)})
            elif isinstance(ev, CaptureError):
                if ev.code in BUSY_CODES:
                    self._busy = ev
                    self._safe_emit({"event": "error", "code": "mic_busy",
                                     "message": ev.message})
                else:
                    self._fatal = ev
                    self._safe_emit({"event": "error", "code": "capture_lost",
                                     "message": ev.message, "cause": ev.code})
            elif isinstance(ev, CaptureClosed):
                self._summary = ev

    def _join(self) -> bool:
        """Junta a thread consumidora. Devolve True se ela ENCERROU; em TIMEOUT (thread
        travada, ex.: um emit→stdout preso num reader lento) NÃO zera a ref — senão um
        novo ``begin()`` rodaria em cima de uma zumbi que ainda muta ``_partials`` da
        próxima captura — e sinaliza fail-loud (``capture_lost``/``consume_stuck``)."""
        t = self._thread
        if t is None:
            return True
        t.join(timeout=self._join_timeout)
        if t.is_alive():
            if self._fatal is None:
                self._fatal = CaptureError("consume_stuck",
                                           "thread de captura não encerrou a tempo")
            self._safe_emit({"event": "error", "code": "capture_lost",
                             "message": "captura travou", "cause": "consume_stuck"})
            return False
        self._thread = None
        return True

    # --- resultado (formato que build_stop_events consome) -----------------------
    def _build_res(self, stuck: bool = False) -> dict:
        summary = self._summary
        if summary is not None and summary.text:
            text = summary.text
        else:
            text = " ".join(self._partials)
        # peak = envelope REAL da captura: o MAIOR entre os levels vistos ao vivo e o
        # pico reportado no sumário (nenhum dos dois sozinho é garantidamente o teto).
        peak = max(self._max_peak, summary.peak if summary else 0.0)
        dur_ms = int(summary.duration_s * 1000) if summary else 0
        chunks = summary.chunks if (summary and summary.chunks) else len(self._partials)
        ms = int((self._now() - self._started_at) * 1000)
        # voiced_run_ms=None → build_stop_events cai no gate de pico (o daemon já entrega
        # o peak real da captura; o run-de-voz local não existe mais no worker fino).
        res = {"text": text, "dur_ms": dur_ms, "ms": ms, "peak": round(peak, 5),
               "voiced_run_ms": None, "chunks": chunks}
        if stuck:
            res["stuck"] = True   # fail-loud: a thread não encerrou; o res pode ser parcial
        return res
