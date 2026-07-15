// voice-audio.mjs — histórico de áudio durável por sessão.
//
// Append -> entrega ao vivo (push) -> ACK de reprodução (markPlayed) -> persistência atômica.
// O cursor HEARD (durável) governa o autoplay ao reabrir; DELIVERED é só dedup do push ao vivo.
// Importa broadcastTo/sessionHasClient da entry (declarações de função = seguras no ciclo ESM).

import { join } from "node:path";
import shared from "./voice-shared.cjs";
import { dbg, readJson, writeJsonAtomic } from "./voice-core.mjs";
import {
    activeSid,
    audioHistoryBySid, audioSeqBySid, audioTurnBySid, audioDeliveredBySid, audioHeardBySid,
} from "./voice-state.mjs";
import { broadcastTo, sessionHasClient } from "./extension.mjs";

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

// Deliver to the active+connected client every history item it hasn't seen yet
// (seq > deliveredSeq), in order, and advance the cursor. Idempotent: a second
// call finds nothing new. Used on live append, on /focus and on reconnect.
// Returns true iff it advanced the cursor (and thus persisted) — lets the caller
// avoid a second whole-map write for the same audio.
export function pushAudio(sid) {
    if (!sid || sid !== activeSid || !sessionHasClient(sid)) return false;
    const hist = audioHistoryBySid.get(sid) || [];
    if (!hist.length) return false;
    const delivered = audioDeliveredBySid.get(sid) || 0;
    const fresh = hist.filter((it) => it.seq > delivered);
    if (!fresh.length) return false;
    audioDeliveredBySid.set(sid, hist[hist.length - 1].seq);
    persistAudioState();
    for (const item of fresh) broadcastTo(sid, { type: "audio", item });
    dbg(`pushAudio: delivered ${fresh.length} audio item(s) to sid=${sid}`);
    return true;
}

// Public entry used by speakToCanvas: record the audio in history, then deliver
// it live if this session is active (else it waits in history for the reopen).
// ONE whole-map persist per audio: if pushAudio delivered (active session) it already
// persisted the cursor advance; otherwise (background) we persist the appended item here.
export function playOrQueueAudio(sid, partial) {
    const item = appendAudioItem(sid, partial);
    if (!item) return;
    if (!pushAudio(sid)) persistAudioState();
}

// The audio state the hello hands a (re)connecting client: the FULL per-session
// history (for the navigable player) + playFromSeq = the first seq it hasn't
// HEARD (ouvido de verdade), so the client autoplays only the tail that wasn't
// played to completion yet. playFromSeq usa o cursor HEARD (durável), NÃO o de
// entrega — assim fechar no meio da fala retoca ao reabrir. Avança o cursor de
// ENVIO (delivered) p/ o topo só p/ o push ao vivo não reenviar o que o hello já mandou.
export function audioHistoryForHello(sid) {
    const hist = audioHistoryBySid.get(sid) || [];
    const playFromSeq = (audioHeardBySid.get(sid) || 0) + 1;
    if (hist.length) {
        audioDeliveredBySid.set(sid, hist[hist.length - 1].seq);   // cursor de ENVIO (não o de "ouvido")
        persistAudioState();
    }
    return { items: hist, playFromSeq, max: AUDIO_HISTORY_MAX };
}

// O cliente confirmou que TOCOU o item `seq` até o fim -> avança o cursor DURÁVEL de
// "ouvido" (monotônico; um ack de seq menor, ex. replay manual de item antigo, é no-op).
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

// PROMOÇÃO in-process (secundário -> primário): a memória desta fork é um PREFIXO congelado no
// boot dela (secundários não geram áudio — forwardam /speak ao primário). O disco tem a verdade
// que o primário MORTO persistiu. Recarrega do disco antes de servir hello/ack — adota o
// histórico/seq quando o disco está à frente e é RAISE-only no heard — p/ (a) o clamp de
// markPlayed ver o ÚLTIMO seq real (senão um ack legítimo do cliente é descartado = replay
// duplicado) e (b) o novo primário persistir o histórico COMPLETO (senão o persist truncaria).
export function reloadAudioStateFromDisk() {
    try {
        const map = readAudioStateMap();
        for (const [sid, v] of Object.entries(map)) {
            if (Array.isArray(v) || !v) continue;
            const items = Array.isArray(v.items) ? v.items : [];
            if (!items.length) continue;
            if ((v.seq || 0) >= (audioSeqBySid.get(sid) || 0)) {   // disco à frente-ou-igual -> adota a visão do disco
                audioHistoryBySid.set(sid, items);
                audioSeqBySid.set(sid, v.seq || 0);
                audioTurnBySid.set(sid, v.turn || audioTurnBySid.get(sid) || 1);
                audioDeliveredBySid.set(sid, v.delivered || 0);
            }
            audioHeardBySid.set(sid, Math.max(audioHeardBySid.get(sid) || 0, v.heard != null ? v.heard : 0));   // heard NUNCA regride
        }
    } catch { }
}
