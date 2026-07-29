// diffContext.mjs — F1 do plano de melhoria da mesa: PRÉ-FILTRO do input do revisor. Em vez de reenviar a IMPL
// INTEIRA a cada rodada de remediação, manda só o que MUDOU + N linhas de contexto. Menos tokens de entrada =
// menos latência (o gargalo medido pela telemetria).
//
// CONTRATO EXPLÍCITO (risco E3 do painel deep endereçado): esta função NÃO adivinha diff dentro de um blob de
// texto composto (test+impl+gates+qa). Ela recebe `before`/`after` — dois estados do MESMO artefato — e devolve
// os hunks. Quem chama é responsável por passar o par certo. Sem par válido → PASS-THROUGH SINALIZADO.
//
// FAIL LOUD: nunca trunca calado. Todo caminho devolve { ok, text, mode, reason } e `mode` diz o que foi feito:
//   "diff"        → filtrado (hunks + contexto)
//   "passthrough" → devolveu o `after` inteiro, com `reason` explicando por quê (sem par, grande demais, etc.)
// Puro/determinístico (sem I/O, sem LLM) — Princípio 11.

const DEFAULTS = Object.freeze({ contextLines: 20, maxLines: 4000, minGainRatio: 0.85 });

const splitLines = (s) => String(s ?? "").split(/\r?\n/);

// LCS por programação dinâmica (linha a linha). Só é chamada dentro do teto maxLines (custo O(n*m) controlado).
function lcsMatrix(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

// Índices das linhas de `after` que MUDARAM (adicionadas/alteradas) em relação a `before`.
export function changedLines(before, after) {
  const a = splitLines(before), b = splitLines(after);
  const dp = lcsMatrix(a, b);
  const changed = new Set();
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) i++;        // linha some (removida) — marca a vizinhança no `after`
    else { changed.add(j); j++; }                  // linha nova/alterada
  }
  for (; j < b.length; j++) changed.add(j);        // cauda adicionada
  if (i < a.length && b.length) changed.add(Math.max(0, b.length - 1)); // remoção no fim → marca a última linha
  return changed;
}

/**
 * Extrai o CONTEXTO DE DIFF entre dois estados do mesmo artefato.
 * @param {{ before?:string, after?:string, contextLines?:number, maxLines?:number, minGainRatio?:number }} opts
 * @returns {{ ok:boolean, text:string, mode:"diff"|"passthrough", reason:string|null,
 *             beforeLines:number, afterLines:number, outLines:number }}
 */
export function extractDiffContext({ before, after, contextLines, maxLines, minGainRatio } = {}) {
  const cfg = { ...DEFAULTS, ...(contextLines != null ? { contextLines } : {}), ...(maxLines != null ? { maxLines } : {}), ...(minGainRatio != null ? { minGainRatio } : {}) };
  const aTxt = before == null ? null : String(before);
  const bTxt = String(after ?? "");
  const b = splitLines(bTxt);
  const out = (mode, text, reason = null) => ({ ok: true, mode, text, reason, beforeLines: aTxt == null ? 0 : splitLines(aTxt).length, afterLines: b.length, outLines: splitLines(text).length });

  // Sem par válido → PASS-THROUGH SINALIZADO (o caller vê o motivo; nada de truncar às cegas).
  if (aTxt == null || !aTxt.trim()) return out("passthrough", bTxt, "sem estado anterior (1ª revisão) — nada a diferenciar");
  if (!bTxt.trim()) return out("passthrough", bTxt, "estado atual vazio");
  const a = splitLines(aTxt);
  if (a.length > cfg.maxLines || b.length > cfg.maxLines) return out("passthrough", bTxt, `artefato grande demais p/ diff (${a.length}/${b.length} > ${cfg.maxLines} linhas) — enviado inteiro (sinalizado)`);
  if (aTxt === bTxt) return out("passthrough", bTxt, "sem mudança entre as rodadas — enviado inteiro (sinalizado)");

  const changed = changedLines(aTxt, bTxt);
  if (!changed.size) return out("passthrough", bTxt, "diff vazio (só remoções não localizáveis) — enviado inteiro");

  // Janelas = linhas mudadas ± contextLines, fundidas quando se tocam.
  const keep = new Set();
  for (const idx of changed) {
    for (let k = Math.max(0, idx - cfg.contextLines); k <= Math.min(b.length - 1, idx + cfg.contextLines); k++) keep.add(k);
  }
  const idxs = [...keep].sort((x, y) => x - y);
  const parts = [];
  let start = idxs[0], prev = idxs[0];
  const flush = (s, e) => parts.push(`@@ linhas ${s + 1}-${e + 1} @@\n` + b.slice(s, e + 1).map((l, n) => `${changed.has(s + n) ? ">" : " "} ${l}`).join("\n"));
  for (let t = 1; t < idxs.length; t++) {
    if (idxs[t] !== prev + 1) { flush(start, prev); start = idxs[t]; }
    prev = idxs[t];
  }
  flush(start, prev);
  const text = `(PRÉ-FILTRO: só os trechos ALTERADOS desde a rodada anterior, com ${cfg.contextLines} linhas de contexto; ">" marca a linha mudada. ${changed.size} linha(s) alterada(s) de ${b.length}.)\n\n` + parts.join("\n\n");

  // GANHO REAL? Se o filtrado não é sensivelmente menor, manda o inteiro (evita perder contexto por nada).
  if (splitLines(text).length >= b.length * cfg.minGainRatio) return out("passthrough", bTxt, `ganho insuficiente (filtrado ~${splitLines(text).length} vs ${b.length} linhas) — enviado inteiro`);
  return out("diff", text);
}
