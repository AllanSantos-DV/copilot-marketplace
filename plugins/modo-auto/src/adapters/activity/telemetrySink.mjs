// TELEMETRY SINK (tel-1) — PERSISTÊNCIA determinística dos spans da mesa em JSONL (append-only), pro agente
// de auto-melhoria ter um HISTÓRICO QUERYÁVEL (sucesso+falha). Princípio 11: coleta = TOOL determinística.
// Enriquecimento, não caminho crítico: falha de escrita/leitura é DEGRADAÇÃO SINALIZADA (loga, devolve visível),
// nunca crash nem fake. I/O injetável (writer/reader) → puro e testável. 1 linha JSON por span.
// BOUNDED: rotaciona ao passar de maxBytes (arquivo ativo + 1 backup) — não cresce infinito; read({limit}) tail.

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{ dir:string, file?:string, maxBytes?:number, append?:Function, read?:Function, exists?:Function,
 *          ensureDir?:Function, sizeOf?:Function, rotate?:Function, log?:(m:string)=>void }} opts
 */
export function createTelemetrySink({
  dir, file = "traces.jsonl", maxBytes = 5_000_000,
  append = appendFileSync, read = readFileSync, exists = existsSync, ensureDir = mkdirSync,
  sizeOf = (p) => { try { return existsSync(p) ? statSync(p).size : 0; } catch { return 0; } },
  rotate = (from, to) => renameSync(from, to),
  log = () => {},
} = {}) {
  if (!dir) throw new Error("createTelemetrySink: dir ausente");
  const path = join(dir, file);
  const backup = path + ".1";
  let ensured = false, size = null; // size: bytes do arquivo ativo (lido 1x, depois mantido em memória)
  function ensure() { if (!ensured) { try { ensureDir(dir, { recursive: true }); } catch { /* dir já existe → ok */ } ensured = true; } }

  return {
    path, backup,

    // Persiste 1 span como linha JSON. BOUNDED: rotaciona antes de passar de maxBytes. Falha de escrita =
    // DEGRADAÇÃO SINALIZADA ({ok:false,error} + log), não crash.
    persist(span) {
      if (!span || typeof span !== "object") return { ok: false, error: "telemetria: span inválido" };
      // ASSERTION FAIL-LOUD (Fase 0): span v3+ DEVE trazer os 3 obrigatórios — sem eles NÃO persiste (nunca mascara um
      // span meia-boca que estragaria a análise). v2 (spanVersion ausente ou < 3) passa sem exigência (retrocompat).
      if (Number(span.spanVersion) >= 3) {
        for (const k of ["inputTokens", "outputTokens", "inputLines"]) {
          if (typeof span[k] !== "number") return { ok: false, error: `telemetria: span v3 sem campo obrigatório: ${k}` };
        }
      }
      try {
        ensure();
        if (size == null) size = sizeOf(path); // custo 1x: tamanho atual do arquivo ativo
        const line = JSON.stringify(span) + "\n";
        if (size > 0 && size + line.length > maxBytes) {
          // ROTAÇÃO: move o ativo p/ .1 (1 backup) e recomeça → total bounded ~2×maxBytes. Falha de rotação
          // NÃO derruba: segue anexando (sinalizado) — pior caso o arquivo passa um pouco do teto, sem crash.
          try { rotate(path, backup); size = 0; log(`[telemetria] rotacionado (> ${maxBytes}B) → ${backup}`); }
          catch (e) { log(`[telemetria] rotação falhou (segue anexando, sinalizado): ${e?.message || e}`); }
        }
        append(path, line);
        size += line.length;
        return { ok: true };
      } catch (e) {
        const error = e?.message || String(e);
        log(`[telemetria] persist falhou (degradado, sinalizado): ${error}`);
        return { ok: false, error };
      }
    },

    // Lê os spans do arquivo ATIVO (bounded por maxBytes). `limit` > 0 → só os últimos N (tail, leitura barata).
    // Arquivo ausente = [] (opcional/ausente). Linha parcial/corrompida é PULADA e SINALIZADA. Erro de I/O = [] + log.
    read({ limit = 0 } = {}) {
      try {
        if (!exists(path)) return [];
        const raw = String(read(path) || "");
        const out = []; let skipped = 0;
        for (const line of raw.split(/\r?\n/)) {
          const s = line.trim(); if (!s) continue;
          try { out.push(JSON.parse(s)); } catch { skipped++; }
        }
        if (skipped) log(`[telemetria] read: ${skipped} linha(s) parcial/corrompida pulada(s) (sinalizado)`);
        return limit > 0 ? out.slice(-limit) : out;
      } catch (e) {
        log(`[telemetria] read falhou (degradado, sinalizado): ${e?.message || e}`);
        return [];
      }
    },
  };
}
