// shadowVerifier.mjs — ADAPTER do shadow-verifier (reforma Fase 4). Dá ao modo-sombra o poder de CONFIRMAR uma
// alegação BINARY_VERIFIABLE com evidência de tool, em vez de fabricar. Orquestra o verifierWorker (node limpo
// com tools read-only fail-closed) e IMPÕE o controle de custo: cap por sessão + cooldown entre chamadas +
// degradação SINALIZADA (nunca some calado). `spawn` é injetável (teste determinístico sem LLM/rede).
import { spawn as nodeSpawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNode } from "../util/resolveNode.mjs";
import { workers } from "../util/workerRegistry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "agents", "verifierWorker.mjs");

// SPAWN de produção: node LIMPO rodando o verifierWorker; escreve o job no stdin, coleta o JSON do stdout.
// NUNCA lança — devolve {ok:false,error} (o adapter degrada). CONTROLE POR ATIVIDADE: o verifierWorker pulsa
// \x1e a cada evento do SDK; aqui reseta a cada byte do filho e SÓ mata no SILÊNCIO TOTAL por `idleMs` — um
// verificador que TRABALHA nunca é morto por tempo decorrido (nada de relógio de parede fixo).
function defaultSpawn({ claim, repo, model, idleMs = 180000 }) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, lastBeat = Date.now();
    const env = { ...process.env, NODE_OPTIONS: "", COPILOT_SDK_PATH: "" };
    env.MODO_AUTO_WORKER_CWD = repo; if (model) env.MODO_AUTO_WORKER_MODEL = model;
    let child, reaper = null;
    const finish = (v) => { if (done) return; done = true; if (reaper) { clearInterval(reaper); reaper = null; } workers.reap(child); resolve(v); };
    try { child = nodeSpawn(resolveNode(), [WORKER], { env, cwd: repo, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: "spawn: " + (e?.message || e) }); }
    workers.track(child);
    const bump = () => { lastBeat = Date.now(); };
    reaper = setInterval(() => { if (Date.now() - lastBeat > idleMs) { finish({ ok: false, error: `zombie: verificador MUDO (sem heartbeat) por ${Math.round(idleMs / 1000)}s` }); } }, 5000);
    child.stdout.on("data", (d) => { out += d; bump(); });
    child.stderr.on("data", (d) => { err += String(d).replace(/\x1e/g, ""); bump(); }); // \x1e = heartbeat (atividade)
    child.on("close", () => { if (reaper) { clearInterval(reaper); reaper = null; } if (done) return; done = true; try { resolve(JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0])); } catch { resolve({ ok: false, error: "parse stdout: " + (out || err).slice(0, 200) }); } });
    child.on("error", (e) => { finish({ ok: false, error: "child: " + (e?.message || e) }); });
    try { child.stdin.write(JSON.stringify({ claim, repo, model })); child.stdin.end(); } catch (e) { finish({ ok: false, error: "stdin: " + (e?.message || e) }); }
  });
}

/**
 * @param {{ spawn?:Function, maxPerSession?:number, cooldownTurns?:number, repo?:string, model?:string, log?:Function }} opts
 *  cap/cooldown: o verificador roda LLM+tools (custo real) → limita a `maxPerSession` por sessão e exige
 *  `cooldownTurns` turnos entre chamadas. Ao estourar, DEGRADA sinalizado ({degraded:true,reason}) — o caller
 *  cai no LANE_GUARD residual (marca "a VERIFICAR"), nunca fabrica nem some calado.
 */
export function createShadowVerifier({ spawn = defaultSpawn, maxPerSession = 6, cooldownTurns = 2, repo = process.cwd(), model, log = () => {} } = {}) {
  let used = 0, lastTurn = -Infinity;
  return {
    id: "shadow-verifier",
    stats() { return { used, maxPerSession, cooldownTurns }; },
    /**
     * Verifica UMA alegação BINARY_VERIFIABLE. Devolve:
     *  { ok:true, holds:true|false|null, evidence, toolCalls } — verificado (holds=true confirma, false refuta).
     *  { ok:false, degraded:true, reason:"cost-cap"|"cooldown" } — não rodou por controle de custo (SINALIZADO).
     *  { ok:false, error } — falha real do worker (SINALIZADO; caller trata como não-verificado).
     * Nunca lança.
     */
    async verify(claim, { turn = 0, repo: repoOverride, model: modelOverride } = {}) {
      const c = String(claim || "").trim();
      if (!c) return { ok: false, error: "claim vazio" };
      if (used >= maxPerSession) { log(`[verifier] cap ${maxPerSession}/sessão atingido → degrada (cost-cap)`); return { ok: false, degraded: true, reason: "cost-cap", holds: null }; }
      if (turn - lastTurn < cooldownTurns) { log(`[verifier] cooldown (${cooldownTurns} turnos) → degrada`); return { ok: false, degraded: true, reason: "cooldown", holds: null }; }
      used++; lastTurn = turn;
      let r;
      try { r = await spawn({ claim: c, repo: repoOverride || repo, model: modelOverride || model }); }
      catch (e) { return { ok: false, error: "spawn: " + (e?.message || e) }; }
      if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || "verificador sem resultado", holds: null };
      const holds = r.holds === true ? true : r.holds === false ? false : null;
      log(`[verifier] '${c.slice(0, 60)}' → holds=${holds} (tools: ${(r.toolCalls || []).join(",") || "?"})`);
      return { ok: true, holds, evidence: String(r.evidence || ""), toolCalls: r.toolCalls || [] };
    },
  };
}
