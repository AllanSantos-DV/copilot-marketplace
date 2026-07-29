// Laço de REMEDIAÇÃO — REVISÃO → CORREÇÃO → RE-REVISÃO até ZERAR os achados. Genérico (recebe review() e
// fix()), BOUNDED (maxRounds) e FAIL LOUD: NUNCA finge convergência. Se esgotar as rodadas sem zerar,
// devolve pass:false + exhausted:true (o caller ESCALA/SURFAÇA); se o revisor pedir escalação (decisão que
// o time não resolve), sai na hora com escalate. É a diferença entre "revisou uma vez" e "revisou até passar".
//
//   review(round) → { pass:boolean, findings:string[], escalate?:string }  (FAIL LOUD se não retornar {pass})
//   fix(findings, round) → aplica a correção (o material vive no closure do caller; aqui só orquestra)
//
// F2 (budget GLOBAL do ciclo): `cycleBudgetMs` limita o LOOP INTEIRO, não uma chamada. Foi o risco E1 do painel
// deep: o multiplicador real da latência é o loop (N rodadas × timeout de cada revisão), então um cap por chamada
// NÃO resolve. Ao estourar, PARA com o melhor estado acumulado e SINALIZA (budgetExhausted) — nunca finge passar.
// Default Infinity = desligado (rollout gradual, E4a): quem liga passa o valor.

export async function reviewUntilClean({ review, fix, maxRounds = 3, cycleBudgetMs = Infinity, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof review !== "function") throw new Error("reviewUntilClean: review() ausente");
  if (typeof fix !== "function") throw new Error("reviewUntilClean: fix() ausente");
  if (!(Number.isInteger(maxRounds) && maxRounds >= 1)) throw new Error("reviewUntilClean: maxRounds deve ser inteiro >= 1");
  if (!(cycleBudgetMs === Infinity || (Number.isFinite(cycleBudgetMs) && cycleBudgetMs > 0))) throw new Error("reviewUntilClean: cycleBudgetMs deve ser > 0 (ou Infinity p/ desligado)");

  const cycleStart = now();
  const elapsed = () => now() - cycleStart;
  const history = [];
  let round = 0;
  let v = await review(round);
  if (!v || typeof v.pass !== "boolean") throw new Error("reviewUntilClean: review() nao retornou {pass} (rodada 0)");
  history.push({ round, pass: v.pass, findings: v.findings || [] });

  while (!v.pass) {
    // decisão que trava o time → escala imediatamente (não adianta re-corrigir).
    if (v.escalate) {
      log(`[remediation] escala na rodada ${round}: ${v.escalate}`);
      return { pass: false, rounds: round + 1, exhausted: false, escalate: v.escalate, findings: v.findings || [], history, elapsedCycleMs: elapsed() };
    }
    // sem rodadas restantes → NÃO finge passar: devolve pass:false + exhausted (surfaced).
    if (round + 1 >= maxRounds) {
      const findings = v.findings || [];
      log(`[remediation] esgotou ${maxRounds} rodadas sem zerar (${findings.length} achados restantes)`);
      return { pass: false, rounds: round + 1, exhausted: true, findings, escalate: v.escalate || null, history, elapsedCycleMs: elapsed() };
    }
    // BUDGET GLOBAL do ciclo estourado (F2/E1) → PARA antes de gastar mais uma rodada. NÃO finge passar:
    // devolve pass:false + budgetExhausted SINALIZADO com os achados que restaram.
    if (elapsed() >= cycleBudgetMs) {
      const findings = v.findings || [];
      log(`[remediation] BUDGET DO CICLO estourado (${elapsed()}ms >= ${cycleBudgetMs}ms) na rodada ${round} — para com ${findings.length} achado(s) restante(s)`);
      return { pass: false, rounds: round + 1, exhausted: false, budgetExhausted: true, findings, escalate: v.escalate || `budget do ciclo de revisão estourado (${elapsed()}ms) com ${findings.length} achado(s) por resolver`, history, elapsedCycleMs: elapsed() };
    }
    round++;
    log(`[remediation] rodada ${round}: corrigindo ${(v.findings || []).length} achado(s)`);
    await fix(v.findings || [], round);
    v = await review(round);
    if (!v || typeof v.pass !== "boolean") throw new Error(`reviewUntilClean: review() nao retornou {pass} (rodada ${round})`);
    history.push({ round, pass: v.pass, findings: v.findings || [] });
  }
  log(`[remediation] ZEROU na rodada ${round} (${round + 1} revisão(ões))`);
  return { pass: true, rounds: round + 1, exhausted: false, escalate: null, findings: [], history, elapsedCycleMs: elapsed() };
}
