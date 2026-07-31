// memory-cross-project-leak-smoke.mjs — ADVERSARIAL: dois projetos DIFERENTES, o MESMO daemon, e uma query que
// casa com os dois. Prova que A não enxerga B e B não enxerga A.
//
// POR QUE É O TESTE MAIS IMPORTANTE DESTA ÁREA: tudo o que eu construí até aqui AFIRMA isolamento — o escopo é
// cravado, o filtro é enviado, o namespace separa. Mas afirmar não é provar. O que fecha a questão é plantar
// documentos quase idênticos em dois escopos e mostrar que a busca de um NUNCA devolve o do outro. Sem isto, o
// "isolamento" pode ser só o ranqueador semântico não tendo trazido o documento do vizinho por sorte — e sorte
// não é fronteira.
//
// ISTO TAMBÉM MEDE O FILTRO DO SERVIDOR (a 2ª crítica): o código envia `metadata.project_id`, mas nada provava
// que o daemon FILTRA por igualdade em vez de só ranquear. Aqui os textos são deliberadamente MUITO parecidos:
// se o servidor apenas ranqueasse, o documento do outro projeto apareceria — ele é semanticamente ótimo para a
// query. Se não aparece, o filtro é de verdade.
//
// LIVE: precisa do daemon. Sem ele → SKIP sinalizado; FAIL sob MODO_AUTO_STRICT.

import assert from "node:assert";
import { createMemoryPort } from "../src/adapters/memory/memoryPort.mjs";
import { discover } from "../src/adapters/memory/daemon.mjs";
import { MemoryClient } from "../src/adapters/memory/client.mjs";

const STRICT = process.env.MODO_AUTO_STRICT === "1";
let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const skip = (m) => {
  total++;
  if (STRICT) { console.log("  FAIL - [STRICT] " + m + " :: MODO_AUTO_STRICT=1 exige o daemon NO AR — isolamento não se prova com skip"); return; }
  pass++; console.log("  skip - " + m);
};

const info = await discover();
if (!info) {
  skip("daemon de memória OFFLINE — o teste adversarial de isolamento não é exercitável aqui");
  console.log(`\nmemory-cross-project-leak-smoke: ${pass}/${total} OK`);
  process.exit(pass === total ? 0 : 1);
}

const RUN = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const PROJ_A = `selftest-iso-a/${RUN}`;
const PROJ_B = `selftest-iso-b/${RUN}`;
// Textos QUASE IDÊNTICOS de propósito: a única diferença é a marca. Se houvesse só ranqueamento semântico, o
// documento do vizinho seria um candidato excelente para a query do outro.
const MARCA_A = `ISO-A-${RUN}`;
const MARCA_B = `ISO-B-${RUN}`;
const TEXTO = (marca) => `${marca}: decisão de arquitetura sobre o pipeline de deploy e o fluxo de publicação de versões neste projeto.`;
const QUERY = "decisão de arquitetura sobre o pipeline de deploy e publicação de versões";

const raw = new MemoryClient(info.url);
const portA = createMemoryPort({ projectId: PROJ_A, log: () => {} });
const portB = createMemoryPort({ projectId: PROJ_B, log: () => {} });
const criados = [];

async function until(cond, { tentativas = 14, intervaloMs = 750 } = {}) {
  for (let i = 0; i < tentativas; i++) { if (await cond()) return true; await new Promise((r) => setTimeout(r, intervaloMs)); }
  return false;
}
const contem = (r, marca) => (r.results || []).some((x) => String(x.text || "").includes(marca));

try {
  for (const [proj, marca] of [[PROJ_A, MARCA_A], [PROJ_B, MARCA_B]]) {
    const s = await raw.save(TEXTO(marca), { project_id: proj, type: "decision" });
    const id = s?.id || s?.documentId; if (id) criados.push(id);
  }

  // ORDEM DELIBERADA (a mesma que me salvou do verde-vazio): primeiro provo que CADA UM enxerga o SEU. Se eu
  // fosse direto para "A não vê B", o teste passaria por indexação atrasada — nada visível, nenhum vazamento,
  // verde falso.
  await run("[presença] o projeto A enxerga o documento DELE", async () => {
    const ok = await until(async () => contem(await portA.recall(QUERY, { topK: 10 }), MARCA_A));
    assert.ok(ok, "o documento de A não ficou visível em A — sem isto o teste de vazamento é vazio");
  });
  await run("[presença] o projeto B enxerga o documento DELE", async () => {
    const ok = await until(async () => contem(await portB.recall(QUERY, { topK: 10 }), MARCA_B));
    assert.ok(ok, "o documento de B não ficou visível em B — sem isto o teste de vazamento é vazio");
  });

  // BILATERAL: só "A não vê B" seria insuficiente — passaria se o filtro fosse assimétrico ou se B nem tivesse
  // sido indexado. Cada direção tem que ser afirmada, com a presença já provada acima.
  await run("[vazamento A→B] a busca de A NÃO devolve o documento de B", async () => {
    const r = await portA.recall(QUERY, { topK: 20 });
    assert.strictEqual(r.ok, true, "recall de A falhou: " + JSON.stringify(r));
    assert.ok(!contem(r, MARCA_B), "VAZOU: A enxergou o documento de B — o escopo não é fronteira");
  });
  await run("[vazamento B→A] a busca de B NÃO devolve o documento de A", async () => {
    const r = await portB.recall(QUERY, { topK: 20 });
    assert.strictEqual(r.ok, true, "recall de B falhou: " + JSON.stringify(r));
    assert.ok(!contem(r, MARCA_A), "VAZOU: B enxergou o documento de A — o escopo não é fronteira");
  });

  // O FILTRO É DO SERVIDOR, não do cliente. Se o daemon só ranqueasse e devolvesse tudo, uma busca SEM filtro
  // acharia os dois — e é justamente isso que se mede aqui. Se a busca sem escopo acha ambos e a com escopo acha
  // um só, o corte aconteceu no servidor.
  await run("[servidor] sem filtro os DOIS aparecem; com filtro, só o do escopo (o corte é server-side)", async () => {
    const semFiltro = await raw.search(QUERY, { topK: 30 });
    const achouA = (semFiltro.results || []).some((x) => String(x.text || "").includes(MARCA_A));
    const achouB = (semFiltro.results || []).some((x) => String(x.text || "").includes(MARCA_B));
    assert.ok(achouA && achouB, `sem filtro o daemon tinha que devolver os dois (A=${achouA} B=${achouB}) — se não devolve, este teste não prova nada sobre o filtro`);
    const comFiltro = await raw.search(QUERY, { topK: 30, metadata: { project_id: PROJ_A } });
    const soA = (comFiltro.results || []).every((x) => !String(x.text || "").includes(MARCA_B));
    assert.ok(soA, "com filtro o daemon devolveu documento de OUTRO projeto — o filtro não é hard-filter de tenant");
  });

  // Escopo inexistente tem que devolver VAZIO, não "o mais parecido". É o outro lado da mesma moeda: se um
  // project_id que nunca existiu retorna resultados, o filtro é decorativo.
  await run("[servidor] escopo INEXISTENTE devolve vazio (não cai em 'o mais parecido')", async () => {
    const r = await raw.search(QUERY, { topK: 10, metadata: { project_id: `selftest-iso-nao-existe/${RUN}` } });
    assert.strictEqual((r.results || []).length, 0, "escopo inexistente devolveu resultado — o filtro está sendo ignorado: " + JSON.stringify((r.results || []).map((x) => x.text.slice(0, 60))));
  });
  // RELEVÂNCIA, não só "cospe um id". A prova anterior mostrava que o pipeline devolvia um doc_id — o que não
  // diz se veio o documento CERTO. Aqui há dois documentos plantados no MESMO escopo: um que responde a query e
  // outro que não. O acerto é o alvo vir à frente do distrator.
  await run("[relevância] a busca traz o documento CERTO na frente do distrator (não só 'um id qualquer')", async () => {
    const PROJ_R = `selftest-rel/${RUN}`;
    const ALVO = `REL-ALVO-${RUN}`, DISTRATOR = `REL-DIST-${RUN}`;
    const ids = [];
    try {
      const s1 = await raw.save(`${ALVO}: para reverter uma migração de banco de dados, rode o comando de rollback e restaure o snapshot anterior antes de reaplicar.`, { project_id: PROJ_R, type: "knowledge" });
      const s2 = await raw.save(`${DISTRATOR}: a paleta de cores da interface usa tons de azul e o espaçamento base é de oito pixels.`, { project_id: PROJ_R, type: "knowledge" });
      for (const s of [s1, s2]) { const id = s?.id || s?.documentId; if (id) ids.push(id); }
      const portR = createMemoryPort({ projectId: PROJ_R, log: () => {} });
      const q = "como reverter uma migração de banco de dados";
      const visivel = await until(async () => contem(await portR.recall(q, { topK: 10 }), ALVO));
      assert.ok(visivel, "o documento-alvo não ficou visível — sem isso a asserção de ordem seria vazia");
      const r = await portR.recall(q, { topK: 10 });
      const iAlvo = (r.results || []).findIndex((x) => String(x.text || "").includes(ALVO));
      const iDist = (r.results || []).findIndex((x) => String(x.text || "").includes(DISTRATOR));
      assert.ok(iAlvo >= 0, "o alvo tem que estar no resultado");
      assert.ok(iDist < 0 || iAlvo < iDist, `o distrator veio na frente do alvo (alvo=${iAlvo} distrator=${iDist}) — a busca não é relevante, só ruidosa`);
    } finally {
      for (const id of ids) { try { await raw.remove(id); } catch { /* segue */ } }
    }
  });
} finally {
  // Teardown: estes documentos são lixo real no store compartilhado. Cada execução acumularia dois.
  for (const id of criados) {
    try { await raw.remove(id); } catch (e) { console.log("  AVISO: teardown falhou para " + id + " (" + (e?.message || e) + ")"); }
  }
  if (criados.length) console.log(`  (teardown: ${criados.length} documento(s) de teste removido(s))`);
}

console.log(`\nmemory-cross-project-leak-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
