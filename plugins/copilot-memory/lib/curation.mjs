// Orquestração da CURADORIA (o distiller correto). Incremental e idempotente: cura os checkpoints do
// Copilot (saída já curada) que ainda não foram processados, depois os turnos VIVOS após o último
// ponto já curado. Cada bloco vai para o curador LLM (semântico), e as skills propostas são
// persistidas via o callback injetado. O progresso é marcado por id determinístico (ledger) para
// nunca recurar. Roda em BACKGROUND no SessionStart; nunca lança (erros vão no summary).
import { listCheckpoints, readCheckpoint } from "./checkpoints.mjs";
import { cleanTranscript, groupIntoBlocks } from "./transcript.mjs";
import { isCheckpointCurated, markCheckpointCurated, liveProgress, markLiveProgress } from "./curationLedger.mjs";
import { curateBlock } from "./curator.mjs";
import { redact } from "./redact.mjs";

// deps: { sessionId, workingDirectory, getEvents, persistSkill, maxBlockChars?, curator?, curatorOpts?, log? }
//  - getEvents:    async () => SessionEvent[]  (do hostSession)
//  - persistSkill: async (skill, meta) => any  (valida/dedup/salva; skill = {kind,name,description,body})
//  - curator:      async (text, opts) => { skills, error? }  (default: curateBlock)
// Retorna um summary { checkpoints, liveBlocks, skills, errors }.
//
// Serializa por sessionId: o background (onSessionStart) e a tool memory_distill chamam runCuration no
// MESMO processo/sessão; sem serialização, um curaria o mesmo checkpoint/bloco que o outro está a
// curar (check-then-act em volta do await do LLM) → dupla curadoria + duplicata. Um mutex in-process
// por sessionId (fila de Promises) garante que só uma curadoria corre por vez para a sessão.
const sessionLocks = new Map();

export async function runCuration(deps = {}) {
    const sid = deps && deps.sessionId;
    if (!sid) return await runCurationInner(deps);
    const prev = sessionLocks.get(sid) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const chained = prev.then(() => gate);
    sessionLocks.set(sid, chained);
    try {
        await prev;                       // espera a curadoria anterior desta sessão terminar
        return await runCurationInner(deps);
    } finally {
        release();
        if (sessionLocks.get(sid) === chained) sessionLocks.delete(sid);
    }
}

async function runCurationInner(deps = {}) {
    const {
        sessionId,
        workingDirectory,
        getEvents,
        persistSkill,
        maxBlockChars = 12000,
        maxUnits = Infinity,   // teto de unidades (checkpoints + blocos) por chamada; ilimitado no background
        curator = curateBlock,
        curatorOpts = {},
        log = () => {},
    } = deps;

    const summary = { checkpoints: 0, liveBlocks: 0, skills: 0, errors: [], remaining: 0 };
    if (!sessionId || typeof persistSkill !== "function") {
        summary.errors.push("deps insuficientes (sessionId/persistSkill)");
        return summary;
    }
    let units = 0;

    const saveAll = async (skills, meta) => {
        for (const s of skills || []) {
            try {
                await persistSkill(s, meta);
                summary.skills++;
            } catch (e) {
                summary.errors.push("persist: " + (e?.message || e));
            }
        }
    };

    // ── 1) Checkpoints não curados (do mais antigo ao mais novo) ──────────────────────────────
    const cps = listCheckpoints(sessionId);
    for (const cp of cps) {
        if (isCheckpointCurated(sessionId, cp.id)) continue;
        if (units >= maxUnits) { summary.remaining++; continue; }
        const text = readCheckpoint(cp.path);
        if (!text.trim()) { markCheckpointCurated(sessionId, cp.id); continue; }
        log(`curando checkpoint ${cp.file}…`);
        const safe = redact(text).text;
        const { skills, error } = await curator(safe, { workingDirectory, sourceLabel: `checkpoint ${cp.file}`, ...curatorOpts });
        if (error) { summary.errors.push(`cp ${cp.file}: ${error}`); continue; } // não marca → tenta depois
        await saveAll(skills, { source: "checkpoint", ref: cp.file });
        markCheckpointCurated(sessionId, cp.id);
        summary.checkpoints++;
        units++;
    }

    // ── 2) Turnos vivos após o último ponto já curado ─────────────────────────────────────────
    let events = [];
    try { events = typeof getEvents === "function" ? await getEvents() : []; } catch (e) { summary.errors.push("getEvents: " + (e?.message || e)); }
    const turns = cleanTranscript(events);
    const lastId = liveProgress(sessionId);
    let startIdx = 0;
    if (lastId) {
        const i = turns.findIndex((t) => t.id === lastId);
        // Achou → retoma após ele. NÃO achou (o marcador saiu do tail por compactação) → NO-OP:
        // assume que tudo até o tail atual já foi curado, em vez de recurar do zero (custo + duplicata).
        startIdx = i >= 0 ? i + 1 : turns.length;
    }
    const fresh = turns.slice(startIdx);
    // Deixa turnos muito recentes "descansarem"? Não — curamos tudo o que fechou um bloco cheio; um
    // resto pequeno (< maxBlockChars) fica para a próxima rodada, quando terá mais contexto.
    const blocks = groupIntoBlocks(fresh, maxBlockChars);
    const fullBlocks = blocks.length && blocks[blocks.length - 1].text.length < maxBlockChars * 0.5
        ? blocks.slice(0, -1)  // segura o último bloco pequeno para acumular mais na próxima
        : blocks;
    for (const b of fullBlocks) {
        if (units >= maxUnits) { summary.remaining++; continue; }
        log(`curando turnos vivos (${b.turns} turnos)…`);
        const safe = redact(b.text).text;
        const { skills, error } = await curator(safe, { workingDirectory, sourceLabel: "turnos vivos", ...curatorOpts });
        if (error) { summary.errors.push("live: " + error); break; } // para, sem marcar progresso
        await saveAll(skills, { source: "live", ref: b.toId });
        markLiveProgress(sessionId, b.toId);
        summary.liveBlocks++;
        units++;
    }

    return summary;
}
