// telemetry-context-smoke.mjs — cobertura causal dos spans. Medido: `taskType` em ~1,4% e `findingsCount` em 0%,
// o que INVALIDA qualquer A/B (não se compara variante do revisor sem saber o tipo da tarefa). A causa não era o
// registro — era depender de ~31 pontos de chamada, e os que MAIS produzem span (deepPanel ~1545, sombra ~539)
// simplesmente não passavam o campo.
//
// O ponto mais delicado é a CONCORRÊNCIA: o modo-sombra roda EM PARALELO com a mesa. Um contexto em variável de
// módulo seria uma corrida e carimbaria spans com o taskType da OUTRA deliberação — dado ERRADO passando por dado
// bom, que é pior que campo nulo. Por isso AsyncLocalStorage, e por isso o teste abaixo roda as duas ao mesmo tempo.

import assert from "node:assert";
import { withRunContext, getRunContext } from "../src/adapters/agents/agentFactory.mjs";

let pass = 0, total = 0;
const run = (m, fn) => { total++; try { fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const runA = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Reproduz a resolução do agentFactory: explícito do chamador VENCE o contexto; sem nenhum, null.
const resolve = (explicito) => explicito || getRunContext().taskType || null;

console.log("escopo do contexto");
run("fora de qualquer deliberação o contexto é vazio", () => assert.deepStrictEqual(getRunContext(), {}));
run("dentro da deliberação o contexto vale", () => {
  withRunContext({ taskType: "feature", stage: "dev" }, () => {
    assert.strictEqual(getRunContext().taskType, "feature");
    assert.strictEqual(getRunContext().stage, "dev");
  });
});
run("ao sair, NÃO vaza para fora", () => {
  withRunContext({ taskType: "feature" }, () => {});
  assert.deepStrictEqual(getRunContext(), {});
});
run("getRunContext devolve CÓPIA (mutar o retorno não contamina)", () => {
  withRunContext({ taskType: "api" }, () => {
    const c = getRunContext();
    c.taskType = "adulterado";
    assert.strictEqual(getRunContext().taskType, "api");
  });
});
run("aninhado: o interno vence e o externo VOLTA ao sair", () => {
  withRunContext({ taskType: "externo" }, () => {
    withRunContext({ taskType: "interno" }, () => assert.strictEqual(getRunContext().taskType, "interno"));
    assert.strictEqual(getRunContext().taskType, "externo");
  });
});

console.log("precedência (é isto que tira a cobertura de 1,4%)");
run("sem explícito, o worker HERDA o tipo da deliberação", () => {
  withRunContext({ taskType: "feature" }, () => assert.strictEqual(resolve(null), "feature"));
});
run("com explícito, o explícito vence", () => {
  withRunContext({ taskType: "feature" }, () => assert.strictEqual(resolve("critical"), "critical"));
});
run("sem nenhum dos dois vira null (NÃO inventa tipo)", () => assert.strictEqual(resolve(null), null));

console.log("CONCORRÊNCIA: mesa e sombra ao mesmo tempo não se contaminam");
await runA("duas deliberações paralelas mantêm CADA UMA o seu taskType", async () => {
  const vistos = { mesa: [], sombra: [] };
  const mesa = withRunContext({ taskType: "feature", stage: "dev" }, async () => {
    for (let i = 0; i < 5; i++) { vistos.mesa.push(getRunContext().taskType); await sleep(1); }
  });
  const sombra = withRunContext({ taskType: "contestacao", stage: "sombra" }, async () => {
    for (let i = 0; i < 5; i++) { vistos.sombra.push(getRunContext().taskType); await sleep(1); }
  });
  await Promise.all([mesa, sombra]);
  assert.deepStrictEqual(vistos.mesa, Array(5).fill("feature"), "a mesa não pode ver o tipo do sombra");
  assert.deepStrictEqual(vistos.sombra, Array(5).fill("contestacao"), "o sombra não pode ver o tipo da mesa");
});
await runA("o stage também não vaza entre as duas", async () => {
  let stMesa = null, stSombra = null;
  await Promise.all([
    withRunContext({ stage: "dev" }, async () => { await sleep(2); stMesa = getRunContext().stage; }),
    withRunContext({ stage: "sombra" }, async () => { await sleep(1); stSombra = getRunContext().stage; }),
  ]);
  assert.strictEqual(stMesa, "dev");
  assert.strictEqual(stSombra, "sombra");
});
await runA("worker disparado DEPOIS de um await ainda enxerga o contexto", async () => {
  await withRunContext({ taskType: "api" }, async () => {
    await sleep(3);
    assert.strictEqual(resolve(null), "api", "o contexto tem que sobreviver ao await (é o caso real do deepPanel)");
  });
});

console.log("veredito: findingsCount e a curva por rodada");
const verdict = (rem) => ({
  mustFixCount: (rem.findings || []).length,
  findingsCount: (rem.findings || []).length,
  findingsByRound: (rem.history || []).map((h) => (h.findings || []).length),
});
run("findingsCount deixa de ser 0% — vem do resultado real", () => assert.strictEqual(verdict({ findings: ["a", "b", "c"] }).findingsCount, 3));
run("zero achados é 0 MEDIDO, não campo ausente", () => {
  const v = verdict({ findings: [] });
  assert.strictEqual(v.findingsCount, 0);
  assert.ok("findingsCount" in v);
});
run("a curva por rodada mostra se a remediação CONVERGE ou patina", () => {
  assert.deepStrictEqual(verdict({ findings: [], history: [{ findings: ["a", "b", "c"] }, { findings: ["a"] }, { findings: [] }] }).findingsByRound, [3, 1, 0]);
  assert.deepStrictEqual(verdict({ findings: ["x", "y"], history: [{ findings: ["x", "y"] }, { findings: ["x", "y"] }] }).findingsByRound, [2, 2]);
});
run("histórico ausente não quebra", () => assert.deepStrictEqual(verdict({ findings: ["a"] }).findingsByRound, []));

console.log(`\ntelemetry-context-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
