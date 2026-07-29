// rolloutGate.mjs — ROLLOUT OPERACIONAL das fases de melhoria (F1/F2/F4). Puro/determinístico (Princípio 11):
// aritmética + decisão, sem I/O e sem LLM. Fecha o gap "mecanismo existe mas ligar é no escuro":
//
//  • abDecision()      → A/B do F1: sorteia bypass (grupo de CONTROLE) pra o go/no-go ter comparação real.
//  • abReport()        → compara filtrado × controle nos spans e devolve VEREDITO go/no-go medido (não achismo).
//  • percentile()      → estatística base (sem dep).
//  • f4Threshold()     → P25 de inputLines dos spans v3 (o gate do F4 sai de DADO, nunca hardcoded).
//  • shouldUseShallow()→ gate do F4: diff pequeno e nenhum arquivo crítico → revisor shallow. Fallback SEGURO:
//                        sem dados/threshold → false (comportamento atual, sem gate).
//
// Critério go/no-go (prescrito pela própria mesa ao responder o ask_user, 2026-07-28): p95 do grupo FILTRADO cai
// >= 20% vs CONTROLE **E** a taxa de reprovação (proxy de qualidade) não sobe acima de baseline+margem.

// Padrões do que é CRÍTICO (nunca vai pro revisor raso). Declarado antes de quem usa (sem TDZ em default param).
export const CRITICAL_PATTERNS = [/auth/i, /secur|seguran/i, /crypt|cripto/i, /senha|password|token|secret|credential/i, /payment|pagamento|billing/i, /admin|permiss/i];

export const ROLLOUT_DEFAULTS = Object.freeze({
  bypassPct: 20,       // % de ciclos que rodam SEM o filtro (controle). 20% ⇒ ≥20 controles em 100 ciclos.
  minPerArm: 20,       // mínimo por braço pra o veredito não ser ruído
  p95GainPct: 20,      // ganho exigido no p95 do braço filtrado
  qualityMarginPct: 10, // quanto a taxa de reprovação pode subir sobre o controle antes de reprovar
  f4Percentile: 25,    // P25 de inputLines = "diffs pequenos" roteados p/ shallow
});

// Sorteio do braço. `rand` injetável → teste determinístico. Retorna "bypass" (controle) ou "filtered".
export function abDecision({ bypassPct = ROLLOUT_DEFAULTS.bypassPct, rand = Math.random } = {}) {
  const p = Math.min(100, Math.max(0, Number(bypassPct) || 0));
  return rand() * 100 < p ? "bypass" : "filtered";
}

// Percentil (interpolação linear). [] → null (honesto: sem dado não há percentil).
export function percentile(values, p) {
  const xs = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

// Threshold do F4 a partir dos spans v3 (P25 de inputLines). Sem amostra suficiente → null (gate DESLIGADO).
// `override` (env MODO_AUTO_F4_MAX_LINES) permite usar o gate ANTES dos 500 spans — decisão EXPLÍCITA do dono,
// não default silencioso: sem override e sem amostra, o gate segue inerte (cold-start seguro por construção).
export function f4Threshold(spans, { p = ROLLOUT_DEFAULTS.f4Percentile, minSample = 500, override = null } = {}) {
  const ov = Number(override);
  if (Number.isFinite(ov) && ov > 0) return ov; // override explícito vence (destrava o cold-start)
  const xs = (Array.isArray(spans) ? spans : [])
    .filter((s) => s && Number(s.spanVersion) >= 3 && typeof s.inputLines === "number")
    .map((s) => s.inputLines);
  if (xs.length < minSample) return null; // FALLBACK SEGURO: dado insuficiente → sem gate (comportamento atual)
  return percentile(xs, p);
}

// VEREDITO operacional do F2 (budget global do ciclo). NÃO é A/B (é um CAP): o critério é a taxa de ciclos que
// BATEM no teto. Alta demais → o teto está apertado (cortando trabalho legítimo) → subir/reverter. Zero, com p95
// bem abaixo do teto → o cap não está atuando (pode apertar). Entre os dois → saudável.
export function f2Report(spans, { budgetMs = null, minSample = ROLLOUT_DEFAULTS.minPerArm, maxExhaustedPct = 20 } = {}) {
  const rows = (Array.isArray(spans) ? spans : []).filter((s) => s && s.verdict && typeof s.verdict.elapsedCycleMs === "number");
  if (rows.length < minSample) return { ok: false, reason: `amostra insuficiente (${rows.length} ciclos com elapsedCycleMs; mínimo ${minSample})`, cycles: rows.length };
  const blown = rows.filter((s) => s.verdict.budgetExhausted === true).length;
  const pct = (blown / rows.length) * 100;
  const p95 = percentile(rows.map((s) => s.verdict.elapsedCycleMs), 95);
  const b = Number(budgetMs);
  const active = Number.isFinite(b) && b > 0;
  let go, verdict;
  if (!active) { go = false; verdict = `F2 DESLIGADA — p95 do ciclo ${Math.round(p95)}ms em ${rows.length} ciclos. Sugestão de teto inicial: ${Math.round(p95 * 1.2)}ms (p95 + 20% de folga)`; }
  else if (pct > maxExhaustedPct) { go = false; verdict = `NO-GO: ${pct.toFixed(1)}% dos ciclos batem no teto (> ${maxExhaustedPct}%) — o budget ${b}ms está APERTADO e corta trabalho legítimo → suba p/ ~${Math.round(p95 * 1.2)}ms ou desligue`; }
  else if (blown === 0 && p95 < b * 0.5) { go = true; verdict = `GO (folgado): nenhum ciclo bateu no teto e o p95 (${Math.round(p95)}ms) está bem abaixo de ${b}ms — o cap protege sem atrapalhar; pode apertar p/ ~${Math.round(p95 * 1.2)}ms se quiser mais aperto`; }
  else { go = true; verdict = `GO: ${pct.toFixed(1)}% dos ciclos cortados (<= ${maxExhaustedPct}%), p95 ${Math.round(p95)}ms vs teto ${b}ms — budget saudável, mantenha`; }
  return { ok: true, go, cycles: rows.length, blown, blownPct: Math.round(pct * 10) / 10, p95: Math.round(p95), budgetMs: active ? b : null, verdict };
}

// GATE do F4: revisão rasa (barata) só quando o diff é pequeno E nada crítico foi tocado.
// threshold=null (sem dados) → SEMPRE false: nunca degrada a revisão às cegas.
// DUAS defesas contra falso-negativo do guard-rail: (1) `touchedPaths` = caminhos REAIS extraídos do artefato
// (use extractPaths); (2) `scanText` = o texto bruto (fase/impl) varrido pelos MESMOS padrões críticos — assim,
// mesmo que a extração de caminhos falhe, um material que FALA de auth/senha/pagamento não cai no revisor raso.
export function shouldUseShallow({ inputLines, threshold, touchedPaths = [], scanText = "", criticalPatterns = CRITICAL_PATTERNS } = {}) {
  if (threshold == null || !Number.isFinite(Number(inputLines))) return false;
  if (Number(inputLines) >= Number(threshold)) return false;
  const paths = Array.isArray(touchedPaths) ? touchedPaths.map(String) : [];
  if (paths.some((p) => criticalPatterns.some((re) => re.test(p)))) return false; // arquivo crítico → revisão cheia
  if (scanText && criticalPatterns.some((re) => re.test(String(scanText)))) return false; // menciona assunto crítico → revisão cheia
  return true;
}

// Extrai CAMINHOS DE ARQUIVO reais de um texto (fase/impl/diff) — o gate precisa de PATHS, não de prosa.
// Casa tokens com separador e extensão (src/a/b.mjs, ./x.ts, pkg\y.py). Sem match → [] (o caller usa scanText).
export function extractPaths(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/(?:^|[\s"'`([{,:])((?:\.{0,2}[/\\])?(?:[\w.@-]+[/\\])+[\w.-]+\.[a-zA-Z0-9]{1,6})/g)) out.add(m[1]);
  return [...out];
}

// ALERTA AUTOMÁTICO do rollout (fecha o gap "o go/no-go depende de LEMBRAR de rodar a tool"): dado o estado das
// flags + os spans, devolve a MENSAGEM ACIONÁVEL quando há decisão a tomar — pra ser injetada no SessionStart.
// Assinatura estável (sig) → o caller aplica COOLDOWN (não repete o mesmo alerta toda sessão). null = nada a dizer.
export function rolloutAlert(spans, { f1On = false, f2Ms = null, f4On = false, minCycles = ROLLOUT_DEFAULTS.minPerArm } = {}) {
  const parts = [];
  const keys = [];
  if (f1On) {
    const ab = abReport(spans);
    if (ab.ok) { parts.push(`F1 (pré-filtro): ${ab.go ? "✅ GO" : "⛔ NO-GO"} — ${ab.verdict}`); keys.push(`f1:${ab.go ? "go" : "nogo"}`); }
  }
  if (Number.isFinite(Number(f2Ms)) && Number(f2Ms) > 0) {
    const f2 = f2Report(spans, { budgetMs: Number(f2Ms) });
    if (f2.ok) { parts.push(`F2 (budget do ciclo): ${f2.go ? "✅ GO" : "⛔ NO-GO"} — ${f2.verdict}`); keys.push(`f2:${f2.go ? "go" : "nogo"}`); }
  }
  // Nada ligado, mas já há ciclos suficientes → é hora de COMEÇAR o A/B (senão o rollout dorme pra sempre).
  if (!f1On && !f4On && !(Number(f2Ms) > 0)) {
    const cycles = (Array.isArray(spans) ? spans : []).filter((s) => s && s.verdict && typeof s.verdict.elapsedCycleMs === "number").length;
    if (cycles >= minCycles) { parts.push(`Rollout PARADO com ${cycles} ciclos medidos: ligue SÓ o F1 (MODO_AUTO_F1_PREFILTER=1, bypass 20%) e rode \`modo_rollout\` após ~100 ciclos.`); keys.push("start"); }
  }
  if (!parts.length) return { emit: null, sig: null };
  return { emit: `🚦 ROLLOUT das melhorias da mesa:\n- ${parts.join("\n- ")}`, sig: keys.sort().join("+") };
}
// Devolve { ok:false, reason } enquanto a amostra não fecha — nunca decide no escuro.
export function abReport(spans, opts = {}) {
  const { minPerArm, p95GainPct, qualityMarginPct } = { ...ROLLOUT_DEFAULTS, ...opts };
  const rows = (Array.isArray(spans) ? spans : []).filter((s) => s && s.verdict && (s.verdict.f1Arm === "filtered" || s.verdict.f1Arm === "bypass"));
  const arm = (name) => rows.filter((s) => s.verdict.f1Arm === name);
  const filtered = arm("filtered"), control = arm("bypass");
  if (filtered.length < minPerArm || control.length < minPerArm) {
    return { ok: false, reason: `amostra insuficiente (filtrado ${filtered.length}, controle ${control.length}; mínimo ${minPerArm} por braço)`, filtered: filtered.length, control: control.length };
  }
  const ms = (list) => list.map((s) => Number(s.verdict.elapsedCycleMs)).filter(Number.isFinite);
  const failPct = (list) => (list.filter((s) => s.verdict.pass === false).length / list.length) * 100;
  const p95f = percentile(ms(filtered), 95), p95c = percentile(ms(control), 95);
  if (p95f == null || p95c == null || p95c <= 0) return { ok: false, reason: "sem elapsedCycleMs suficiente nos spans (instrumentação incompleta)" };
  const gainPct = ((p95c - p95f) / p95c) * 100;
  const failF = failPct(filtered), failC = failPct(control);
  const qualityOk = failF <= failC + qualityMarginPct;
  const go = gainPct >= p95GainPct && qualityOk;
  return {
    ok: true, go,
    gainPct: Math.round(gainPct * 10) / 10, p95Filtered: Math.round(p95f), p95Control: Math.round(p95c),
    failPctFiltered: Math.round(failF * 10) / 10, failPctControl: Math.round(failC * 10) / 10, qualityOk,
    filtered: filtered.length, control: control.length,
    verdict: go
      ? `GO: p95 caiu ${Math.round(gainPct)}% (>= ${p95GainPct}%) sem perder qualidade → reduza o bypass p/ 5% e siga monitorando`
      : `NO-GO: ${gainPct < p95GainPct ? `ganho ${Math.round(gainPct)}% < ${p95GainPct}%` : ""}${!qualityOk ? `${gainPct < p95GainPct ? " e " : ""}reprovação subiu (${Math.round(failF)}% vs ${Math.round(failC)}% do controle)` : ""} → desligue a flag F1`,
  };
}
