// rolloutFlags.mjs — ESTADO PERSISTIDO das flags de rollout (F1/F2/F4). Existe porque a 1ª versão usou variáveis
// de AMBIENTE e isso tornou o rollout INEXEQUÍVEL na prática: a extensão roda DENTRO do app Copilot, então o dono
// não tem como exportar env pro processo dela — as flags ficariam OFF pra sempre (o sombra pegou isso: "rollout
// nunca exercitado"). Aqui elas viram ESTADO, ligável por tool/painel, lido a cada chamada.
//
// PRECEDÊNCIA: arquivo (ação explícita do dono) > env (CI/testes) > default OFF. FAIL LOUD: erro de escrita
// devolve {ok:false,error} visível; leitura corrompida → default + log (nunca silencioso).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const FLAG_DEFAULTS = Object.freeze({
  f1: false,          // pré-filtro de diff no revisor
  bypassPct: 20,      // % de ciclos de CONTROLE do A/B do F1
  f2BudgetMs: 0,      // 0 = desligado; >0 = teto do ciclo de remediação
  f4: false,          // gate de complexidade (revisor raso p/ material pequeno)
  f4MaxLines: 0,      // 0 = usa o P25 medido; >0 = override explícito do dono (destrava o cold-start)
});

const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Flags vindas do AMBIENTE (fallback p/ CI e p/ quem realmente consegue exportar env).
export function flagsFromEnv(env = process.env) {
  return {
    f1: env.MODO_AUTO_F1_PREFILTER === "1",
    bypassPct: numOr(env.MODO_AUTO_F1_BYPASS_PCT, FLAG_DEFAULTS.bypassPct),
    f2BudgetMs: numOr(env.MODO_AUTO_F2_CYCLE_BUDGET_MS, 0),
    f4: env.MODO_AUTO_F4_SHALLOW_GATE === "1",
    f4MaxLines: numOr(env.MODO_AUTO_F4_MAX_LINES, 0),
  };
}

/**
 * @param {{ dir:string, read?:Function, write?:Function, exists?:Function, ensureDir?:Function,
 *           env?:object, log?:(m:string)=>void }} opts
 */
export function createRolloutFlags({ dir, read = readFileSync, write = writeFileSync, exists = existsSync, ensureDir = mkdirSync, env = process.env, log = () => {} } = {}) {
  if (!dir) throw new Error("createRolloutFlags: dir ausente");
  const path = join(dir, "rollout-flags.json");

  function fromFile() {
    if (!exists(path)) return null;
    try { const j = JSON.parse(String(read(path, "utf8") || "{}")); return j && typeof j === "object" ? j : null; }
    catch (e) { log(`[rollout] flags corrompidas (usando ambiente/default, SINALIZADO): ${e?.message || e}`); return null; }
  }

  return {
    path,
    // Estado efetivo: arquivo (dono) > env (CI) > default. Sempre devolve o shape COMPLETO.
    get() {
      const envF = flagsFromEnv(env), fileF = fromFile();
      return { ...FLAG_DEFAULTS, ...envF, ...(fileF || {}), source: fileF ? "file" : (envF.f1 || envF.f4 || envF.f2BudgetMs > 0 ? "env" : "default") };
    },
    // Liga/desliga por AÇÃO EXPLÍCITA (tool/painel). Merge com o atual; valida os números. FAIL LOUD na escrita.
    set(patch = {}) {
      const cur = this.get();
      const next = { ...FLAG_DEFAULTS };
      for (const k of Object.keys(FLAG_DEFAULTS)) next[k] = cur[k];
      if ("f1" in patch) next.f1 = !!patch.f1;
      if ("f4" in patch) next.f4 = !!patch.f4;
      if ("bypassPct" in patch) {
        const n = Number(patch.bypassPct);
        if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: `bypassPct inválido (${patch.bypassPct}) — use 0..100` };
        next.bypassPct = n;
      }
      if ("f2BudgetMs" in patch) {
        const n = Number(patch.f2BudgetMs);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: `f2BudgetMs inválido (${patch.f2BudgetMs}) — use 0 (off) ou ms > 0` };
        next.f2BudgetMs = n;
      }
      if ("f4MaxLines" in patch) {
        const n = Number(patch.f4MaxLines);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: `f4MaxLines inválido (${patch.f4MaxLines}) — use 0 (P25 medido) ou linhas > 0` };
        next.f4MaxLines = n;
      }
      // GUARDA DO PROCEDIMENTO (prescrito pela mesa): F1 e F2 juntas invalidam o go/no-go — sem isolar, não dá pra
      // saber qual reverter. Bloqueia com mensagem, em vez de deixar o dono se enganar depois.
      if (next.f1 && next.f2BudgetMs > 0) return { ok: false, error: "F1 e F2 ligadas JUNTAS invalidam o go/no-go (não dá pra saber qual reverter). Ligue uma, valide pelo modo_rollout, depois a outra." };
      try { ensureDir(dir, { recursive: true }); } catch { /* já existe */ }
      try { write(path, JSON.stringify(next, null, 2)); return { ok: true, flags: { ...next, source: "file" } }; }
      catch (e) { log(`[rollout] falha ao gravar as flags: ${e?.message || e}`); return { ok: false, error: e?.message || String(e) }; }
    },
  };
}
