// PROPOSAL STORE (auto-melhoria) — contrato DEDICADO das propostas (dedup + cursor), mas REUSA o telemetrySink
// por dentro pro plumbing JSONL (append/read) — honra o reúso-primeiro sem duplicar I/O, e mantém a separação
// de CONTRATO (proposta ≠ span) via módulo + ARQUIVO próprios (proposals.jsonl). `maxBytes:Infinity` → SEM
// rotação silenciosa (append-only ilimitado; ~1KB/proposta). Dedup = hash gap+kind+change normalizado; cursor
// = watermark por timestamp. Princípio 11: dedup/cursor determinísticos. FAIL LOUD: I/O → {ok:false,error}, log.

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTelemetrySink } from "./telemetrySink.mjs";

// Hash estável de uma proposta (dedup): gap + kind + change normalizado (colapsa espaço, minúsculo, 50 chars).
export function proposalHash(p) {
  const norm = `${p.gap || ""}|${p.kind || ""}|${String(p.change || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 50)}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/**
 * @param {{ dir:string, append?:Function, read?:Function, exists?:Function, ensureDir?:Function,
 *          writeFile?:Function, log?:(m:string)=>void }} opts
 */
export function createProposalStore({
  dir, append = appendFileSync, read = readFileSync, exists = existsSync,
  ensureDir = mkdirSync, writeFile = writeFileSync, log = () => {},
} = {}) {
  if (!dir) throw new Error("createProposalStore: dir ausente");
  const cursorPath = join(dir, "cursor.json");
  // REÚSO: o plumbing JSONL das propostas é um telemetrySink dedicado (arquivo próprio, SEM rotação).
  const sink = createTelemetrySink({ dir, file: "proposals.jsonl", maxBytes: Infinity, append, read, exists, ensureDir, log });
  let ensured = false;
  const ensure = () => { if (!ensured) { try { ensureDir(dir, { recursive: true }); } catch { /* já existe */ } ensured = true; } };

  function all() { return sink.read({}); }

  function readCursor() {
    try { return exists(cursorPath) ? { ts: 0, at: null, lastNudgedTs: 0, ...JSON.parse(read(cursorPath) || "{}") } : { ts: 0, at: null, lastNudgedTs: 0 }; }
    catch (e) { log(`[auto-melhoria] proposalStore.getCursor falhou (assume 0, sinalizado): ${e?.message || e}`); return { ts: 0, at: null, lastNudgedTs: 0 }; }
  }

  return {
    cursorPath,

    // DEDUP-append: só grava propostas cujo hash ainda não existe. REUSA sink.persist (fail-loud propagado:
    // se a persistência falhar, devolve {ok:false} e NÃO conta como adicionada). Retorna {added, duplicates}.
    add(proposals, { at = new Date().toISOString() } = {}) {
      const list = Array.isArray(proposals) ? proposals : [];
      if (!list.length) return { ok: true, added: 0, duplicates: 0 };
      const seen = new Set(all().map((p) => p.hash));
      let added = 0, duplicates = 0;
      for (const p of list) {
        const hash = proposalHash(p);
        if (seen.has(hash)) { duplicates++; continue; }
        seen.add(hash);
        const r = sink.persist({ ...p, hash, at });
        if (!r.ok) { log(`[auto-melhoria] proposalStore.add: persist falhou (sinalizado): ${r.error}`); return { ok: false, error: r.error, added, duplicates }; }
        added++;
      }
      log(`[auto-melhoria] proposalStore: +${added} nova(s), ${duplicates} duplicada(s) (dedup)`);
      return { ok: true, added, duplicates };
    },

    all,

    // CURSOR: TIMESTAMP (startedAt máx) da última análise COMPLETA — MONOTÔNICO (sobrevive à rotação da
    // telemetria, ao contrário de uma contagem de linhas) e identity-based (um run com `limit` não avança).
    // `lastNudgedTs` = quando o nudge foi mostrado por último (throttle). Ausente = tudo 0 (nunca rodou/nudou).
    getCursor: readCursor,
    // setCursor PRESERVA lastNudgedTs (merge) — só mexe no watermark de análise.
    setCursor({ ts, at = new Date().toISOString() } = {}) {
      try { ensure(); writeFile(cursorPath, JSON.stringify({ ...readCursor(), ts: Number(ts) || 0, at })); return { ok: true }; }
      catch (e) { log(`[auto-melhoria] proposalStore.setCursor falhou (sinalizado): ${e?.message || e}`); return { ok: false, error: e?.message || String(e) }; }
    },
    // markNudged PRESERVA o watermark (merge) — só registra o throttle do nudge.
    markNudged(now = Date.now()) {
      try { ensure(); writeFile(cursorPath, JSON.stringify({ ...readCursor(), lastNudgedTs: Number(now) || 0 })); return { ok: true }; }
      catch (e) { log(`[auto-melhoria] proposalStore.markNudged falhou (sinalizado): ${e?.message || e}`); return { ok: false, error: e?.message || String(e) }; }
    },
  };
}

// startAt máximo de uma lista de spans (base do watermark monotônico). 0 se vazio.
export function maxStartedAt(spans) {
  return (Array.isArray(spans) ? spans : []).reduce((m, s) => Math.max(m, Number(s?.startedAt || 0)), 0);
}

// NUDGE (pure): conta spans com startedAt > cursorTs (os NOVOS desde a última análise completa). Base em
// TIMESTAMP (não em contagem) → correto mesmo após a telemetria rotacionar. >= threshold → sugere rodar.
export function improvementNudge(spans, cursorTs, { threshold = 10 } = {}) {
  const ts = Number(cursorTs) || 0;
  const nova = (Array.isArray(spans) ? spans : []).filter((s) => Number(s?.startedAt || 0) > ts).length;
  if (nova < threshold) return null;
  return `modo-auto: ${nova} novos spans de telemetria desde a última análise — rode \`modo_melhoria\` para propostas de melhoria da mesa (não auto-aplica; gate seu).`;
}

// THROTTLE do nudge (backlog do plano): mesmo havendo spans novos, NÃO re-nudge dentro de `throttleMs` desde o
// último (evita cutucar toda sessão se o usuário ignorar). Pura/testável. O caller registra o disparo (markNudged).
export function nudgeThrottled(message, lastNudgedTs, { throttleMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  if (!message) return null;
  if ((Number(now) || 0) - (Number(lastNudgedTs) || 0) < throttleMs) return null;
  return message;
}
