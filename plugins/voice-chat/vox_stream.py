"""Streaming de STT near-real-time para o vox-SDK — segmentação por pausa + STT
sobreposto à captura, para **tradução/ditado ao vivo** (perfil ``translator``).

Portado FIELMENTE dos módulos oficiais do motor
(``vox_engine/client/segmenter.py`` + ``client/streaming.py``), com UMA adaptação:
o ``StreamingTranscriber`` aceita o ``transcribe`` do SDK (que devolve **str**) E o
do cliente oficial (que devolve **dict**) — e propaga ``profile``/``model`` para o
daemon escolher o modelo (translator→large-v3 na GPU / turbo no CPU).

Requer ``numpy`` (DSP do segmentador). Import opcional: o núcleo do ``vox_sdk`` NÃO
depende disto — só quem faz STT ao vivo importa ``vox_stream``.

Uso típico::

    from vox_sdk import ensure_vox
    from vox_stream import StreamingTranscriber

    vox = ensure_vox()
    st = StreamingTranscriber(vox, lang="en", profile="translator",
                              on_segment=lambda i, t: print(t))
    # ...alimente frames do microfone (float32 16k mono)...
    st.feed(frames)
    texto = st.finish()
"""
from __future__ import annotations

import queue
import re
import threading
import time
from typing import Callable, Optional

import numpy as np

SAMPLE_RATE = 16000
CHUNK_TARGET_S = 8.0
WHISPER_MAX_S = 28.0

OnSegment = Callable[[int, str], None]
OnSegmentResult = Callable[[int, dict], None]

# Teto de segmentos pendentes aguardando STT. Se o motor não acompanha, o buffer
# para em ``max_pending`` (ring: descarta o mais antigo) em vez de crescer sem limite.
_MAX_PENDING = 64
# Teto do tradutor ao vivo: 8 (não 64). 64×~2.5s = 160s de atraso antes de descartar =
# "quase batch"; 8 mantém a latência tempo-real honesta (NB5 do PLAN-GATE v2).
_MAX_PENDING_TRANSLATE = 8


# ---------------------------------------------------------------------------
# Segmentação por pausa (DSP puro — cópia fiel de vox_engine/client/segmenter.py)
# ---------------------------------------------------------------------------
def frame_rms(samples: np.ndarray, sr: int = SAMPLE_RATE, frame_ms: int = 20):
    """(rms_por_frame, tamanho_do_frame) — envelope grosso de energia."""
    fl = max(1, int(sr * frame_ms / 1000))
    n = samples.size // fl
    if n == 0:
        val = float(np.sqrt(np.mean(samples ** 2))) if samples.size else 0.0
        return np.array([val], dtype=np.float32), fl
    trimmed = samples[: n * fl].reshape(n, fl)
    rms = np.sqrt(np.mean(trimmed ** 2, axis=1)).astype(np.float32)
    return rms, fl


def cut_point(samples: np.ndarray, sr: int = SAMPLE_RATE, max_s: float = WHISPER_MAX_S,
              hard_s: "float | None" = None, defer: bool = False) -> "int | None":
    """Índice (em samples) onde cortar o bloco inicial, preferindo um ponto quieto.

    Monta um envelope de energia (20ms) e, de ``(max_s-5s)`` até o teto rígido,
    corta no frame mais silencioso. Com ``defer=True`` retorna ``None`` se esse
    frame não for de fato uma pausa e o buffer ainda não atingiu ``hard_s`` — pedindo
    mais áudio para o corte cair no silêncio real, não no meio da palavra.
    """
    n = samples.size
    soft = int(max_s * sr)
    hard = int((hard_s if hard_s is not None else max_s) * sr)
    if n <= soft and not defer:
        return n
    rms, fl = frame_rms(samples, sr)
    lo = max(int(0.5 * sr), soft - int(5 * sr))
    hi = min(n, hard)
    f_lo = lo // fl
    f_hi = min(len(rms) - 1, hi // fl)
    if f_hi <= f_lo:
        if defer and n < hard:
            return None
        return min(soft, n)
    win = rms[f_lo: f_hi + 1]
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


class StreamSegmenter:
    """Acumula frames e devolve segmentos completos cortados em pausas.

    ``feed(samples)`` -> lista de segmentos prontos (pode ser vazia).
    ``flush()``       -> segmentos finais da cauda (chame ao parar de gravar).
    Sem estado global; uma instância por sessão/fluxo de captura.
    """

    def __init__(self, sr: int = SAMPLE_RATE, chunk_target_s: float = CHUNK_TARGET_S,
                 hard_s: float = WHISPER_MAX_S):
        self.sr = sr
        self.chunk_target_s = chunk_target_s
        self.hard_s = hard_s
        self._tail: "np.ndarray | None" = None

    def _target_len(self) -> int:
        return int(min(self.chunk_target_s, self.hard_s) * self.sr)

    def feed(self, samples: np.ndarray) -> "list[np.ndarray]":
        chunk = np.ascontiguousarray(samples, dtype=np.float32)
        if chunk.size:
            self._tail = chunk if self._tail is None else np.concatenate([self._tail, chunk])
        out: "list[np.ndarray]" = []
        target = self._target_len()
        while self._tail is not None and self._tail.size >= target:
            cut = cut_point(self._tail, self.sr, target / self.sr,
                            hard_s=self.hard_s, defer=True)
            if cut is None:
                break  # sem pausa real ainda; espera mais áudio
            out.append(self._tail[:cut])
            self._tail = self._tail[cut:]
        return out

    def flush(self) -> "list[np.ndarray]":
        out: "list[np.ndarray]" = []
        if self._tail is not None and self._tail.size > 0:
            hard = int(self.hard_s * self.sr)
            while self._tail.size > hard:
                cut = cut_point(self._tail, self.sr, self.hard_s)
                out.append(self._tail[:cut])
                self._tail = self._tail[cut:]
            out.append(self._tail)
        self._tail = None
        return out

    @property
    def pending_s(self) -> float:
        return 0.0 if self._tail is None else self._tail.size / self.sr


# ---------------------------------------------------------------------------
# Transcritor em fluxo (STT sobreposto à captura, numa thread)
# ---------------------------------------------------------------------------
def _extract_text(res) -> str:
    """Normaliza o retorno do ``transcribe``: str (vox-SDK) OU dict (cliente oficial)."""
    if isinstance(res, dict):
        return (res.get("text") or "").strip()
    return (res or "").strip() if isinstance(res, str) else ""


class StreamingTranscriber:
    """Junta o :class:`StreamSegmenter` (corte por pausa) com um cliente do daemon:
    cada segmento completo é enviado ao motor **enquanto você continua falando** (STT
    sobreposto à captura, numa thread). ``finish()`` devolve o texto completo em ordem.

    Transporte-agnóstico: aceita qualquer objeto com ``transcribe(samples, lang=...,
    session=..., priority=..., profile=..., model=..., timeout=...)`` — o retorno pode
    ser ``str`` (vox-SDK) ou ``dict`` com ``{"text": ...}`` (cliente oficial).
    """

    def __init__(self, client, *, lang: str = "", session: str = "stream",
                 priority: str = "interactive", profile: "str | None" = None,
                 model: "str | None" = None, sr: int = SAMPLE_RATE,
                 chunk_target_s: float = CHUNK_TARGET_S, hard_s: float = WHISPER_MAX_S,
                 on_segment: Optional[OnSegment] = None, timeout: float = 60.0,
                 max_pending: int = _MAX_PENDING):
        self._client = client
        self._lang = lang
        self._session = session
        self._priority = priority
        self._profile = profile
        self._model = model
        self._timeout = timeout
        self._on_segment = on_segment
        self._seg = StreamSegmenter(sr=sr, chunk_target_s=chunk_target_s, hard_s=hard_s)
        self._q: "queue.Queue[tuple[int, np.ndarray] | None]" = queue.Queue(maxsize=max_pending)
        self._results: "dict[int, str]" = {}
        self._results_lock = threading.Lock()
        self._errors: "list[str]" = []
        self._next_idx = 0
        self._worker = threading.Thread(target=self._run, name="vox-stream-stt", daemon=True)
        self._worker.start()

    # ---- alimentação (thread do chamador / callback do microfone) ----
    def feed(self, samples: np.ndarray) -> None:
        for seg in self._seg.feed(samples):
            self._submit(seg)

    def _submit(self, seg: np.ndarray) -> None:
        idx = self._next_idx
        self._next_idx += 1
        try:
            self._q.put_nowait((idx, seg))
        except queue.Full:
            # STT não acompanha: descarta o pendente mais antigo (ring) para manter o
            # fluxo em tempo real e a memória limitada, e registra a perda.
            try:
                old_idx, _ = self._q.get_nowait()
                self._errors.append(f"fila cheia: segmento {old_idx} descartado (STT atrasado)")
            except queue.Empty:
                pass
            try:
                self._q.put_nowait((idx, seg))
            except queue.Full:
                self._errors.append(f"fila cheia: segmento {idx} descartado")

    # ---- worker de STT (sobreposto à captura) ----
    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            idx, seg = item
            try:
                res = self._client.transcribe(
                    seg, lang=self._lang, session=self._session,
                    priority=self._priority, profile=self._profile,
                    model=self._model, timeout=self._timeout)
                text = _extract_text(res)
            except Exception as e:  # noqa: BLE001 — STT nunca derruba o worker
                text = ""
                self._errors.append(repr(e))
            with self._results_lock:
                self._results[idx] = text
            if self._on_segment:
                try:
                    self._on_segment(idx, text)
                except Exception:  # noqa: BLE001
                    pass

    # ---- finalização ----
    def finish(self) -> str:
        """Descarrega a cauda, espera todos os segmentos e devolve o texto em ordem."""
        for seg in self._seg.flush():
            self._submit(seg)
        if self._worker.is_alive():
            # Só sinaliza/espera se o worker ainda vive: após um finish anterior ele já
            # saiu, e um ``put(None)`` numa fila cheia sem consumidor travaria p/ sempre
            # (feed-após-finish / double-finish). Com o worker vivo, o put é seguro (ele
            # consome), preservando o contrato "espera todos".
            self._q.put(None)
            self._worker.join()
        with self._results_lock:
            parts = [self._results[i] for i in sorted(self._results) if self._results[i]]
        return " ".join(parts).strip()

    @property
    def errors(self) -> "list[str]":
        return list(self._errors)


# ---------------------------------------------------------------------------
# Tradutor em fluxo (tradução ao vivo por pausa — irmão do StreamingTranscriber)
# ---------------------------------------------------------------------------
def _seg_rms(seg: np.ndarray) -> float:
    """RMS de um segmento (float64 p/ não estourar em amplitudes altas)."""
    if seg is None or seg.size == 0:
        return 0.0
    x = np.asarray(seg, dtype=np.float64)
    return float(np.sqrt(np.mean(x * x)))


class StreamingTranslator:
    """Junta o :class:`StreamSegmenter` (corte por pausa) com ``client.translate``:
    cada segmento completo é **traduzido enquanto você continua falando** (tradução
    sobreposta à captura, numa thread única e serial → ordem preservada). Emite frases
    traduzidas (e, com ``speak=True``, também a VOZ dublada) EM ORDEM. ``finish()``
    devolve o agregado (texto-fonte, texto traduzido, segmentos, áudio dublado).

    Espelha o :class:`StreamingTranscriber` (thread daemon + ``queue.Queue(maxsize)`` +
    ring buffer que descarta o mais antigo + ``_results`` sob lock + ``on_segment``
    guardado). NÃO toca no motor/daemon — só orquestra o SDK.

    O worker chama ``client.translate`` **SÓ por kwargs** (B1: a assinatura real tem
    ``session``/``whisper_model``/``priority`` ENTRE ``to_lang`` e ``speak`` — posicional
    faria ``speak`` cair em ``session``). Normaliza os DOIS retornos do SDK:

    - ``speak=False`` -> ``dict`` ``{text, source_text, src_lang, same_language, ...}``.
    - ``speak=True``  -> ``(header, payload)``: ``payload`` é ``ndarray`` (``dub_fmt="pcm"``)
      ou ``bytes`` (codificado). ``dub_skipped``/``ndarray`` vazio -> ``audio=None``.

    ``finish`` só concatena o áudio quando ``speak`` + ``collect_audio`` e TODOS os
    segmentos são PCM/``ndarray`` e do MESMO ``sr`` (senão ``audio=None`` e o áudio fica
    por segmento em ``segments[i]["audio"]``). Perdas do ring viram ``dropped_segments`` e
    ``complete=False``; erros no ``translate`` nunca derrubam o worker (vão p/ ``errors``).
    """

    def __init__(self, client, *, from_lang: str = "", to_lang: str = "pt",
                 speak: bool = False, dub_voice: str = "", dub_sid: int = 0,
                 dub_fmt: str = "pcm", session: str = "stream",
                 priority: str = "interactive", whisper_model: "str | None" = None,
                 sr: int = SAMPLE_RATE, chunk_target_s: float = CHUNK_TARGET_S,
                 hard_s: float = WHISPER_MAX_S, on_segment: Optional[OnSegmentResult] = None,
                 timeout: float = 120.0, max_pending: int = _MAX_PENDING_TRANSLATE,
                 min_rms: float = 0.0, collect_audio: bool = True):
        self._client = client
        self._from = from_lang
        self._to = to_lang
        self._speak = speak
        self._dub_voice = dub_voice
        self._dub_sid = dub_sid
        self._dub_fmt = dub_fmt
        self._session = session
        self._priority = priority
        self._whisper_model = whisper_model
        self._timeout = timeout
        self._min_rms = min_rms
        self._collect_audio = collect_audio
        self._on_segment = on_segment
        self._seg = StreamSegmenter(sr=sr, chunk_target_s=chunk_target_s, hard_s=hard_s)
        self._q: "queue.Queue[tuple[int, np.ndarray | None] | None]" = queue.Queue(maxsize=max_pending)
        self._results: "dict[int, dict]" = {}
        self._results_lock = threading.Lock()
        self._errors: "list[str]" = []
        self._dropped: "list[int]" = []
        self._skipped_silence = 0
        self._next_idx = 0
        self._worker = threading.Thread(target=self._run, name="vox-stream-translate",
                                        daemon=True)
        self._worker.start()

    # ---- alimentação (thread do chamador / callback do microfone) ----
    def feed(self, samples: np.ndarray) -> None:
        for seg in self._seg.feed(samples):
            self._submit(seg)

    def _submit(self, seg: np.ndarray) -> None:
        idx = self._next_idx
        self._next_idx += 1
        # NB7: guard de silêncio — poupa o round-trip do translate. O marcador é roteado
        # PELO worker (seg=None) para que ``on_segment`` seja emitido EM ORDEM e sempre na
        # thread do worker (Finding 2: armazenar aqui, na thread do caller, furava a ordem
        # e emitia o callback de duas threads). ``skipped_silence`` sobe no worker (ao
        # ARMAZENAR), não aqui — assim um silêncio DESCARTADO conta só em ``dropped``.
        if self._min_rms > 0.0 and _seg_rms(seg) < self._min_rms:
            self._enqueue(idx, None)
            return
        self._enqueue(idx, seg)

    def _enqueue(self, idx: int, seg: "np.ndarray | None") -> None:
        try:
            self._q.put_nowait((idx, seg))
        except queue.Full:
            if seg is None:
                # Finding 2: silêncio NUNCA expulsa fala. Fila cheia -> descarta o PRÓPRIO
                # marcador de silêncio (registra o idx p/ o accounting não ter buraco), em
                # vez de evictar o pendente mais antigo (que pode ser uma frase real).
                self._dropped.append(idx)
                return
            # fala: ring — descarta o pendente MAIS ANTIGO (ring) p/ manter o fluxo
            # tempo-real e a memória limitada, registrando o idx perdido (B3).
            try:
                old_idx, _ = self._q.get_nowait()
                self._dropped.append(old_idx)
            except queue.Empty:
                pass
            try:
                self._q.put_nowait((idx, seg))
            except queue.Full:
                self._dropped.append(idx)

    # ---- worker de tradução (sobreposto à captura) ----
    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            idx, seg = item
            if seg is None:  # marcador de silêncio (min_rms): armazena EM ORDEM, sem translate
                self._skipped_silence += 1
                self._store(idx, {"idx": idx, "source_text": "", "text": "",
                                  "src_lang": None, "same_language": False,
                                  "audio": None, "sr": None, "skipped": "silence"})
                continue
            try:
                # B1: SÓ KWARGS. ``seg`` é o único posicional (o param ``audio``).
                raw = self._client.translate(
                    seg,
                    from_lang=self._from,
                    to_lang=self._to,
                    session=self._session,
                    whisper_model=self._whisper_model,
                    priority=self._priority,
                    speak=self._speak,
                    dub_voice=self._dub_voice,
                    dub_sid=self._dub_sid,
                    dub_fmt=self._dub_fmt,
                    timeout=self._timeout,
                )
                result = self._normalize(idx, raw)
            except Exception as e:  # noqa: BLE001 — translate NUNCA derruba o worker
                result = {"idx": idx, "source_text": "", "text": "", "src_lang": None,
                          "same_language": False, "audio": None, "sr": None, "skipped": None}
                self._errors.append(repr(e))
            self._store(idx, result)

    def _normalize(self, idx: int, raw) -> dict:
        """Normaliza os DOIS retornos do SDK num ``result`` uniforme."""
        if isinstance(raw, dict):
            return {"idx": idx, "source_text": raw.get("source_text"),
                    "text": raw.get("text"), "src_lang": raw.get("src_lang"),
                    "same_language": raw.get("same_language", False),
                    "audio": None, "sr": None, "skipped": None}
        # (header, payload) — speak=True. payload = ndarray (pcm) ou bytes (codificado).
        header, payload = raw
        skipped = header.get("dub_skipped")
        audio = payload
        if skipped:
            audio = None
        elif isinstance(payload, np.ndarray) and payload.size == 0:
            audio = None
        return {"idx": idx, "source_text": header.get("source_text"),
                "text": header.get("text"), "src_lang": header.get("src_lang"),
                "same_language": header.get("same_language", False),
                "audio": audio, "sr": header.get("tts_sample_rate"), "skipped": skipped}

    def _store(self, idx: int, result: dict) -> None:
        # on_segment recebe o result COMPLETO (com áudio); o agregado descarta o áudio
        # quando ``collect_audio=False`` (memória em sessão longa — on_segment é a fonte).
        stored = result
        if not self._collect_audio and result.get("audio") is not None:
            stored = dict(result)
            stored["audio"] = None
        with self._results_lock:
            self._results[idx] = stored
        if self._on_segment:
            try:
                self._on_segment(idx, result)
            except Exception:  # noqa: BLE001 — callback do usuário nunca derruba o worker
                pass

    # ---- finalização ----
    def finish(self, timeout: "float | None" = None, cancel_pending: bool = False) -> dict:
        """Descarrega a cauda, espera os segmentos e devolve o agregado EM ORDEM.

        Nunca trava indefinidamente (B4): a espera é SEMPRE limitada. ``timeout=None``
        (padrão) limita a espera a ``self._timeout`` (o mesmo teto de UMA tradução); passe
        um número para outro teto. Se o budget estourar (worker/motor pendurado), devolve o
        PARCIAL com ``complete=False`` — o chamador nunca fica preso. ``cancel_pending=True``
        esvazia a fila antes (os pendentes viram ``dropped``).
        """
        for seg in self._seg.flush():
            self._submit(seg)
        if cancel_pending:
            while True:
                try:
                    old_idx, _ = self._q.get_nowait()
                    self._dropped.append(old_idx)
                except queue.Empty:
                    break
        budget = self._timeout if timeout is None else timeout
        if self._worker.is_alive():
            # B4: entrega o sentinela e espera SEM travar p/ sempre. Numa fila cheia com o
            # worker preso, um ``put()`` bloqueante venceria o ``join`` e o finish nunca
            # voltaria (o timeout viraria letra morta). Divide o ``budget`` entre o put e o
            # join (total <= budget); se estourar, retorna o PARCIAL com ``complete=False``.
            deadline = time.monotonic() + max(0.0, budget)
            try:
                self._q.put(None, timeout=max(0.0, deadline - time.monotonic()))
            except queue.Full:
                pass
            self._worker.join(max(0.0, deadline - time.monotonic()))
        else:
            # worker JÁ saiu (double-finish / feed-após-finish): drena a fila residual p/ o
            # accounting não ter buraco (idx submetido que nunca virou resultado) e não
            # bloqueia num ``put`` sem consumidor.
            while True:
                try:
                    left = self._q.get_nowait()
                except queue.Empty:
                    break
                if left is not None:
                    self._dropped.append(left[0])
        timed_out = self._worker.is_alive()
        with self._results_lock:
            segments = [self._results[i] for i in sorted(self._results)]
        source_text = " ".join(
            (r.get("source_text") or "") for r in segments if r.get("source_text")).strip()
        text = " ".join(
            (r.get("text") or "") for r in segments if r.get("text")).strip()
        audio = None
        if self._speak and self._collect_audio:
            audio = self._concat_audio(segments)
        dropped = sorted(self._dropped)
        errors = list(self._errors)
        complete = not (timed_out or dropped or errors)
        return {"source_text": source_text, "text": text, "segments": segments,
                "audio": audio, "dropped_segments": dropped, "complete": complete,
                "errors": errors}

    @staticmethod
    def _concat_audio(segments: "list[dict]") -> "np.ndarray | None":
        """Concatena SÓ áudios PCM/``ndarray`` do MESMO ``sr``; senão ``None`` (B2/NB6).

        Segmentos sem áudio (``dub_skipped``/silêncio) são pulados (não anulam o resto);
        qualquer ``bytes`` codificado ou ``sr`` divergente aborta a concatenação.
        """
        audios: "list[np.ndarray]" = []
        srs = set()
        for r in segments:
            a = r.get("audio")
            if a is None:
                continue
            if not isinstance(a, np.ndarray):
                return None  # bytes codificados (mp3/opus/wav) — concatenar viraria lixo
            audios.append(a)
            srs.add(r.get("sr"))
        if not audios:
            return None
        if len(srs) > 1:
            return None  # sample rates diferentes — nunca concatena
        return np.concatenate(audios)

    @property
    def errors(self) -> "list[str]":
        return list(self._errors)

    @property
    def dropped(self) -> "list[int]":
        return sorted(self._dropped)

    @property
    def skipped_silence(self) -> int:
        return self._skipped_silence

    @property
    def pending(self) -> int:
        """Segmentos ainda na fila aguardando tradução (aprox., tempo-real)."""
        return self._q.qsize()


# ---------------------------------------------------------------------------
# Fase D — StreamingDubber: dublagem ao vivo por SENTENÇA (entrada = TEXTO)
# ---------------------------------------------------------------------------
_DUB_IDLE_S = 0.8            # commita o buffer após 0.8 s sem novo feed (fala pausou)
_DUB_MAX_CHARS = 600        # teto de resíduo: força commit de run-on (< MAX_DUB_CHARS do motor)
_MAX_PENDING_DUB = 8

# Fim de sentença: run de .?! (opcionalmente aspas/parênteses de fechamento). O commit
# só acontece quando seguido de espaço/fim (isso já preserva decimais como "3.14",
# cujo "." é seguido de dígito). Abreviações e iniciais de 1 letra são suprimidas.
_SENT_END = re.compile(r'[.!?]+["\')\]]?')
_ABBREV = frozenset("""
sr sra srta dr dra prof profa exmo exma sto sta jr mr mrs ms vs etc ex
no num núm pag pág art fig cap vol ed eng ph.d i.e e.g a.m p.m u.s u.k
""".split())


def _split_sentences(text: str) -> "tuple[list[str], str]":
    """Fatia ``text`` em sentenças COMPLETAS + resíduo (o que ainda não fechou).

    Fronteira = run de ``.?!`` seguido de espaço/fim. NÃO quebra em: decimais
    (``3.14`` — o ``.`` vem colado a dígito, sem espaço), abreviações conhecidas
    (``Dr.``/``etc.``/``U.S.``) nem iniciais de 1 letra (``J.``). Devolve
    ``(sentenças, resíduo)`` — o resíduo fica no buffer até completar/idle/finish."""
    sentences: "list[str]" = []
    last_cut = 0
    n = len(text)
    for m in _SENT_END.finditer(text):
        end = m.end()
        if end < n and not text[end].isspace():
            continue                                   # ex.: "3.14" -> "." colado a dígito
        j = m.start()
        k = j
        while k > 0 and (text[k - 1].isalnum() or text[k - 1] == "."):
            k -= 1
        token = text[k:j].strip(".").lower()
        if token in _ABBREV:
            continue                                   # abreviação: não fecha sentença
        if len(token) == 1 and token.isalnum():
            continue                                   # inicial/nº de lista (ex.: "J."/"1.")
        sentence = text[last_cut:end].strip()
        if sentence:
            sentences.append(sentence)
        last_cut = end
    return sentences, text[last_cut:]


def _force_word_chunk(buf: str, max_chars: int) -> "tuple[str, str]":
    """Corta ``buf`` no ÚLTIMO espaço <= ``max_chars`` (nunca no meio da palavra). Sem
    espaço (palavra única gigante), corta em ``max_chars`` (degenerado). Devolve
    ``(chunk, resíduo)``."""
    if len(buf) <= max_chars:
        return "", buf
    cut = buf.rfind(" ", 0, max_chars + 1)
    if cut <= 0:
        cut = max_chars
    return buf[:cut].strip(), buf[cut:].lstrip()


class StreamingDubber:
    """Dublagem ao vivo por SENTENÇA: acumula TEXTO (já transcrito pelo chamador — STT
    roda 1× só, do lado dele) e, a cada SENTENÇA completa, chama
    ``client.translate_text(..., speak=True)`` numa thread única e serial → dublagem
    EM ORDEM, sobreposta à fala. Espelha o :class:`StreamingTranslator` (thread daemon
    + ``queue.Queue(maxsize)`` + ring que descarta o mais antigo + ``_results`` sob
    lock + ``on_segment`` guardado), MAS a entrada é texto e o commit é por sentença.

    **Commit policy (o "sem corte"):** uma sentença é comprometida para MT+dub quando
    QUALQUER gatilho dispara — nunca travando em ASR sem pontuação nem cortando no meio:

    1. **fim de sentença** — ``.?!`` seguido de espaço/fim, com splitter que NÃO quebra
       ``Dr.``/``3.14``/``U.S.`` (:func:`_split_sentences`);
    2. **idle timeout** (``idle_s``) — sem novo ``feed_text`` por N s, commita o buffer
       (a fala pausou); ``idle_s=0`` desliga;
    3. **teto de chars** (``max_chars``) — resíduo sem fronteira acima do teto força
       commit por PALAVRA (nunca no meio da palavra), evitando run-on gigante que
       estouraria o ``MAX_DUB_CHARS`` do motor;
    4. **``finish()``** — commita a cauda residual.

    ``from_lang`` é **OBRIGATÓRIO** (o Argos não auto-detecta idioma de TEXTO). O
    retorno de ``finish`` espelha o do :class:`StreamingTranslator` (source_text/text/
    segments/audio/dropped_segments/complete/errors)."""

    def __init__(self, client, from_lang: str, *, to_lang: str = "pt",
                 speak: bool = True, dub_voice: str = "", dub_sid: int = 0,
                 dub_fmt: str = "pcm", session: str = "stream",
                 priority: str = "interactive", timeout: float = 120.0,
                 idle_s: float = _DUB_IDLE_S, max_chars: int = _DUB_MAX_CHARS,
                 max_pending: int = _MAX_PENDING_DUB,
                 on_segment: Optional[OnSegmentResult] = None,
                 collect_audio: bool = True):
        if not (from_lang or "").strip():
            raise ValueError("StreamingDubber requer from_lang (Argos não auto-detecta texto)")
        self._client = client
        self._from = from_lang
        self._to = to_lang
        self._speak = speak
        self._dub_voice = dub_voice
        self._dub_sid = dub_sid
        self._dub_fmt = dub_fmt
        self._session = session
        self._priority = priority
        self._timeout = timeout
        self._idle_s = max(0.0, idle_s)
        self._max_chars = max(1, max_chars)
        self._collect_audio = collect_audio
        self._on_segment = on_segment
        self._buf = ""
        self._last_feed = time.monotonic()
        self._lock = threading.Lock()             # guarda _buf + _next_idx + enqueue
        self._q: "queue.Queue[tuple[int, str] | None]" = queue.Queue(maxsize=max_pending)
        self._results: "dict[int, dict]" = {}
        self._results_lock = threading.Lock()
        self._errors: "list[str]" = []
        self._dropped: "list[int]" = []
        self._next_idx = 0
        self._closed = threading.Event()
        self._worker = threading.Thread(target=self._run, name="vox-stream-dub", daemon=True)
        self._worker.start()
        self._idle_thread: "threading.Thread | None" = None
        if self._idle_s > 0.0:
            self._idle_thread = threading.Thread(target=self._idle_loop,
                                                 name="vox-stream-dub-idle", daemon=True)
            self._idle_thread.start()

    # ---- alimentação (thread do chamador) ----
    def feed_text(self, text: str) -> None:
        """Acumula ``text`` e commita as sentenças que se completarem (+ força commit
        por palavra se o resíduo passar do teto). O resíduo incompleto fica no buffer."""
        if not text:
            return
        with self._lock:
            self._buf += text
            self._last_feed = time.monotonic()
            self._drain_locked(force_all=False)

    def _drain_locked(self, *, force_all: bool) -> None:
        # caller detém self._lock. Ordem: sentenças completas -> chunks por teto -> (finish) cauda.
        sentences, self._buf = _split_sentences(self._buf)
        while len(self._buf) > self._max_chars:
            chunk, self._buf = _force_word_chunk(self._buf, self._max_chars)
            if not chunk:
                break
            sentences.append(chunk)
        if force_all and self._buf.strip():
            sentences.append(self._buf.strip())
            self._buf = ""
        for s in sentences:
            s = s.strip()
            if s:
                self._commit_locked(s)

    def _commit_locked(self, sentence: str) -> None:
        idx = self._next_idx
        self._next_idx += 1
        self._enqueue(idx, sentence)

    def _enqueue(self, idx: int, text: str) -> None:
        try:
            self._q.put_nowait((idx, text))
        except queue.Full:
            # ring: descarta o pendente MAIS ANTIGO p/ manter o fluxo tempo-real e a
            # memória limitada, registrando o idx perdido (complete=False no finish).
            try:
                old_idx, _ = self._q.get_nowait()
                self._dropped.append(old_idx)
            except queue.Empty:
                pass
            try:
                self._q.put_nowait((idx, text))
            except queue.Full:
                self._dropped.append(idx)

    # ---- idle timer: commita o buffer quando a fala pausa ----
    def _idle_loop(self) -> None:
        while not self._closed.is_set():
            self._closed.wait(min(self._idle_s, 0.05))
            if self._closed.is_set():
                return
            with self._lock:
                if self._buf.strip() and (time.monotonic() - self._last_feed) >= self._idle_s:
                    chunk = self._buf.strip()
                    self._buf = ""
                    self._commit_locked(chunk)

    # ---- worker de dublagem (sobreposto à fala) ----
    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            idx, text = item
            try:
                raw = self._client.translate_text(
                    text,
                    from_lang=self._from,
                    to_lang=self._to,
                    session=self._session,
                    priority=self._priority,
                    speak=self._speak,
                    dub_voice=self._dub_voice,
                    dub_sid=self._dub_sid,
                    dub_fmt=self._dub_fmt,
                    timeout=self._timeout,
                )
                result = self._normalize(idx, raw)
            except Exception as e:  # noqa: BLE001 — translate_text NUNCA derruba o worker
                result = {"idx": idx, "source_text": "", "text": "", "src_lang": None,
                          "same_language": False, "audio": None, "sr": None, "skipped": None}
                self._errors.append(repr(e))
            self._store(idx, result)

    def _normalize(self, idx: int, raw) -> dict:
        """Normaliza os DOIS retornos do SDK (dict speak=False / (header,payload) speak=True)."""
        if isinstance(raw, dict):
            return {"idx": idx, "source_text": raw.get("source_text"),
                    "text": raw.get("text"), "src_lang": raw.get("src_lang"),
                    "same_language": raw.get("same_language", False),
                    "audio": None, "sr": None, "skipped": None}
        header, payload = raw
        skipped = header.get("dub_skipped")
        audio = payload
        if skipped:
            audio = None
        elif isinstance(payload, np.ndarray) and payload.size == 0:
            audio = None
        return {"idx": idx, "source_text": header.get("source_text"),
                "text": header.get("text"), "src_lang": header.get("src_lang"),
                "same_language": header.get("same_language", False),
                "audio": audio, "sr": header.get("tts_sample_rate"), "skipped": skipped}

    def _store(self, idx: int, result: dict) -> None:
        stored = result
        if not self._collect_audio and result.get("audio") is not None:
            stored = dict(result)
            stored["audio"] = None
        with self._results_lock:
            self._results[idx] = stored
        if self._on_segment:
            try:
                self._on_segment(idx, result)
            except Exception:  # noqa: BLE001 — callback do usuário nunca derruba o worker
                pass

    # ---- finalização ----
    def finish(self, timeout: "float | None" = None, cancel_pending: bool = False) -> dict:
        """Commita a cauda, para o idle timer, espera os segmentos e devolve o agregado
        EM ORDEM. Nunca trava indefinidamente (B4): a espera é SEMPRE limitada
        (``timeout=None`` usa ``self._timeout``). Estourou -> parcial com
        ``complete=False``. Idempotente (double-finish / feed-após-finish não travam)."""
        with self._lock:
            self._drain_locked(force_all=True)
        self._closed.set()
        if self._idle_thread is not None and self._idle_thread.is_alive():
            self._idle_thread.join(timeout=1.0)
        if cancel_pending:
            while True:
                try:
                    old_idx, _ = self._q.get_nowait()
                    self._dropped.append(old_idx)
                except queue.Empty:
                    break
        budget = self._timeout if timeout is None else timeout
        if self._worker.is_alive():
            deadline = time.monotonic() + max(0.0, budget)
            try:
                self._q.put(None, timeout=max(0.0, deadline - time.monotonic()))
            except queue.Full:
                pass
            self._worker.join(max(0.0, deadline - time.monotonic()))
        else:
            while True:
                try:
                    left = self._q.get_nowait()
                except queue.Empty:
                    break
                if left is not None:
                    self._dropped.append(left[0])
        timed_out = self._worker.is_alive()
        with self._results_lock:
            segments = [self._results[i] for i in sorted(self._results)]
        source_text = " ".join(
            (r.get("source_text") or "") for r in segments if r.get("source_text")).strip()
        text = " ".join(
            (r.get("text") or "") for r in segments if r.get("text")).strip()
        audio = None
        if self._speak and self._collect_audio:
            audio = self._concat_audio(segments)
        dropped = sorted(self._dropped)
        errors = list(self._errors)
        complete = not (timed_out or dropped or errors)
        return {"source_text": source_text, "text": text, "segments": segments,
                "audio": audio, "dropped_segments": dropped, "complete": complete,
                "errors": errors}

    @staticmethod
    def _concat_audio(segments: "list[dict]") -> "np.ndarray | None":
        """Concatena SÓ áudios PCM/``ndarray`` do MESMO ``sr``; senão ``None``."""
        audios: "list[np.ndarray]" = []
        srs = set()
        for r in segments:
            a = r.get("audio")
            if a is None:
                continue
            if not isinstance(a, np.ndarray):
                return None
            audios.append(a)
            srs.add(r.get("sr"))
        if not audios:
            return None
        if len(srs) > 1:
            return None
        return np.concatenate(audios)

    @property
    def errors(self) -> "list[str]":
        return list(self._errors)

    @property
    def dropped(self) -> "list[int]":
        return sorted(self._dropped)

    @property
    def pending(self) -> int:
        """Sentenças ainda na fila aguardando dublagem (aprox., tempo-real)."""
        return self._q.qsize()
