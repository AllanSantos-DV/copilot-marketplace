// Laço de REMEDIAÇÃO — REVISÃO → CORREÇÃO → RE-REVISÃO até ZERAR os achados. Genérico (recebe review() e
// fix()), BOUNDED (maxRounds) e FAIL LOUD: NUNCA finge convergência. Se esgotar as rodadas sem zerar,
// devolve pass:false + exhausted:true (o caller ESCALA/SURFAÇA); se o revisor pedir escalação (decisão que
// o time não resolve), sai na hora com escalate. É a diferença entre "revisou uma vez" e "revisou até passar".
//
//   review(round) → { pass:boolean, findings:string[], escalate?:string }  (FAIL LOUD se não retornar {pass})
//   fix(findings, round) → aplica a correção (o material vive no closure do caller; aqui só orquestra)

export async function reviewUntilClean({ review, fix, maxRounds = 3, log = () => {} } = {}) {
  if (typeof review !== "function") throw new Error("reviewUntilClean: review() ausente");
  if (typeof fix !== "function") throw new Error("reviewUntilClean: fix() ausente");
  if (!(Number.isInteger(maxRounds) && maxRounds >= 1)) throw new Error("reviewUntilClean: maxRounds deve ser inteiro >= 1");

  const history = [];
  let round = 0;
  let v = await review(round);
  if (!v || typeof v.pass !== "boolean") throw new Error("reviewUntilClean: review() nao retornou {pass} (rodada 0)");
  history.push({ round, pass: v.pass, findings: v.findings || [] });

  while (!v.pass) {
    // decisão que trava o time → escala imediatamente (não adianta re-corrigir).
    if (v.escalate) {
      log(`[remediation] escala na rodada ${round}: ${v.escalate}`);
      return { pass: false, rounds: round + 1, exhausted: false, escalate: v.escalate, findings: v.findings || [], history };
    }
    // sem rodadas restantes → NÃO finge passar: devolve pass:false + exhausted (surfaced).
    if (round + 1 >= maxRounds) {
      const findings = v.findings || [];
      log(`[remediation] esgotou ${maxRounds} rodadas sem zerar (${findings.length} achados restantes)`);
      return { pass: false, rounds: round + 1, exhausted: true, findings, escalate: v.escalate || null, history };
    }
    round++;
    log(`[remediation] rodada ${round}: corrigindo ${(v.findings || []).length} achado(s)`);
    await fix(v.findings || [], round);
    v = await review(round);
    if (!v || typeof v.pass !== "boolean") throw new Error(`reviewUntilClean: review() nao retornou {pass} (rodada ${round})`);
    history.push({ round, pass: v.pass, findings: v.findings || [] });
  }
  log(`[remediation] ZEROU na rodada ${round} (${round + 1} revisão(ões))`);
  return { pass: true, rounds: round + 1, exhausted: false, escalate: null, findings: [], history };
}
