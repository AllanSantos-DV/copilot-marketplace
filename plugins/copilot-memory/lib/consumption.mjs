// Instrumentação de CONSUMO (M4 P0). Mede o elo que os revisores exigiram provar ANTES de gerar
// skills: quando um PONTEIRO de skill é injetado no recall, o agente vai buscar o corpo (memory_get)?
//
// NÃO duplica a telemetria do servidor: o RecallUsageCollector registra o RECALL (compose) do lado
// servidor; aqui medimos a CONVERSÃO ponteiro→fetch do lado CLIENTE (o servidor não correlaciona
// "este id foi injetado como ponteiro nesta sessão" com o getDocument posterior). É conhecimento
// local, só ids/escopo, arquivo local — privacidade preservada.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
    return process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
}
export function consumptionLogPath() {
    return join(dir(), "consumption.jsonl");
}

// append best-effort: nunca lança, nunca bloqueia o hook (fire-and-forget).
function append(rec) {
    (async () => {
        try {
            await mkdir(dir(), { recursive: true });
            await appendFile(consumptionLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
        } catch { /* telemetria é best-effort */ }
    })();
}

// Um recall foi injetado: registra quais IDs de skill (ponteiros) entraram no contexto.
export function recordRecall({ sessionId, projectId, source, pointerIds, count }) {
    append({ kind: "recall", sessionId: sessionId || null, projectId: projectId || null, source: source || null, pointerIds: Array.isArray(pointerIds) ? pointerIds : [], count: count || 0 });
}

// O agente buscou o corpo de um documento (memory_get): registra o fetch para correlacionar.
export function recordFetch({ sessionId, projectId, id }) {
    append({ kind: "fetch", sessionId: sessionId || null, projectId: projectId || null, id: id || null });
}
