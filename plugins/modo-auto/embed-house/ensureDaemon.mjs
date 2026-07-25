// ensureDaemon.mjs — CLIENTE FINO da casa de embeddings ÚNICA. Qualquer plugin importa isto pra obter um
// endpoint de embed vivo, SEM carregar o modelo e SEM empacotar o servidor. Contrato: NUNCA lança — devolve
// {available:false,reason} e o caller degrada (heurístico sinalizado). A casa é SEMPRE compartilhada: uma só
// instalação em ~/.embed-house/bin, provisionada por download do release público. NÃO existe mais ramo
// "bundled" que suba um servidor de dentro do plugin — o modo-auto é CONSUMIDOR puro, não dono da casa.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveNode } from "./resolveNode.mjs";

const RUNTIME = join(homedir(), ".embed-house", "run", "runtime.json");
const PROTOCOL_MIN = 1;
const MODEL = "Xenova/all-MiniLM-L6-v2";
const DIM = 384;
const STALE_MS = 90000;   // 3 batimentos perdidos (heartbeat do server é 30s) → runtime.json obsoleto

// Lê o runtime.json SE fresco (mtime < STALE_MS). null se ausente/obsoleto/ilegível. Nunca lança.
function readFreshRuntime() {
  try {
    const st = statSync(RUNTIME);
    if (Date.now() - st.mtimeMs > STALE_MS) return null;   // heartbeat parou → daemon morto/preso
    const info = JSON.parse(readFileSync(RUNTIME, "utf8"));
    if (!info?.port || !Number.isInteger(info.protocol)) return null;
    return info;
  } catch { return null; }
}

// GET /health e valida o HANDSHAKE de protocolo (guardrail R3): protocol>=MIN E model/dim batem — senão
// é uma casa INCOMPATÍVEL (não servir vetor de dim/modelo errado). Devolve o info ou null. Nunca lança.
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const h = await r.json();
    if (!h || h.protocol < PROTOCOL_MIN || h.model !== MODEL || h.dim !== DIM) return null;
    return h;
  } catch { return null; }
}

// Sobe a casa a partir do server.mjs PROVISIONADO (~/.embed-house/bin, caminho dado) detached e espera o
// auto-anúncio. Não há mais server empacotado no plugin. A corrida por singleton é resolvida DENTRO do
// server (port-lock) — quem perde sai; ambos convergem no mesmo runtime.json.
async function spawnServer(serverPath, log, bootTimeoutMs) {
  try {
    const node = resolveNode();
    const child = spawn(node, [serverPath], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", COPILOT_SDK_PATH: "" },   // node LIMPO (fora do fork da extensão)
    });
    child.unref();
    log(`[embed-house/client] server disparado (${node} ${serverPath}); aguardando anúncio…`);
  } catch (e) {
    log(`[embed-house/client] falha ao subir server (sinalizado): ${e?.message || e}`);
    return null;
  }
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    const info = readFreshRuntime();
    if (info && await health(info.port)) return info;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/**
 * Garante uma casa viva e devolve o endpoint. CADEIA: fast-path (casa já viva) → casa compartilhada
 * provisionada (~/.embed-house/bin: reusa se a versão instalada satisfaz o pin, senão baixa+atualiza do
 * release público). NÃO há mais ramo bundled (o consumidor não carrega servidor). O singleton (port-lock)
 * garante UMA casa só, não importa quem suba. NUNCA lança (o fallback é do caller).
 * @returns {Promise<{available:true, port:number, protocol:number} | {available:false, reason:string}>}
 */
export async function ensureDaemon({ log = () => {}, bootTimeoutMs = 60000, allowDownload = true, useShared = true } = {}) {
  // 1) FAST PATH (~ms): runtime.json fresco + handshake de saúde → reusa a casa JÁ viva (convergência single-house).
  const fresh = readFreshRuntime();
  if (fresh) {
    const h = await health(fresh.port);
    if (h) { log(`[embed-house/client] fast-path: casa viva em ${fresh.port} (protocol ${h.protocol})`); return { available: true, port: fresh.port, protocol: h.protocol }; }
    log(`[embed-house/client] runtime.json fresco mas /health incompatível/mudo — vai rebootstrapar`);
  }
  // 2) CASA COMPARTILHADA via provision: REUSA a instalada SE a versão satisfaz o pin; senão BAIXA+ATUALIZA
  //    (update-on-use) do release público. allowDownload=false → só reusa (sem rede). Import lazy (degrada se ausente).
  if (useShared) {
    try {
      const { provision } = await import("./provision.mjs");
      const p = await provision({ log, allowNetwork: allowDownload });
      if (p.ok) {
        const info = await spawnServer(p.serverPath, log, bootTimeoutMs);
        if (info) { log(`[embed-house/client] casa compartilhada (${p.reused ? "instalada" : "baixada"} v${p.version}) → ${info.port}`); return { available: true, port: info.port, protocol: info.protocol }; }
      } else { log(`[embed-house/client] provision: ${p.reason}`); }
    } catch (e) { log(`[embed-house/client] provision indisponível (sinalizado): ${e?.message || e}`); }
  }
  return { available: false, reason: "sem casa: fast-path/compartilhada falharam" };
}

/**
 * POST /embed (batch). LANÇA em falha real (o caller — embedder — captura, devolve null e o drift cai no
 * heurístico sinalizado; SEM in-process). Guardrail fail-loud: valida que veio {vectors:[][]} de verdade;
 * nunca devolve vetor fake/silencioso.
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(port, texts) {
  const r = await fetch(`http://127.0.0.1:${port}/embed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`embed-house /embed ${r.status}: ${j?.error || "sem corpo"}`);
  if (!j || !Array.isArray(j.vectors)) throw new Error("embed-house /embed: resposta sem {vectors}");
  return j.vectors;
}
