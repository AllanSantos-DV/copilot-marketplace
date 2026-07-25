// PROBE de modelos disponíveis — spawna um node LIMPO rodando modelListWorker (mesmo padrão do
// agentFactory: resolve o node REAL, limpa NODE_OPTIONS/COPILOT_SDK_PATH). Devolve [{id,enabled,reasoning}].
// FAIL LOUD: spawn/timeout/JSON inválido → REJEITA (o caller decide degradar com sinal, nunca mascarar).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveNode } from "../util/resolveNode.mjs";
import { workers } from "../util/workerRegistry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "modelListWorker.mjs");

export function probeAvailableModels({ cwd = process.cwd(), timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.COPILOT_SDK_PATH;
    env.MODO_AUTO_WORKER_CWD = cwd;
    const child = spawn(resolveNode(), [WORKER], { env, stdio: ["ignore", "pipe", "pipe"] });
    workers.track(child);
    let out = "", err = "";
    const timer = setTimeout(() => { workers.reap(child); reject(new Error(`modelProbe: timeout ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("modelProbe spawn: " + e.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const m = out.match(/<<<MODELS>>>([\s\S]*?)<<<END>>>/);
      if (!m) return reject(new Error(`modelProbe: sem saída de modelos (code=${code}): ${(err || out).slice(0, 200)}`));
      try {
        const list = JSON.parse(m[1]);
        if (!Array.isArray(list) || !list.length) return reject(new Error("modelProbe: lista de modelos vazia"));
        resolve(list);
      } catch (e) { reject(new Error("modelProbe: JSON inválido: " + e.message)); }
    });
  });
}
