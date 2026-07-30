// Poda do configDir dos WORKERS (~/.modo-auto/worker-config). Cada run de worker cria uma sessão no CLI
// e nada as removia: medido 6135 pastas em session-state/ e session-store.db de ~16 MB (+ WAL de 4 MB)
// acumulados em semanas. Sessão de worker é FIRE-AND-DIE — nenhuma é retomada entre runs — então tudo
// que passou da idade de retenção é lixo puro, e lixo acumulado mascara estado.
//
// FAIL LOUD: o que não deu para apagar entra em `errors` e aparece no relatório; a poda NUNCA derruba a
// mesa (é higiene, não caminho crítico), mas também nunca finge que apagou o que não apagou.
// SEGURANÇA: só mexe em session-state/. O banco NÃO é apagado aqui — ele pode estar aberto por um worker
// de OUTRA sessão neste exato momento, e apagá-lo sob uso corromperia a sessão viva. O tamanho é MEDIDO e
// reportado para decisão consciente (modo_setup), em vez de uma exclusão arriscada e silenciosa.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_RETENTION_DAYS = 7;

export function workerConfigDir({ env = process.env, home = homedir() } = {}) {
  return env.MODO_AUTO_WORKER_CONFIGDIR || join(home, ".modo-auto", "worker-config");
}

/**
 * Remove as sessões de worker mais velhas que `retentionDays`.
 * @returns {{ ok:boolean, dir:string, scanned:number, removed:number, kept:number, dbBytes:number, errors:Array<{entry:string,error:string}>, skipped?:string }}
 */
export function pruneWorkerSessions({ retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now(), env, home } = {}) {
  const dir = workerConfigDir({ env, home });
  const out = { ok: true, dir, scanned: 0, removed: 0, kept: 0, dbBytes: 0, errors: [] };
  if (!existsSync(dir)) return { ...out, skipped: "configdir-inexistente" };

  for (const f of ["session-store.db", "session-store.db-wal", "session-store.db-shm"]) {
    try { if (existsSync(join(dir, f))) out.dbBytes += statSync(join(dir, f)).size; } catch { /* medição best-effort */ }
  }

  const stateDir = join(dir, "session-state");
  if (!existsSync(stateDir)) return { ...out, skipped: "sem-session-state" };
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  let entries;
  try { entries = readdirSync(stateDir, { withFileTypes: true }); }
  catch (e) { return { ...out, ok: false, errors: [{ entry: stateDir, error: String(e?.message || e) }] }; }

  for (const ent of entries) {
    out.scanned++;
    const p = join(stateDir, ent.name);
    let mtime;
    // A idade vem do mtime do PRÓPRIO artefato descartável (não é chave de decisão de versão em lugar
    // nenhum — é só TTL de lixo). Não conseguir medir = NÃO apagar.
    try { mtime = statSync(p).mtimeMs; } catch (e) { out.errors.push({ entry: ent.name, error: String(e?.message || e) }); continue; }
    if (mtime >= cutoff) { out.kept++; continue; }
    try { rmSync(p, { recursive: true, force: true }); out.removed++; }
    catch (e) { out.errors.push({ entry: ent.name, error: String(e?.message || e) }); }
  }
  if (out.errors.length) out.ok = false;
  return out;
}

/** Linha curta para diagnóstico (modo_setup). Nunca esconde erro. */
export function formatPrune(r) {
  if (r.skipped) return `poda de sessões de worker: nada a fazer (${r.skipped})`;
  const mb = (r.dbBytes / 1024 / 1024).toFixed(1);
  const base = `poda de sessões de worker: ${r.removed} removida(s), ${r.kept} mantida(s) · banco ${mb} MB`;
  return r.errors.length ? `${base} → ⚠️ ${r.errors.length} falha(s) ao remover` : base;
}
