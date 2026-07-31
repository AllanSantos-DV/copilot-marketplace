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

import { tmpDir } from "./tmpProjeto.mjs";
import assert from "node:assert";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSaveMetadata, createMemoryPort, AGENT_OUTPUT_TYPES, recallIssue, RECALL_ALLOWED_TYPES, normalizeResults, renderRecall } from "../src/adapters/memory/memoryPort.mjs";

let pass = 0, total = 0;
const runA = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const run = (m, fn) => { total++; try { fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const PROJ = "owner/projeto";

// ESCOPO DETERMINÍSTICO PARA O TESTE. O port resolve project_id do cwd, e o contrato (fiel ao copilot-memory) é
// FALHAR ALTO quando não há marcador nem git remote. Rodando do repo dev isso resolve; rodando do ARTEFATO
// INSTALADO (aninhado em ~/.copilot, sem marcador) LANÇA — e a suíte inteira ficava vermelha por causa do LOCAL,
// não da regra. Estes testes exercitam namespace/filtro, não resolução de escopo: então eles criam o próprio
// projeto, com marcador, e ficam independentes de onde o processo está.
const PROJETO_FAKE = tmpDir("proj-fake-");
mkdirSync(join(PROJETO_FAKE, ".memory"), { recursive: true });
writeFileSync(join(PROJETO_FAKE, ".memory", "project.json"), JSON.stringify({ metadata: { defaults: { project_id: PROJ } } }));

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
    cwdProvider: () => PROJETO_FAKE,
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
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
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q", { namespace: "adr" });
  assert.strictEqual(r.ok, true);
  assert.ok(String(calls[0].metadata.project_id).endsWith("#adr"), "tem que consultar o namespace: " + calls[0].metadata.project_id);
});
await runA("save online propaga namespace e source_type até o client", async () => {
  const calls = [];
  const port = createMemoryPort({
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async (c, m) => { calls.push(m); return { id: "1" }; } }),
  });
  const r = await port.save("registro", { type: "adr-registro", namespace: "adr" });
  assert.strictEqual(r.ok, true);
  assert.ok(String(calls[0].project_id).endsWith("#adr"));
  assert.strictEqual(calls[0].source_type, "agent_output");
});
await runA("OFFLINE é DISTINGUÍVEL de 'nada encontrado' (o verde-vazio que me pegou)", async () => {
  const port = createMemoryPort({ cwdProvider: () => PROJETO_FAKE, discoverFn: async () => null });
  const r = await port.recall("q");
  assert.strictEqual(r.ok, false, "offline NÃO pode devolver ok:true com lista vazia");
  assert.strictEqual(r.offline, true, "o caller precisa conseguir dizer 'estava fora do ar'");
  const vazio = createMemoryPort({
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async () => ({ id: "1" }) }),
  });
  const r2 = await vazio.recall("q");
  assert.strictEqual(r2.ok, true, "busca que não achou nada é SUCESSO com 0 resultados");
  assert.ok(!r2.offline, "e não pode se confundir com offline");
});
await runA("save em daemon offline não finge sucesso", async () => {
  const port = createMemoryPort({ cwdProvider: () => PROJETO_FAKE, discoverFn: async () => null });
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

console.log("2ª camada de leitura: FAIL-CLOSED por escopo (allowlist positiva — o servidor não sabe negar)");
run("a allowlist de leitura e a lista de saída de agente são disjuntas", () => {
  assert.ok(Array.isArray(RECALL_ALLOWED_TYPES) && RECALL_ALLOWED_TYPES.length >= 3, "precisa de allowlist");
  for (const t of AGENT_OUTPUT_TYPES) {
    assert.ok(!RECALL_ALLOWED_TYPES.includes(t), `tipo de saída de agente "${t}" NÃO pode estar na allowlist de leitura`);
  }
});

// A rede que faltava. A versão anterior desta camada era OPT-IN e ficou ligada em 1 de 7 chamadas — guarda que
// precisa ser lembrada não é guarda. Estes testes travam o DEFAULT: chamada nova nasce filtrada sem fazer nada.
const portEspiao = () => {
  const calls = [];
  const port = createMemoryPort({
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { calls.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  return { port, calls };
};

await runA("DEFAULT do escopo principal é FILTRADO (fail-closed: caller novo nasce seguro)", async () => {
  const { port, calls } = portEspiao();
  const r = await port.recall("q");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0].metadata.type, RECALL_ALLOWED_TYPES, "sem pedir nada, o filtro tem que ir: " + JSON.stringify(calls[0].metadata));
  assert.strictEqual(r.filtered, true, "o retorno tem que DIZER que filtrou");
});

await runA("ler um NAMESPACE não filtra (o arquivo de ADRs é saída de agente por desenho — filtrar = amnésia)", async () => {
  const { port, calls } = portEspiao();
  const r = await port.recall("q", { namespace: "adr" });
  assert.ok(!("type" in (calls[0].metadata || {})), "namespace não pode levar filtro de tipo: " + JSON.stringify(calls[0].metadata));
  assert.strictEqual(r.filtered, false, "e o retorno tem que dizer que NÃO filtrou");
});

// Caso NEGATIVO exigido pelo painel profundo: em .mjs não há tipo em runtime, então um valor "quase-true"
// (string, 1, objeto) NÃO pode desligar a guarda por coerção. A escotilha exige o booleano exato.
for (const forjado of ["true", 1, {}, [], "sim"]) {
  await runA(`escotilha NÃO abre por coerção — includeAgentOutput=${JSON.stringify(forjado)} continua filtrando`, async () => {
    const { port, calls } = portEspiao();
    const r = await port.recall("q", { includeAgentOutput: forjado });
    assert.deepStrictEqual(calls[0].metadata.type, RECALL_ALLOWED_TYPES, "valor truthy não-booleano NÃO pode desligar a 2ª camada");
    assert.strictEqual(r.filtered, true);
  });
}

await runA("escotilha abre SÓ com o booleano exato true — e AVISA no log (nunca em silêncio)", async () => {
  const avisos = [];
  const port = createMemoryPort({
    log: (m) => avisos.push(m),
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q", { includeAgentOutput: true, tag: "teste" });
  assert.strictEqual(r.filtered, false, "com true exato, a camada desliga");
  assert.ok(avisos.some((m) => /includeAgentOutput=true/.test(m) && /teste/.test(m)), "abrir a escotilha tem que deixar rastro no log: " + JSON.stringify(avisos));
});

// GATE ESTRUTURAL (o painel apontou que "bloqueante" sem CI é social). Com fail-closed não há opt-in a esquecer,
// então o que precisa de vigilância é o CONTRÁRIO: alguém desligar a guarda. Este teste QUEBRA O BUILD se um
// `includeAgentOutput` aparecer no código de produção sem estar declarado aqui.
const ESCOTILHAS_AUTORIZADAS = Object.freeze([]); // nenhuma hoje: os 2 casos legítimos usam `namespace`
const DEFINE_A_REGRA = "memoryPort.mjs"; // onde a opção NASCE; vigiar aqui seria vigiar a própria guarda
run("nenhuma escotilha não-declarada no código de produção (gate que quebra o build)", () => {
  const raiz = new URL("../src/", import.meta.url);
  const achados = [];
  const varrer = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) varrer(u);
      else if (e.name.endsWith(".mjs") && e.name !== DEFINE_A_REGRA) {
        readFileSync(u, "utf8").split("\n").forEach((l, i) => {
          // Qualquer menção num CHAMADOR conta — inclusive `includeAgentOutput: algumaVar`, que passaria
          // despercebido por um casamento só de `: true` e ainda assim abriria a guarda em runtime.
          if (/includeAgentOutput\s*:/.test(l)) achados.push(`${e.name}:${i + 1}`);
        });
      }
    }
  };
  varrer(raiz);
  const naoAutorizados = achados.filter((a) => !ESCOTILHAS_AUTORIZADAS.includes(a));
  assert.deepStrictEqual(naoAutorizados, [], "escotilha aberta em produção sem estar declarada em ESCOTILHAS_AUTORIZADAS: " + naoAutorizados.join(", "));
});

// MEMÓRIA CITÁVEL: normalização no PORT (não em 5 callers) + id que sobrevive ao truncamento.
console.log("memória citável: normalização única no port");
run("normaliza o contrato REAL do daemon (documentId/chunkIndex — NÃO existe .id)", () => {
  // Este teste existe porque eu quase implementei em cima de `.id`, que NÃO existe: o contrato medido contra a
  // API viva é {text, score, documentId, chunkIndex}. Com o campo errado, 100% dos itens degradariam — e o
  // sintoma seria "a memória sumiu", não "usei o campo errado".
  const [r] = normalizeResults([{ text: "conteúdo", score: 0.8, documentId: "abc-123", chunkIndex: 2 }]);
  assert.strictEqual(r.doc_id, "abc-123");
  assert.strictEqual(r.chunk, 2);
  assert.strictEqual(r.text, "conteúdo");
});
run("item SEM id vira doc_id:null — nunca 'undefined' carimbado (citação falsa é pior que ausência)", () => {
  const [r] = normalizeResults([{ text: "sem id" }]);
  assert.strictEqual(r.doc_id, null, "id ausente tem que ser null explícito: " + JSON.stringify(r));
});
run("o doc_id SOBREVIVE ao truncamento (id longo, texto cortado — id vai em campo separado)", () => {
  // Aceite exigido pelo painel: id sintético curto passaria mesmo numa implementação errada que concatenasse o
  // id ao texto ANTES do slice. Aqui o id é um UUID e o texto é maior que o corte — se fosse concatenado, o id
  // sairia mutilado (e id mutilado parece válido, o que é pior que id faltando).
  const uuid = "9f1c2d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f";
  const longo = "x".repeat(500);
  const out = renderRecall(normalizeResults([{ text: longo, documentId: uuid }]), { max: 220 });
  assert.ok(out.text.includes(uuid), "o id íntegro tem que aparecer na linha: " + out.text.slice(0, 80));
  assert.ok(out.text.length < 400, "e o TEXTO tem que continuar truncado: " + out.text.length);
  assert.deepStrictEqual(out.ids, [uuid], "os ids citáveis são devolvidos para um gate poder conferir a citação");
});
run("item SEM id ENTRA marcado [sem-id] — descartar apagaria a memória inteira em silêncio se o campo mudasse", () => {
  const out = renderRecall(normalizeResults([{ text: "a", documentId: "id-1" }, { text: "b" }]), { max: 50 });
  assert.strictEqual(out.ids.length, 1, "só o item com id é CITÁVEL");
  assert.ok(/\[sem-id\] b/.test(out.text), "mas o não-citável continua chegando, marcado: " + out.text);
  assert.strictEqual(out.semId, 1, "e a perda de auditabilidade tem que ser contada: " + JSON.stringify(out));
});
await runA("o recall devolve JÁ normalizado (a regra mora no port, não nos 5 callers)", async () => {
  const port = createMemoryPort({
    cwdProvider: () => PROJETO_FAKE, discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [{ text: "t", documentId: "d-9", chunkIndex: 0 }] }), save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q");
  assert.strictEqual(r.results[0].doc_id, "d-9", "o caller tem que receber doc_id pronto: " + JSON.stringify(r.results[0]));
});

console.log(`\nmemory-namespace-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
