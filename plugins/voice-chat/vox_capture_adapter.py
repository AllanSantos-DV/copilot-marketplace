"""VoxPipeCaptureAdapter — adapter REAL do ``CapturePort`` sobre o pipe do vox (Fase 4).

Embrulha o cliente de captura do ``vox_sdk`` 0.22+: ``VoxClient.capture_open(session,
on_event) -> CaptureHandle``. O SDK **é** o read-loop — conexão de pipe DEDICADA
(``_OverlappedPipe`` overlapped/ctypes, stdlib puro, sem pywin32) com thread-leitora
própria que empurra CADA frame assíncrono pro ``on_event``. Este adapter NÃO faz
``ReadFile``/``CancelIoEx`` (o SDK já faz): ele só **traduz** o frame do wire (dict) na
dataclass frozen do ``CapturePort`` e chama ``emit()`` na ``QueueCaptureStream`` herdada.

Hexagonal: ``capture_port`` é a porta PURA (stdlib, zero vox); este módulo é o ÚNICO que
importa ``vox_sdk`` (o transporte). O worker (Fase 5) depende só de ``CapturePort`` e
recebe este adapter injetado — troca o ``FakeCaptureAdapter`` por este sem tocar na lógica.

Erros de ABERTURA (``busy``/``mic_busy``/``already_open``/``mic_open_failed``/
``capture_unavailable``/``capture_timeout``/``no_session``) o SDK levanta TIPADOS
(``CaptureError``) — NÃO passam pelo ``on_event``. Traduzimos num ``CaptureError``
TERMINAL no stream, para o worker consumir sucesso E falha pela MESMA via (``events()``),
idêntico ao ``FakeCaptureAdapter``.
"""
from __future__ import annotations

import time
from typing import Any, List, Optional

from capture_port import (
    BUSY_CODES,
    CaptureClosed,
    CaptureError,
    CaptureLevel,
    CaptureSegment,
    QueueCaptureStream,
)
# ``CaptureError`` do SDK é a EXCEÇÃO tipada que ``capture_open`` levanta na falha de
# abertura — nome colide com a nossa dataclass-evento, então importamos com alias.
from vox_sdk import CaptureError as SdkCaptureError

__all__ = ["VoxPipeCaptureAdapter", "VoxPipeCaptureStream"]


class VoxPipeCaptureStream(QueueCaptureStream):
    """Stream de captura sobre um ``CaptureHandle`` do ``vox_sdk``.

    Herda a ponte callback→iterador (``QueueCaptureStream``): o ``on_event`` do SDK vira
    ``emit()``. ``close()``/``cancel()`` dirigem o handle do SDK ALÉM da fila herdada.
    """

    def __init__(self) -> None:
        super().__init__()
        self._handle: Optional[Any] = None  # CaptureHandle do SDK, ligado após capture_open

    def _bind(self, handle: Any) -> None:
        self._handle = handle

    # --- tradução wire→dataclass (o ÚNICO emit que o SDK chama) -------------------
    def _on_event(self, frame: dict) -> None:
        """Recebe CADA frame assíncrono do SDK e o traduz num ``CaptureEvent`` tipado.

        Frames desconhecidos são IGNORADOS (forward-compat: um daemon mais novo pode
        empurrar eventos que este worker ainda não conhece — não quebra o stream).
        ``capture_error`` é TERMINAL (encerra ``events()``).
        """
        ev = frame.get("event")
        if ev == "capture_segment":
            self.emit(CaptureSegment(int(frame.get("idx", -1)), str(frame.get("text", ""))))
        elif ev == "capture_level":
            self.emit(CaptureLevel(
                float(frame.get("rms", 0.0)),
                float(frame.get("peak", 0.0)),
                bool(frame.get("silent", False)),
            ))
        elif ev == "capture_error":
            self.emit(CaptureError(
                str(frame.get("code") or "capture_error"),
                str(frame.get("message") or ""),
            ))
        # else: frame desconhecido -> ignora (não quebra o stream)

    # --- teardown: dirige o CaptureHandle do SDK + a fila herdada -----------------
    def close(self, timeout: float = 8.0) -> None:
        """GRACEFUL: pede ``capture_close`` ao daemon (drena a cauda transcrita), injeta
        o ``CaptureClosed`` terminal e encerra. Idempotente (o handle checa ``closed``)."""
        handle = self._handle
        if handle is not None and not handle.closed:
            try:
                closed = handle.close(timeout=timeout)
            except SdkCaptureError as exc:
                self.emit(CaptureError(exc.code, exc.message))
            except Exception as exc:  # noqa: BLE001 — transporte morto: fail-loud, nunca trava
                self.emit(CaptureError("pipe_broken", str(exc)))
            else:
                # tradução FORA do except: um bug de tradução (ex.: skew de tipo) não pode
                # virar um pipe_broken FALSO que descartaria o resumo de um close bem-sucedido.
                self.emit(_to_closed(closed))
        super().close()

    def cancel(self, timeout: float = 8.0) -> None:
        """ABORT: encerra ``events()`` JÁ (descarta bufferizados) e SÓ ENTÃO pede
        ``capture_cancel`` ao daemon (libera o mic). A ORDEM importa: ``super().cancel()``
        desbloqueia ``events()`` em <100ms; ``handle.cancel()`` (que aguarda o ack do
        daemon) roda depois, na thread de quem cancelou — nunca atrasa a thread que
        consome ``events()`` (a joia do contrato: stop de PTT não pode travar)."""
        super().cancel()
        handle = self._handle
        if handle is not None and not handle.closed:
            try:
                handle.cancel(timeout=timeout)
            except Exception:  # noqa: BLE001 — abortando de qualquer forma
                pass


def _to_closed(frame: dict) -> CaptureClosed:
    """Traduz o dict ``capture_closed`` (retorno de ``close``/``cancel``) na dataclass.

    ``errors`` é normalizado DEFENSIVAMENTE contra skew cross-repo: o wire atual manda
    ``list[str]``, mas um daemon ANTIGO pode mandar um ``int`` (contagem) ou uma string —
    nenhum pode virar ``TypeError`` (que a camada de cima transformaria num ``pipe_broken``
    FALSO, descartando o resumo do turno) nem char-split de uma string em tupla de letras.
    """
    raw = frame.get("errors")
    if isinstance(raw, (list, tuple)):
        errors = tuple(str(e) for e in raw)
    elif raw:  # int (contagem legada) OU string única -> preserva sem quebrar
        errors = (str(raw),)
    else:
        errors = ()
    return CaptureClosed(
        ok=bool(frame.get("ok", False)),
        text=frame.get("text"),
        peak=float(frame.get("peak", 0.0)),
        duration_s=float(frame.get("duration_s", 0.0)),
        chunks=int(frame.get("chunks", 0)),
        skipped_silence=int(frame.get("skipped_silence", 0)),
        dropped=int(frame.get("dropped", 0)),
        errors=errors,
        mic_ok=bool(frame.get("mic_ok", True)),
        cancelled=bool(frame.get("cancelled", False)),
    )


class VoxPipeCaptureAdapter:
    """``CapturePort`` real sobre o ``vox_sdk``. Injetado no worker no lugar do
    ``FakeCaptureAdapter``. Guarda o ``VoxClient`` (NÃO o cria — o worker o possui) e as
    opções de captura (lang/model/profile/device/min_rms/timeouts).

    ``capture_open`` usa uma conexão de pipe DEDICADA — não colide com o TTS/transcribe
    do mesmo ``VoxClient`` (seguem em paralelo).
    """

    def __init__(self, client: Any, *, lang: str = "", model: Optional[str] = None,
                 profile: Optional[str] = None, input_device: Any = None,
                 min_rms: float = 0.0, connect_timeout: float = 5.0,
                 open_timeout: float = 8.0, busy_retries: int = 2,
                 busy_retry_s: float = 0.3, sleep=None) -> None:
        self._client = client
        self._opts = dict(lang=lang, model=model, profile=profile,
                          input_device=input_device, min_rms=min_rms,
                          connect_timeout=connect_timeout, open_timeout=open_timeout)
        self.opened: List[str] = []
        # RETRY curto no mic_busy: o mic.lock (single-owner) pode estar com o DITADO por
        # instantes (ele solta o mic ENTRE frases). `sleep` é injetável p/ teste sem delay real.
        self._busy_retries = int(busy_retries)
        self._busy_retry_s = float(busy_retry_s)
        self._sleep = sleep if sleep is not None else time.sleep

    def open(self, session_id: str) -> VoxPipeCaptureStream:
        """Abre uma captura para ``session_id``. Erro de abertura TIPADO (``CaptureError``
        do SDK) OU falha de transporte (daemon fora) vira um ``CaptureError`` TERMINAL no
        stream — o worker trata sucesso e falha pela MESMA ``events()``.

        RETRY curto SÓ em ``BUSY_CODES`` (mic.lock já com OUTRO dono — quase sempre o
        DITADO): reabre ``busy_retries`` vezes com ``busy_retry_s`` entre elas p/ pegar a
        janela em que o outro capturador solta o mic. NÃO força coexistência (o lock impede
        dupla captura DE PROPÓSITO); erro NÃO-busy (device_fail/pipe_broken) falha na hora."""
        stream = VoxPipeCaptureStream()
        self.opened.append(session_id)
        opts = dict(self._opts)
        dev = opts.get("input_device")
        if callable(dev):
            opts["input_device"] = dev()   # resolve o mic selecionado NA HORA da captura
        last_busy = None
        for attempt in range(self._busy_retries + 1):
            try:
                handle = self._client.capture_open(session_id, stream._on_event, **opts)
            except SdkCaptureError as exc:
                if exc.code in BUSY_CODES and attempt < self._busy_retries:
                    last_busy = exc
                    self._sleep(self._busy_retry_s)   # espera o ditado soltar o mic e re-tenta
                    continue
                stream.emit(CaptureError(exc.code, exc.message))
                return stream
            except (OSError, TimeoutError) as exc:  # daemon fora / pipe não abriu
                stream.emit(CaptureError("pipe_broken", f"capture_open falhou: {exc}"))
                return stream
            stream._bind(handle)
            return stream
        # esgotou os retries de busy -> erro terminal com o último código busy
        stream.emit(CaptureError(last_busy.code, last_busy.message))
        return stream
