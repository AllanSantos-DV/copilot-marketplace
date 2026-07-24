"""CapturePort — contrato fino do worker para captura REMOTA de microfone.

Hoje cada fork do worker abre o próprio ``InputStream`` (sounddevice) e roda a
segmentação/transcrição localmente, carregando numpy+sounddevice em RAM privada
por sessão. A partir da Fase 1 o daemon (vox-engine 0.20.0+) roda a pipeline
INTEIRA in-process (MicCapture → StreamSegmenter → StreamingTranscriber → hub) e
EMPURRA o TRANSCRITO por segmento pelo pipe ``\\\\.\\pipe\\vox``. O worker só
encaminha esses segmentos — não vê áudio cru — o que tira numpy+sounddevice do
fork (o ganho de USS que justifica o refactor).

Este módulo é o SEAM: o worker depende só de ``CapturePort``. Dois adapters o
satisfazem — ``FakeCaptureAdapter`` (aqui, para testes isolados sem pipe/daemon)
e ``VoxPipeCaptureAdapter`` (Fase 4, embrulha ``vox_sdk.capture()``). Ambos
reusam ``QueueCaptureStream``: a ponte callback→iterador thread-safe.

Síncrono POR DESIGN — o runtime do worker é 100% threaded, nunca asyncio. Um
stream de captura expõe ``events()``: um gerador BLOQUEANTE que o worker itera
numa thread dedicada; ``cancel()``/``close()`` são seguros de qualquer thread e
fazem ``events()`` retornar em <100ms (via sentinela na fila, sem polling).
"""
from __future__ import annotations

import queue
import threading
from dataclasses import dataclass
from typing import Iterator, List, Optional, Protocol, Tuple, Union, runtime_checkable


# --- Taxonomia de eventos (tag pela CLASSE; espelha o wire do vox) ------------

@dataclass(frozen=True)
class CaptureSegment:
    """Segmento de transcrição FINALIZADO (vox ``capture_segment{idx,text}``).

    Cada ``capture_segment`` já é uma janela completa do segmenter — não há
    ``partial``/``final`` separado hoje: recebeu, está pronto para encaminhar.
    """

    idx: int
    text: str


@dataclass(frozen=True)
class CaptureLevel:
    """Metering periódico do mic para o anel de VU (vox ``capture_level``, ~10Hz).

    OPCIONAL no stream: daemons que não emitem → o worker cai no VU-degradado.
    Vem pronto do metering do daemon (reusa o ``rms_energy`` do core) → o worker
    só lê os números, ZERO numpy do lado dele.
    """

    rms: float
    peak: float
    silent: bool = False


@dataclass(frozen=True)
class CaptureClosed:
    """Sumário de fim de captura (vox ``capture_closed``). ``ok=False`` = abortada.

    Espelha ``handleVoiceTranscript``/``Recorder.stop()`` do modelo antigo: o
    ``text`` agregado + métricas da captura, para o worker fechar o turno. ``errors``
    é a LISTA de mensagens do wire (tupla p/ frozen-safe); ``cancelled=True`` quando
    veio de um ``cancel()`` (abort) em vez de ``close()`` (graceful).
    """

    ok: bool
    text: Optional[str] = None
    peak: float = 0.0
    duration_s: float = 0.0
    chunks: int = 0
    skipped_silence: int = 0
    dropped: int = 0
    errors: Tuple[str, ...] = ()
    mic_ok: bool = True
    cancelled: bool = False


@dataclass(frozen=True)
class CaptureError:
    """Falha TIPADA (vox ``{event:error, code}`` ou ``pipe_broken`` client-side).

    Códigos reais (do capture_service do vox + read-loop do SDK):
      * abertura: ``busy`` (in-daemon), ``mic_busy`` (cross-process mic.lock),
        ``already_open``, ``mic_open_failed`` (device lançou)
      * ciclo: ``capture_timeout`` (owner-thread sem ack = device travado),
        ``not_open``, ``not_owner``, ``capture_internal``, ``device_fail``
        (``capture_error`` assíncrono durante a captura)
      * client-side: ``pipe_broken`` (o read-loop do SDK vê o pipe cair)
    """

    code: str
    message: str = ""


CaptureEvent = Union[CaptureSegment, CaptureLevel, CaptureClosed, CaptureError]

# Mapeamento de código → tratamento no worker (Fase 5): toast "mic ocupado" vs
# erro de device vs erro ALTO. Exposto aqui para o worker não re-hardcodar strings.
BUSY_CODES = frozenset({"busy", "mic_busy", "already_open"})
DEVICE_CODES = frozenset({"mic_open_failed", "device_fail"})


# --- Ports (o que o worker conhece) -------------------------------------------

@runtime_checkable
class CaptureStream(Protocol):
    """Uma captura aberta. Itere ``events()`` numa thread do worker; ``cancel()``
    /``close()`` são seguros de qualquer thread e encerram ``events()`` em ~100ms."""

    def events(self) -> Iterator[CaptureEvent]: ...

    def cancel(self) -> None: ...

    def close(self, timeout: float | None = None) -> None: ...


@runtime_checkable
class CapturePort(Protocol):
    """Abre streams de captura para uma sessão — a ÚNICA dependência de captura
    que o worker enxerga."""

    def open(self, session_id: str) -> CaptureStream: ...


# --- Ponte callback→iterador (reusada por Fake e VoxPipe) ---------------------

_SENTINEL = object()  # empurrado para desbloquear events() em cancel/close


class QueueCaptureStream:
    """Ponte thread-safe: produtores empurram ``CaptureEvent``, ``events()`` drena.

    O read-loop do ``VoxPipeCaptureAdapter`` (thread do pipe) chama ``emit()``
    aqui a cada mensagem do wire; o ``FakeCaptureAdapter`` chama de uma thread
    roteirizada. ``cancel()``/``close()`` injetam a sentinela para um ``events()``
    bloqueado retornar na hora (<100ms), sem polling.

    Semântica: ``close()`` = GRACEFUL (drena o que já está na fila e encerra);
    ``cancel()`` = ABORT (encerra JÁ, descartando bufferizados). Um evento
    terminal (``CaptureClosed``/``CaptureError``) também encerra ``events()``.
    """

    def __init__(self) -> None:
        self._q: "queue.Queue[object]" = queue.Queue()
        self._lock = threading.Lock()
        self._closed = False
        self._cancelled = threading.Event()

    # --- lado produtor -------------------------------------------------------
    def emit(self, event: CaptureEvent) -> None:
        """Enfileira um evento. No-op se o stream já fechou/cancelou (fail-safe:
        um read-loop atrasado não empurra depois do teardown)."""
        with self._lock:
            if self._closed:
                return
        self._q.put(event)

    # --- lado consumidor -----------------------------------------------------
    def events(self) -> Iterator[CaptureEvent]:
        while True:
            item = self._q.get()
            if item is _SENTINEL or self._cancelled.is_set():
                return
            event = item  # type: ignore[assignment]
            yield event  # type: ignore[misc]
            if isinstance(event, (CaptureClosed, CaptureError)):
                return

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def cancel(self) -> None:
        self._cancelled.set()
        with self._lock:
            self._closed = True
        self._q.put(_SENTINEL)

    def close(self, timeout: float | None = None) -> None:
        # ``timeout`` é IGNORADO aqui (a fila fecha na hora, sem esperar rede): existe só p/ a
        # assinatura casar com ``VoxPipeCaptureStream.close(timeout)`` (o adapter real ESPERA o
        # ``capture_closed`` do daemon até ``timeout``) — assim o ``CaptureSession.stop`` chama
        # ``close(timeout=...)`` uniformemente nos dois (fake de teste e pipe real).
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._q.put(_SENTINEL)


# --- Fake para testes isolados (sem pipe, sem daemon, sem numpy) --------------

class FakeCaptureStream(QueueCaptureStream):
    """Stream roteirizado: emite ``script`` = lista de ``(delay_s, event)`` numa
    thread após ``open()``. O ``delay`` simula a cadência do daemon e exercita o
    cancel cross-thread (um delay longo deixa ``events()`` bloqueado)."""

    def __init__(self, script: List[Tuple[float, CaptureEvent]]) -> None:
        super().__init__()
        self._script = script
        self._thread: Optional[threading.Thread] = None

    def _start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name="fake-capture", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        for delay, event in self._script:
            # sleep INTERRUPTÍVEL: cancel/close acorda a thread na hora
            if self._cancelled.wait(delay):
                return
            self.emit(event)  # no-op se já fechou


class FakeCaptureAdapter:
    """``CapturePort`` roteirizado para testes. Guarda o que foi aberto para
    asserção; cada ``open()`` inicia um ``FakeCaptureStream`` com o mesmo script."""

    def __init__(self, script: Optional[List[Tuple[float, CaptureEvent]]] = None) -> None:
        self._script = list(script or [])
        self.opened: List[str] = []
        self.last_stream: Optional[FakeCaptureStream] = None

    def open(self, session_id: str) -> CaptureStream:
        self.opened.append(session_id)
        stream = FakeCaptureStream(list(self._script))
        self.last_stream = stream
        stream._start()
        return stream
