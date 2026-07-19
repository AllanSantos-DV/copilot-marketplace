// voice-audio.mjs — histórico de áudio durável POR SESSÃO (apenas a própria sessão).
//
// Cada fork é dona e reproduz APENAS o próprio histórico, in-process — sem push/relay cross-fork.
// Append -> ACK de reprodução (markPlayed) -> persistência atômica. O cursor HEARD (durável)
// governa o autoplay ao reabrir (o iframe local puxa o histórico pelo hello).

import { join } from "node:path";
import shared from "./voice-shared.cjs";
import { readJson, writeJsonAtomic } from "./voice-core.mjs";
import {
    audioHistoryBySid, audioSeqBySid, audioTurnBySid, audioDeliveredBySid, audioHeardBySid,
} from "./voice-state.mjs";
import { broadcastTo } from "./voice-net.mjs";

const ARTIFACTS = shared.resolveDataDir();
const AUDIO_QUEUE_FILE = join(ARTIFACTS, "audio-queue.json");
const AUDIO_HISTORY_MAX = 30;

export function appendAudioItem(sid, partial) {
    if (!sid) return null;
    const seq = (audioSeqBySid.get(sid) || 0) + 1;
    audioSeqBySid.set(sid, seq);
    const turn = audioTurnBySid.get(sid) || 1;
    const item = {
        seq, id: `${sid}:${seq}`, turn,
        type: partial.type, kind: partial.kind || null,
        spoken: partial.spoken || "", full: partial.full || "",
        audio: partial.audio || null, ts: Date.now(),
    };
    const hist = audioHistoryBySid.get(sid) || [];
    hist.push(item);
    // Cap to the newest N; keep deliveredSeq coherent if the cursor item is pruned.
    while (hist.length > AUDIO_HISTORY_MAX) hist.shift();
    audioHistoryBySid.set(sid, hist);
    // A final reply closes the turn -> the next audio belongs to the next turn.
    if (partial.type === "reply") audioTurnBySid.set(sid, turn + 1);
    return item;
}

// Public entry used by speakToCanvas: record the audio in the OWN-session history,
// persist it, and DELIVER it live to the own iframe (broadcast {type:"audio"}). O iframe
// local também puxa via hello (audioHistoryForHello) ao reconectar — o cursor `delivered`
// coordena os dois p/ não tocar em dobro.
export function playOrQueueAudio(sid, partial) {
    const item = appendAudioItem(sid, partial);
    if (!item) return;
    persistAudioState();
    pushAudio(sid);
}

// Entrega AO VIVO ao iframe da PRÓPRIA sessão: transmite os itens ainda não enviados
// (seq > delivered) como eventos {type:"audio"} e avança o cursor de ENVIO. LOCAL-only
// (broadcastTo aos clientes DESTE sid); se não há cliente conectado é no-op e o hello
// reentrega. Idempotente: nunca reenvia o que o hello já entregou (delivered=último no hello).
export function pushAudio(sid) {
    if (!sid) return;
    const hist = audioHistoryBySid.get(sid) || [];
    if (!hist.length) return;
    let delivered = audioDeliveredBySid.get(sid) || 0;
    let changed = false;
    for (const item of hist) {
        if (item.seq > delivered) {
            broadcastTo(sid, { type: "audio", item });
            delivered = item.seq;
            changed = true;
        }
    }
    if (changed) { audioDeliveredBySid.set(sid, delivered); persistAudioState(); }
}

// The audio state the hello hands the LOCAL (re)connecting iframe: the FULL own-session
// history (for the navigable player) + playFromSeq = the first seq it hasn't HEARD
// (ouvido de verdade), so the client autoplays only the tail that wasn't played to
// completion yet. playFromSeq usa o cursor HEARD (durável) — fechar no meio da fala
// retoca ao reabrir. Leitura local: sem push cross-fork, sem avançar cursor de envio.
export function audioHistoryForHello(sid) {
    const hist = audioHistoryBySid.get(sid) || [];
    const playFromSeq = (audioHeardBySid.get(sid) || 0) + 1;
    // Coordena com pushAudio: o hello já entregou TODO o histórico ao iframe -> marca
    // delivered=último p/ a entrega ao vivo (pushAudio) não retransmitir esses itens.
    if (hist.length) audioDeliveredBySid.set(sid, hist[hist.length - 1].seq);
    return { items: hist, playFromSeq, max: AUDIO_HISTORY_MAX };
}

// LEITURA PURA (contrato de PARCEIRO — ex.: copilot-mobile via GET /audio): devolve o histórico de
// áudio da sessão SEM NENHUM efeito colateral — NÃO entrega ao vivo, NÃO avança cursor delivered/heard,
// NÃO persiste, NÃO drena pending. Retorna uma CÓPIA (slice) p/ o chamador não
// mexer no array interno. `since` (opcional) filtra seq > since p/ polling incremental. sid desconhecido
// ou sem áudio ⇒ { items: [] }. É o único jeito seguro de um parceiro reusar o áudio sem tocar na sessão.
export function audioHistoryReadOnly(sid, since) {
    if (!sid) return { items: [] };
    const hist = audioHistoryBySid.get(sid) || [];
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const items = from ? hist.filter((it) => it.seq > from) : hist.slice();
    return { items };
}
// Só ISTO consome a fila de verdade: um áudio entregue mas não tocado (painel fechado no
// meio) segue com seq > heard e retoca no próximo reabrir. Persiste (sobrevive restart).
export function markPlayed(sid, seq) {
    if (!sid || !(seq > 0)) return false;
    const last = audioSeqBySid.get(sid) || 0;
    if (seq > last) seq = last;   // clamp: nunca parkear o cursor ALÉM do último seq emitido (cliente stale/malformado)
    const cur = audioHeardBySid.get(sid) || 0;
    if (seq <= cur) return false;
    audioHeardBySid.set(sid, seq);
    persistAudioState();
    return true;
}

export function readAudioStateMap() {
    return readJson(AUDIO_QUEUE_FILE, {});
}
export function persistAudioState() {
    try {
        const map = readAudioStateMap();   // parte do DISCO: preserva sids que ESTA fork não tem em memória.
        for (const [sid, hist] of audioHistoryBySid) {   // (numa promoção o secundário só conhece um PREFIXO -> não pode apagar/truncar o resto)
            if (!hist || !hist.length) continue;         // sid vazio em memória NÃO apaga o registro do disco
            const prev = map[sid];
            const memSeq = audioSeqBySid.get(sid) || 0;
            const memHeard = audioHeardBySid.get(sid) || 0;
            // GUARD de escrita (espelha o reload): se o DISCO está mais à frente que a visão desta fork
            // (prefixo stale), NÃO clobbera — só sobe o heard. Impede regredir seq/heard e truncar o
            // histórico durável (defense-in-depth p/ o dia em que "só o primário persiste" deixar de valer).
            if (prev && !Array.isArray(prev) && (prev.seq || 0) > memSeq) {
                prev.heard = Math.max(prev.heard || 0, memHeard);
                continue;
            }
            map[sid] = {
                items: hist, seq: memSeq,
                turn: audioTurnBySid.get(sid) || 1, delivered: audioDeliveredBySid.get(sid) || 0,
                heard: Math.max(memHeard, (prev && !Array.isArray(prev) && prev.heard) || 0),   // heard nunca regride no disco
            };
        }
        writeJsonAtomic(AUDIO_QUEUE_FILE, map);   // atômico: um crash NO MEIO não deixa o arquivo TORN (readAudioStateMap veria {} = perde TODAS as filas no restart)
    } catch { }
}
export function restoreAudioHistory() {
    try {
        const map = readAudioStateMap();
        for (const [sid, v] of Object.entries(map)) {
            // New format: { items, seq, turn, delivered }. Legacy: a bare item[].
            const items = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
            if (!items.length) continue;
            let maxSeq = 0;
            items.forEach((it, i) => {                 // backfill legacy items
                if (typeof it.seq !== "number") it.seq = i + 1;
                if (typeof it.turn !== "number") it.turn = 1;
                if (!it.id) it.id = `${sid}:${it.seq}`;
                if (it.seq > maxSeq) maxSeq = it.seq;
            });
            audioHistoryBySid.set(sid, items);
            audioSeqBySid.set(sid, Array.isArray(v) ? maxSeq : (v.seq || maxSeq));
            audioTurnBySid.set(sid, Array.isArray(v) ? 1 : (v.turn || 1));
            // `delivered` = cursor de ENVIO (dedup do push AO VIVO), NÃO de "ouvido". No restart é
            // inerte p/ o replay (o replay é governado pelo HEARD: playFromSeq=heard+1) e o
            // audioHistoryForHello re-seta delivered=último ao reabrir; mantém o valor persistido.
            audioDeliveredBySid.set(sid, Array.isArray(v) ? 0 : (v.delivered || 0));
            // Cursor DURÁVEL de "ouvido": back-compat -> se o formato antigo não tem `heard`,
            // assume heard = delivered (o antigo tratava entrega como consumo). Só o áudio
            // acumulado ANTES desta versão herda isso; o novo passa a exigir ack real.
            audioHeardBySid.set(sid, Array.isArray(v) ? 0 : (v.heard != null ? v.heard : (v.delivered || 0)));
        }
    } catch { }
}
