// adr-recall-floor-smoke.mjs — REGRESSÃO do bug em que a MEMÓRIA SEQUESTRAVA O ASSUNTO DO PLANO (v0.2.94).
//
// O bug não dava erro: o modo_adr devolvia um plano BEM FORMADO sobre outro assunto. Um briefing de uma linha
// ("descrever em uma frase o que o modo-auto faz") virou um ADR sobre locks, owner.json e respond_idle_session,
// porque o recall entrava num bloco colado à deliberação — que carrega "CONSOLIDE isto, não invente nem fuja".
// A mesa ainda SALVA cada plano na memória, então ela se envenena: plano de uma deliberação vira "já existe" da
// seguinte. Este teste trava as duas defesas: PISO DE RELEVÂNCIA e ENQUADRAMENTO do bloco.
//
// Determinístico: memória e factory são FAKES; nenhum modelo é chamado. O que se verifica é o PROMPT construído.

import assert from "node:assert";
import { createModoAdr } from "../src/adapters/profiles/modoAdr.mjs";

let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const BRIEFING = "Teste de fumaça: descrever em uma frase o que o modo-auto faz.";
// O ruído REAL que vazou em produção — se qualquer um destes reaparecer no plano, a regressão voltou.
// SCORES MEDIDOS, NÃO INVENTADOS: rodando a busca real com este mesmo briefing curto, conteúdo FORA DO ASSUNTO
// pontuou 0.65–0.71. A primeira versão deste teste usava 0.31/0.28/0.22 — números fabricados que faziam o piso
// de 0.55 parecer suficiente. Com os valores reais o teste passa a medir a defesa que REALMENTE segura o caso
// (o corte no write + o reenquadramento), em vez de dar um verde confortável para um piso que não barraria nada.
const RUIDO = [
  { text: "owner.json ausente quando o perdedor do lock tenta ler: o vencedor adquire o lock e só então escreve owner.json; há uma janela.", score: 0.71 },
  { text: "Entrega: método respond_idle_session(sid, turn_index) no operative com as 4 travas implementadas.", score: 0.68 },
  { text: "Excerpt não-literal dá verniz de credibilidade a alucinação: schema rejeita resumo LLM no campo excerpt.", score: 0.65 },
];
// Abaixo do piso: aqui o piso É a defesa, e continua valendo para o ruído claramente fraco.
const RUIDO_FRACO = [{ text: "nota solta de outro projeto, sem relação nenhuma com o briefing", score: 0.28 }];
const RELEVANTE = { text: "modo-auto é um sistema de execução autônoma de tarefas com mesa de agentes.", score: 0.82 };

// Captura os prompts enviados sem chamar modelo nenhum.
function makeCaps(results) {
  const prompts = [];
  const factory = {
    run: async (role, prompt) => {
      prompts.push({ role, prompt });
      // devolve JSON de slots vazio: o objetivo é inspecionar a ENTRADA, não produzir plano
      return { ok: true, text: "{}" };
    },
  };
  return {
    caps: { factory, memory: { recall: async (q, opts) => ({ ok: true, results, __opts: opts }) } },
    prompts,
  };
}
const allPrompts = (p) => p.map((x) => x.prompt).join("\n---\n");

console.log("sem piso de cosine: a defesa é estrutural, não limiar");
await run("o recall NÃO passa mais minScore (piso removido — nunca disparava no ruído real 0.65-0.71)", async () => {
  let visto = null;
  const caps = { factory: { run: async () => ({ ok: true, text: "{}" }) }, memory: { recall: async (q, opts) => { visto = opts; return { ok: true, results: [] }; } } };
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(visto && visto.minScore == null, "piso de cosine não deve mais existir: " + JSON.stringify(visto));
});

await run("ruído com score REAL (0.65-0.71) entra ROTULADO — o enquadramento é que segura", async () => {
  const { caps, prompts } = makeCaps([...RUIDO]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  const txt = allPrompts(prompts);
  if (txt.includes("owner.json")) {
    assert.ok(/CONTEXTO DE REÚSO/.test(txt), "se entra, TEM que vir sob o rótulo de contexto");
    assert.ok(/NÃO é o assunto desta mesa/.test(txt) && /IGNORE/.test(txt), "com ordem explícita de ignorar o que não casa");
    assert.ok(!/CONSOLIDE isto[\s\S]{0,400}owner\.json/.test(txt), "NUNCA dentro do bloco que manda consolidar");
  }
});

await run("resultado SEM score não é descartado (ausência de score ≠ irrelevante)", async () => {
  const { caps, prompts } = makeCaps([{ text: "memória legada sem score numérico" }]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(allPrompts(prompts).includes("memória legada sem score"), "sem score = indeterminado, não se joga fora");
});

console.log("enquadramento: memória é contexto, não pauta");
await run("o bloco de memória NÃO se chama mais 'JÁ EXISTE (reúse)' colado na deliberação", async () => {
  const { caps, prompts } = makeCaps([RELEVANTE]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  const txt = allPrompts(prompts);
  assert.ok(!/JÁ EXISTE \(reúse\):/.test(txt), "o rótulo antigo mandava consolidar o recall junto da deliberação");
});

await run("o bloco declara que NÃO é o assunto e manda IGNORAR o que não casar", async () => {
  const { caps, prompts } = makeCaps([RELEVANTE]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  const txt = allPrompts(prompts);
  assert.ok(/NÃO é o assunto desta mesa/.test(txt), "precisa dizer explicitamente que memória não é a pauta");
  assert.ok(/IGNORE/.test(txt), "precisa mandar ignorar o que não casar com o briefing");
});

await run("o BRIEFING continua presente e é o assunto", async () => {
  const { caps, prompts } = makeCaps([RELEVANTE]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(allPrompts(prompts).includes("Teste de fumaça"), "o briefing tem que chegar ao documentador");
});

await run("memória vazia não inventa bloco de reúso", async () => {
  const { caps, prompts } = makeCaps([]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(!/CONTEXTO DE REÚSO/.test(allPrompts(prompts)), "sem memória relevante, nenhum bloco deve ser criado");
});

console.log("corte na FONTE: a mesa não pode envenenar o próprio corpus");
await run("NÃO grava o plano inteiro na memória (era isso que virava 'já existe' da próxima)", async () => {
  const saves = [];
  const caps = {
    factory: { run: async () => ({ ok: true, text: "{}" }) },
    memory: { recall: async () => ({ ok: true, results: [] }), save: async (c, m) => { saves.push({ c, m }); return { ok: true, id: "x" }; } },
    plan: { writeAdrPlan: () => true },
  };
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  for (const s of saves) {
    assert.ok(s.c.length < 1200, `o que vai pra memória tem que ser REGISTRO compacto, não o plano (veio ${s.c.length} chars)`);
    assert.ok(s.m?.type !== "plan", "não pode mais ser gravado como type:'plan' (conhecimento de reúso)");
  }
});

await run("o registro gravado carrega o marcador e aponta pro arquivo", async () => {
  const saves = [];
  const caps = {
    factory: { run: async () => ({ ok: true, text: JSON.stringify({ decisao: "Decidido X." }) }) },
    memory: { recall: async () => ({ ok: true, results: [] }), save: async (c, m) => { saves.push({ c, m }); return { ok: true, id: "x" }; } },
    plan: { writeAdrPlan: () => true },
  };
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  if (saves.length) {
    assert.ok(saves[0].c.includes("[ADR-REGISTRO]"), "o registro precisa do marcador");
    assert.ok(/adr-plan\.md/.test(saves[0].c), "o registro precisa apontar onde está o plano completo");
  }
});

await run("registro de ADR não volta como 'já existe' — volta como DECISÃO ANTERIOR (sem amnésia)", async () => {
  const { caps, prompts } = makeCaps([{ text: "[ADR-REGISTRO] assunto: outra coisa\nDECISÃO: fazer travas de idempotência em respond_idle_session.", score: 0.95 }]);
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  const txt = allPrompts(prompts);
  // O escopo principal (CONTEXTO DE REÚSO) NÃO pode conter a saída da própria mesa...
  const reuse = (txt.split("CONTEXTO DE REÚSO")[1] || "").split("DECISÕES ANTERIORES")[0];
  assert.ok(!reuse.includes("[ADR-REGISTRO]"), "a saída da mesa não pode entrar como 'o que já existe'");
  // ...mas se aparecer, tem que ser sob o rótulo de decisão anterior, com a ordem de não consolidar.
  if (txt.includes("[ADR-REGISTRO]")) {
    assert.ok(/DECISÕES ANTERIORES DESTA MESA/.test(txt), "ADR anterior só entra rotulado como decisão anterior");
    assert.ok(/NÃO deve ser consolidado/.test(txt), "e com a ordem explícita de não consolidar");
  }
});

await run("o arquivo de ADRs é CONSULTÁVEL (não virou write-only — troca de veneno por amnésia)", async () => {
  const chamadas = [];
  const caps = {
    factory: { run: async () => ({ ok: true, text: "{}" }) },
    memory: { recall: async (q, opts) => { chamadas.push(opts || {}); return { ok: true, results: [] }; } },
  };
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(chamadas.some((o) => o.namespace === "adr"), "tem que haver consulta ao escopo #adr: " + JSON.stringify(chamadas));
  assert.ok(chamadas.some((o) => !o.namespace), "e outra ao escopo do projeto");
});

await run("o registro vai para um NAMESPACE separado (garantia estrutural, não marcador de texto)", async () => {
  const saves = [];
  const caps = {
    factory: { run: async () => ({ ok: true, text: "{}" }) },
    memory: { recall: async () => ({ ok: true, results: [] }), save: async (c, m) => { saves.push({ c, m }); return { ok: true, id: "x" }; } },
    plan: { writeAdrPlan: () => true },
  };
  await createModoAdr({ log: () => {} }).buildPlan(BRIEFING, caps, { mesa: "express" }).catch(() => {});
  assert.ok(saves.length > 0, "a mesa precisa ter gravado algo");
  for (const s of saves) {
    assert.strictEqual(s.m?.namespace, "adr", "toda saída da mesa vai para o namespace 'adr', fora do escopo que ela consulta");
  }
});

console.log(`\nadr-recall-floor-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
