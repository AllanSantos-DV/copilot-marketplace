// voice-turns.mjs — entrega durável de turnos de voz (held-turn) por sessão.
//
// Importa broadcastTo/httpPostJson/handleVoiceTranscript da entry (declarações de função
// = seguras no ciclo ESM). O estado (filas + dedup de ids) vem de voice-state.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import shared from "./voice-shared.cjs";
import { dbg, readJson, writeJsonAtomic } from "./voice-core.mjs";
import {
    pendingTurnsBySid, drainingTurns, injectedTurnIds, injectedTurnOrder, injectingIds, forks,
} from "./voice-state.mjs";
import { broadcastTo, httpPostJson } from "./voice-net.mjs";
import { handleVoiceTranscript } from "./extension.mjs";

const ARTIFACTS = shared.resolveDataDir();
// --- Held voice-turn delivery (per-session, persisted) ----------------------
// A transcript captured while the owner session is in the background must reach
// THAT session's fork to run session.send(). The HTTP push can miss transiently
// (owner panel closed -> server down but heartbeat still advertises the port; or
// the fork has not re-registered yet). Turns are therefore held in a persisted
// per-sid FIFO and delivered when the owner is provably reachable: right after it
// (re-)registers (fresh, live URL), on focus, and via a safety sweep. Delivery is
// idempotent (peek -> ack -> remove, one in-flight per sid) and each turn carries
// an id the receiver uses to reject a duplicate after a failover.
const PENDING_TURNS_FILE = join(ARTIFACTS, "pending-turns.json");
const TURN_TTL_MS = 90000;           // give up (and tell the user) after 90s
export function readPendingTurnsMap() {
    return readJson(PENDING_TURNS_FILE, {});
}
export function persistPendingTurns(sid) {
    if (!sid) return;
    try {
        const map = readPendingTurnsMap();
        const q = pendingTurnsBySid.get(String(sid)) || [];
        if (q.length) map[String(sid)] = q; else delete map[String(sid)];
        writeJsonAtomic(PENDING_TURNS_FILE, map);   // ATÔMICO (tmp+rename): o primário E o fork dono escrevem
    } catch { }                                     // este arquivo concorrentemente -> nunca deixar torn/half-write.
}
export function restorePendingTurns() {
    try {
        const map = readPendingTurnsMap();
        const now = Date.now();
        for (const [sid, items] of Object.entries(map)) {
            if (!Array.isArray(items)) continue;
            const fresh = items.filter((it) => it && it.text && (now - (it.ts || 0)) < TURN_TTL_MS);
            if (fresh.length) pendingTurnsBySid.set(String(sid), fresh);
        }
    } catch { }
}
export function enqueueTurn(sid, text) {
    const t = (text || "").trim();
    if (!sid || !t) return null;
    const q = pendingTurnsBySid.get(sid) || [];
    const entry = { id: randomBytes(8).toString("hex"), text: t, ts: Date.now() };
    q.push(entry);
    pendingTurnsBySid.set(sid, q);
    persistPendingTurns(sid);
    return entry;
}
export function pruneExpiredTurns(sid) {
    const q = pendingTurnsBySid.get(sid);
    if (!q || !q.length) return;
    const now = Date.now();
    const fresh = q.filter((it) => (now - (it.ts || 0)) < TURN_TTL_MS);
    if (fresh.length === q.length) return;
    const dropped = q.length - fresh.length;
    if (fresh.length) pendingTurnsBySid.set(sid, fresh); else pendingTurnsBySid.delete(sid);
    persistPendingTurns(sid);
    dbg(`pending turn(s) expired for sid=${sid}: dropped ${dropped}`);
    broadcastTo(sid, { type: "error", msg: "Não consegui entregar sua fala a esta sessão (ficou indisponível). Fale de novo, por favor." });
}
// Reconcilia a fila EM MEMÓRIA do primário contra o DISCO (fonte da verdade). O fork DONO, ao auto-entregar
// (selfDeliverOwnTurns), REMOVE o turno do disco mas o primário mantém a cópia em memória (nunca relê disco
// em runtime). Sem isto, após um RESTART do fork dono (injectedTurnIds em memória zera), o re-push do primário
// re-injetaria a fala (DOBRADA) e/ou o TTL expiraria a "zumbi" com um falso "não entreguei" (achado do review).
// Solta um turno só quando o disco o confirma AUSENTE E ele já tem idade (>3s) — a guarda de idade protege
// contra uma leitura de disco transitoriamente vazia race-ando com um enqueue recém-escrito. Seguro porque
// persistPendingTurns agora é ATÔMICO (writeJsonAtomic): {} no disco = vazio de verdade, não meio-escrito.
export function reconcileAgainstDisk(sid) {
    const q = pendingTurnsBySid.get(sid);
    if (!q || !q.length) return;
    const map = readPendingTurnsMap();
    const onDisk = new Set((Array.isArray(map[sid]) ? map[sid] : []).map((e) => e && e.id));
    const now = Date.now();
    const kept = q.filter((e) => e && (onDisk.has(e.id) || (now - (e.ts || 0)) < 3000));
    if (kept.length === q.length) return;
    if (kept.length) pendingTurnsBySid.set(sid, kept); else pendingTurnsBySid.delete(sid);
    dbg(`reconcileAgainstDisk sid=${sid}: soltou ${q.length - kept.length} turno(s) já auto-entregue(s)`);
}
export function drainTurnsToFork(sid, urlArg) {
    if (!sid) return;
    if (drainingTurns.has(sid)) return;            // an /inject is already in flight for this sid
    pruneExpiredTurns(sid);
    reconcileAgainstDisk(sid);                      // solta o que o fork DONO já auto-entregou (removeu do disco)
    const q = pendingTurnsBySid.get(sid);
    if (!q || !q.length) return;
    const url = urlArg || forks.get(sid);
    if (!url) return;                              // owner not reachable yet; a later (re-)register/focus/sweep retries
    const head = q[0];
    drainingTurns.add(sid);
    dbg(`deliver turn -> sid=${sid} url=${url} id=${head.id} (queued=${q.length})`);
    httpPostJson(url, "/inject", { text: head.text, id: head.id }).then((ok) => {
        drainingTurns.delete(sid);
        if (!ok) return;                           // keep the head queued; retry on next trigger
        const cur = pendingTurnsBySid.get(sid);
        if (cur && cur.length && cur[0].id === head.id) {
            cur.shift();
            if (cur.length) pendingTurnsBySid.set(sid, cur); else pendingTurnsBySid.delete(sid);
            persistPendingTurns(sid);
        }
        drainTurnsToFork(sid, url);                // deliver the next, in FIFO order
    });
}
export function drainAllPendingTurns() {
    for (const sid of [...pendingTurnsBySid.keys()]) drainTurnsToFork(sid);
}

// PULL DETERMINÍSTICO (entrega própria, sem HTTP): o fork DONO da sessão injeta os PRÓPRIOS turnos
// IN-PROCESS (session.send local via injectTurn), lendo a fila do DISCO — independente do painel/servidor
// efêmero estar de pé. Resolve o furo em que trocar de sessão fecha o servidor do fork dono e o turno
// ficava preso até o retorno: o fork segue VIVO em background (heartbeat+sweep de 5s), então ele mesmo
// drena a própria fila. Idempotente: injectTurn deduplica por id (sem double-send com um push do primário
// concorrente). Só remove do disco no sucesso; falha transitória fica na fila p/ o próximo sweep.
let _selfDraining = false;
export async function selfDeliverOwnTurns(ownSid) {
    const sid = String(ownSid || "");
    if (!sid || _selfDraining) return false;
    // Hidrata a memória a partir do DISCO (o primário enfileira no disco; este fork pode ter bootado antes
    // do turno existir, então não o teria em memória). Depois poda expirados.
    const map = readPendingTurnsMap();
    const disk = Array.isArray(map[sid]) ? map[sid] : [];
    if (disk.length) {
        const mem = pendingTurnsBySid.get(sid) || [];
        const seen = new Set(mem.map((e) => e && e.id));
        const merged = mem.concat(disk.filter((e) => e && e.id && !seen.has(e.id)));
        pendingTurnsBySid.set(sid, merged);
    }
    pruneExpiredTurns(sid);
    if (!(pendingTurnsBySid.get(sid) || []).length) return false;
    _selfDraining = true;
    let delivered = false;
    try {
        // FIFO: injeta a cabeça in-process; no sucesso, remove e segue. Um in-flight por vez (o guard acima).
        for (;;) {
            const q = pendingTurnsBySid.get(sid) || [];
            const head = q[0];
            if (!head) break;
            const r = await injectTurn(head.text, head.id);   // IN-PROCESS: handleVoiceTranscript -> session.send local
            if (!(r && (r.ok || r.dup))) break;               // transitório -> mantém na fila p/ o próximo sweep
            const cur = pendingTurnsBySid.get(sid);
            if (cur && cur.length && cur[0].id === head.id) {
                cur.shift();
                if (cur.length) pendingTurnsBySid.set(sid, cur); else pendingTurnsBySid.delete(sid);
                persistPendingTurns(sid);
                delivered = true;
            } else break;
        }
    } finally { _selfDraining = false; }
    return delivered;
}
// Receiver-side de-dup: a turn re-sent after a mid-inject failover must not run
// session.send() twice (the user raged about duplicated audio; same rule here).
export function seenInjectedId(id) { return !!id && injectedTurnIds.has(id); }
export function rememberInjectedId(id) {
    if (!id || injectedTurnIds.has(id)) return;
    injectedTurnIds.add(id);
    injectedTurnOrder.push(id);
    if (injectedTurnOrder.length > 300) injectedTurnIds.delete(injectedTurnOrder.shift());
}

// Recebe um turno entregue pelo primary. Retorna {ok, code, dup} para o handler traduzir
// em STATUS HTTP — porque o primary decide reter/re-rotear pelo status 2xx (httpPostJson),
// NÃO pelo corpo. Regras:
//  - texto vazio → 400 (nunca deveria acontecer; não fica na fila).
//  - id já visto → 200 dup (idempotente após um failover).
//  - senão roda o turno e AGUARDA o session.send: sucesso → 200 e só ENTÃO memoriza o id
//    (dedup só no sucesso, senão um retry após falha viraria dup e PERDERIA a fala);
//    falha (sessão morta/transitória) → 503 para o primary MANTER na fila e re-rotear
//    para uma fork viva (converge; nunca descarta o turno como o ok:true fire-and-forget
//    antigo, que perdia a fala quando a sessão estava morta).
export async function injectTurn(text, id) {
    const t = (text || "").trim();
    if (!t) return { ok: false, code: 400 };
    if (id && seenInjectedId(id)) return { ok: true, dup: true, code: 200 };
    // Já em andamento (o 1º inject ainda aguarda o send): NÃO rode de novo — retorna 409
    // (não-2xx, retryable) p/ o primary manter na fila sem duplicar a fala.
    if (id && injectingIds.has(id)) return { ok: false, retry: true, code: 409 };
    if (id) injectingIds.add(id);
    try {
        const ok = await handleVoiceTranscript(t);
        if (!ok) return { ok: false, retry: true, code: 503 };
        if (id) rememberInjectedId(id);
        return { ok: true, code: 200 };
    } finally {
        if (id) injectingIds.delete(id);
    }
}
