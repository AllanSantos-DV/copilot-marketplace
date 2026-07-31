// memory-namespace-smoke.mjs — a separação de escopo é ESTRUTURAL (project_id), não textual.
//
// A defesa anterior contra a mesa reconsumir a própria saída dependia de um marcador `[ADR-REGISTRO]` no texto E
// de o registro "caber em um chunk". Isso acopla a garantia ao chunker de um servidor de terceiro: num documento
// maior, os pedaços do meio voltam SEM o marcador e a proteção falha EM SILÊNCIO. Aqui a separação usa apenas
// `project_id`, que é a mecânica de escopo já aplicada pelo daemon (é como projetos diferentes não se misturam).
//
// NOTA DE MÉTODO: a lógica é testada pela função PURA `buildSaveMetadata`. Testar através do port exigiria daemon
// vivo — e uma primeira versão deste teste passou VAZIA justamente por isso: o port caía no atalho de "offline" e
// as asserções nunca rodavam. Verde por caminho não-executado é pior que vermelho.

import assert from "node:assert";
import { buildSaveMetadata, createMemoryPort, AGENT_OUTPUT_TYPES, recallIssue, RECALL_ALLOWED_TYPES } from "../src/adapters/memory/memoryPort.mjs";

let pass = 0, total = 0;
const runA = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const run = (m, fn) => { total++; try { fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const PROJ = "owner/projeto";

console.log("escopo de gravação");
run("sem namespace, grava no escopo do projeto", () => {
  const m = buildSaveMetadata({ projectId: PROJ, type: "knowledge" });
  assert.strictEqual(m.project_id, PROJ);
});
run("com namespace, o project_id é SUFIXADO (escopo diferente do que o recall consulta)", () => {
  const m = buildSaveMetadata({ projectId: PROJ, type: "adr-registro", namespace: "adr" });
  assert.strictEqual(m.project_id, `${PROJ}#adr`);
  assert.notStrictEqual(m.project_id, PROJ, "não pode cair no escopo principal");
});
run("o namespace NÃO vaza para o escopo principal (é isto que quebra o ciclo)", () => {
  const mesa = buildSaveMetadata({ projectId: PROJ, namespace: "adr" }).project_id;
  const recallScope = PROJ; // o recall usa o project_id puro
  assert.notStrictEqual(mesa, recallScope, "a saída da mesa não pode compartilhar escopo com a busca dela");
});
run("namespace vazio/whitespace é tratado como ausente (não cria escopo '#')", () => {
  assert.strictEqual(buildSaveMetadata({ projectId: PROJ, namespace: "" }).project_id, PROJ);
  assert.strictEqual(buildSaveMetadata({ projectId: PROJ, namespace: "   " }).project_id, PROJ);
});
run("sem projectId não inventa escopo", () => {
  assert.ok(!("project_id" in buildSaveMetadata({ projectId: null, namespace: "adr" })), "sem projeto, nada de escopo fake");
});

console.log("independência do documento (o problema do chunker)");
run("a garantia não depende do TAMANHO nem do CONTEÚDO", () => {
  const gigante = "x".repeat(50000); // seria picado em vários chunks; um marcador de texto se perderia
  const m = buildSaveMetadata({ projectId: PROJ, type: "adr-registro", namespace: "adr" });
  assert.strictEqual(m.project_id, `${PROJ}#adr`, "escopo vale igual para documento grande");
  assert.ok(!JSON.stringify(m).includes(gigante.slice(0, 10)), "o escopo não olha o conteúdo — por isso não quebra em silêncio");
});

console.log("metadados preservados");
run("type e tags continuam indo no metadata", () => {
  const m = buildSaveMetadata({ projectId: PROJ, type: "adr-registro", tags: ["adr", "registro"], namespace: "adr" });
  assert.strictEqual(m.type, "adr-registro");
  assert.deepStrictEqual(m.tags, ["adr", "registro"]);
});
run("tags vazias não viram campo vazio", () => {
  assert.ok(!("tags" in buildSaveMetadata({ projectId: PROJ, tags: [] })));
});

console.log("guard de escrita: saída de agente NUNCA cai no escopo do projeto");
run("adr-registro SEM namespace LANÇA (não grava em silêncio no escopo principal)", () => {
  assert.throws(() => buildSaveMetadata({ projectId: PROJ, type: "adr-registro" }), /exige 'namespace'/);
  assert.throws(() => buildSaveMetadata({ projectId: PROJ, type: "adr-registro", namespace: "  " }), /exige 'namespace'/);
});
run("todos os tipos de saída de agente são protegidos", () => {
  for (const t of AGENT_OUTPUT_TYPES) assert.throws(() => buildSaveMetadata({ projectId: PROJ, type: t }), /exige 'namespace'/, `tipo ${t} desprotegido`);
});
run("com namespace, passa e carimba source_type (2ª camada, metadado e não texto)", () => {
  const m = buildSaveMetadata({ projectId: PROJ, type: "adr-registro", namespace: "adr" });
  assert.strictEqual(m.project_id, `${PROJ}#adr`);
  assert.strictEqual(m.source_type, "agent_output");
});
run("conhecimento normal NÃO exige namespace nem vira agent_output", () => {
  const m = buildSaveMetadata({ projectId: PROJ, type: "knowledge" });
  assert.strictEqual(m.project_id, PROJ);
  assert.ok(!("source_type" in m), "só saída de agente se declara como tal");
});

console.log("contrato do PORT (daemon falso — prova o caminho ONLINE, não o atalho de offline)");
await runA("recall online chega ao client com o escopo certo", async () => {
  const calls = [];
  const port = createMemoryPort({
    cwdProvider: () => process.cwd(),
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [{ text: "x", score: 0.9 }] }; }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q", { topK: 3 });
  assert.strictEqual(r.ok, true, "com daemon vivo o recall TEM que ser ok:true (antes isto nunca era exercitado)");
  assert.strictEqual(r.results.length, 1);
  assert.ok(calls[0].metadata.project_id && !calls[0].metadata.project_id.includes("#"), "escopo principal, sem namespace");
});
await runA("recall com namespace consulta o escopo IRMÃO", async () => {
  const calls = [];
  const port = createMemoryPort({
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q", { namespace: "adr" });
  assert.strictEqual(r.ok, true);
  assert.ok(String(calls[0].metadata.project_id).endsWith("#adr"), "tem que consultar o namespace: " + calls[0].metadata.project_id);
});
await runA("save online propaga namespace e source_type até o client", async () => {
  const calls = [];
  const port = createMemoryPort({
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async (c, m) => { calls.push(m); return { id: "1" }; } }),
  });
  const r = await port.save("registro", { type: "adr-registro", namespace: "adr" });
  assert.strictEqual(r.ok, true);
  assert.ok(String(calls[0].project_id).endsWith("#adr"));
  assert.strictEqual(calls[0].source_type, "agent_output");
});
await runA("OFFLINE é DISTINGUÍVEL de 'nada encontrado' (o verde-vazio que me pegou)", async () => {
  const port = createMemoryPort({ discoverFn: async () => null });
  const r = await port.recall("q");
  assert.strictEqual(r.ok, false, "offline NÃO pode devolver ok:true com lista vazia");
  assert.strictEqual(r.offline, true, "o caller precisa conseguir dizer 'estava fora do ar'");
  const vazio = createMemoryPort({
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async () => ({ id: "1" }) }),
  });
  const r2 = await vazio.recall("q");
  assert.strictEqual(r2.ok, true, "busca que não achou nada é SUCESSO com 0 resultados");
  assert.ok(!r2.offline, "e não pode se confundir com offline");
});
await runA("save em daemon offline não finge sucesso", async () => {
  const port = createMemoryPort({ discoverFn: async () => null });
  const r = await port.save("x", { type: "knowledge" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.offline, true);
});

console.log("recallIssue: regra ÚNICA para os 5 chamadores");
run("offline vira aviso EXPLÍCITO (era engolido como 'sem resultado')", () => {
  const msg = recallIssue({ ok: false, offline: true }, "mesa");
  assert.ok(msg && /OFFLINE/.test(msg), "precisa dizer offline: " + msg);
  assert.ok(/NÃO é "nada encontrado"/.test(msg), "e precisa negar a leitura errada");
});
run("erro real continua sendo reportado com a causa", () => {
  const msg = recallIssue({ ok: false, error: "ECONNREFUSED" }, "modo-dev");
  assert.ok(msg && msg.includes("ECONNREFUSED"));
});
run("falha SEM error nem offline não some calada", () => {
  assert.ok(recallIssue({ ok: false }, "x"), "ok:false sempre gera sinal, mesmo sem motivo");
});
run("busca bem-sucedida NÃO gera ruído (inclusive vazia)", () => {
  assert.strictEqual(recallIssue({ ok: true, results: [] }, "x"), null);
  assert.strictEqual(recallIssue({ ok: true, results: [{ text: "a" }] }, "x"), null);
});
run("ausência de memória (port não configurado) não vira alarme falso", () => {
  assert.strictEqual(recallIssue(null, "x"), null);
});
run("a tag do chamador aparece (para saber QUEM degradou)", () => {
  assert.ok(recallIssue({ ok: false, offline: true }, "modo-scopo").includes("modo-scopo"));
});

console.log("contrato do namespace #adr: quem CONSOME");
await runA("modo_dev consulta o arquivo de ADRs ao construir uma fase (não é artefato órfão)", async () => {
  const { createModoDev } = await import("../src/adapters/profiles/modoDev.mjs");
  const chamadas = [];
  const caps = {
    factory: { run: async () => ({ ok: true, text: "código" }) },
    gate: { run: async () => ({ ok: true, findings: [] }) },
    memory: { recall: async (q, opts) => { chamadas.push(opts || {}); return { ok: true, results: [] }; } },
  };
  await createModoDev({ log: () => {} }).develop("fase de teste", caps, { taskType: "feature" }).catch(() => {});
  assert.ok(chamadas.some((o) => o.namespace === "adr"), "modo_dev tem que consultar o escopo #adr: " + JSON.stringify(chamadas));
  assert.ok(chamadas.some((o) => !o.namespace), "e também o escopo do projeto");
});

await runA("as decisões anteriores chegam ao prompt do dev, rotuladas como 'não contradiga'", async () => {
  const { createModoDev } = await import("../src/adapters/profiles/modoDev.mjs");
  const prompts = [];
  const caps = {
    factory: { run: async (role, prompt) => { prompts.push(prompt); return { ok: true, text: "código" }; } },
    gate: { run: async () => ({ ok: true, findings: [] }) },
    memory: {
      recall: async (q, opts) => (opts?.namespace === "adr"
        ? { ok: true, results: [{ text: "DECISÃO: usar ports e adapters, nada de acesso direto a fs no core." }] }
        : { ok: true, results: [] }),
    },
  };
  await createModoDev({ log: () => {} }).develop("fase de teste", caps, { taskType: "feature" }).catch(() => {});
  const txt = prompts.join("\n---\n");
  assert.ok(txt.includes("ports e adapters"), "a decisão anterior precisa chegar a quem implementa");
  assert.ok(/DECISÕES JÁ TOMADAS PELA MESA/.test(txt), "e rotulada, para o dev saber que é decisão, não sugestão");
  assert.ok(/NÃO contradiga/.test(txt), "com a instrução explícita de não contradizer");
});

console.log("2ª camada de leitura: allowlist positiva (o servidor não sabe negar)");
run("com excludeAgentOutput, o filtro vai por LISTA de tipos legítimos", () => {
  assert.ok(Array.isArray(RECALL_ALLOWED_TYPES) && RECALL_ALLOWED_TYPES.length >= 3, "precisa de allowlist");
  for (const t of AGENT_OUTPUT_TYPES) {
    assert.ok(!RECALL_ALLOWED_TYPES.includes(t), `tipo de saída de agente "${t}" NÃO pode estar na allowlist de leitura`);
  }
});
await runA("o recall filtrado manda type=allowlist ao client (é assim que exclui o legado)", async () => {
  const calls = [];
  const port = createMemoryPort({
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q", { excludeAgentOutput: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0].metadata.type, RECALL_ALLOWED_TYPES, "o filtro tem que ir como LISTA: " + JSON.stringify(calls[0].metadata));
});
await runA("sem a flag, NÃO filtra por tipo (opt-in, nunca ligado por baixo do pano)", async () => {
  const calls = [];
  const port = createMemoryPort({
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  await port.recall("q");
  assert.ok(!("type" in (calls[0].metadata || {})), "sem opt-in não pode aparecer filtro de tipo");
});

console.log(`\nmemory-namespace-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
