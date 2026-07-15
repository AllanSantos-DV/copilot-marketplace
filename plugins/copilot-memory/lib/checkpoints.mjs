// Leitura dos CHECKPOINTS do Copilot — a saída JÁ CURADA da sessão (markdown estruturado que o app
// gera nos pontos de compressão). São a fonte primária da curadoria: densos e livres de ruído de tool.
// Somente leitura; nunca escreve nem apaga checkpoints.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// session-state/<sid>/checkpoints. Env COPILOT_SESSION_STATE_DIR sobrepõe a raiz (testes).
export function checkpointsDir(sessionId) {
    const root = process.env.COPILOT_SESSION_STATE_DIR || join(homedir(), ".copilot", "session-state");
    return join(root, String(sessionId || ""), "checkpoints");
}

// Lista os checkpoints em ordem cronológica (001, 002, …). Cada um: { id, n, file, path }.
// id = nome do arquivo (determinístico e estável). Ausente/vazio → []. Nunca lança.
export function listCheckpoints(sessionId) {
    try {
        const dir = checkpointsDir(sessionId);
        if (!existsSync(dir)) return [];
        const files = readdirSync(dir)
            .filter((f) => /^\d+.*\.md$/i.test(f)) // NNN-*.md (ignora index.md)
            .sort(); // zero-padded → ordem cronológica lexicográfica
        return files.map((f) => {
            const m = f.match(/^(\d+)/);
            return { id: f, n: m ? parseInt(m[1], 10) : 0, file: f, path: join(dir, f) };
        });
    } catch {
        return [];
    }
}

// Conteúdo cru de um checkpoint (markdown curado). "" se ilegível. Nunca lança.
export function readCheckpoint(path) {
    try {
        return readFileSync(path, "utf8") || "";
    } catch {
        return "";
    }
}
