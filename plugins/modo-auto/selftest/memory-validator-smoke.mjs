// memory-validator-smoke.mjs — o auditor de memória: contesta item a item, cita doc_id, e é read-only ESTRUTURAL.
//
// O que este arquivo protege, na ordem de gravidade:
//  1. Read-only não pode ser combinado — tem que ser AUSÊNCIA DE CAPACIDADE. O teste inspeciona as opções que o
//     auditor recebe (availableTools: []) em vez de perguntar ao modelo o que ele tem. Perguntar ao LLM "quais
//     tools você tem?" é AUTO-RELATO: prova o que ele DIZ, não o que o processo recebeu.
//  2. Citação inventada tem que ser DESCARTADA. Sem isso, "citar a fonte" vira teatro: o id existe no texto sem
//     existir no corpus.
//  3. Auditor quebrado NÃO pode apagar a memória — trocar "memória velha" por "nenhuma memória" é o defeito pior.

import assert from "node:assert";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { computeToolExposure } from "../src/adapters/agents/workerLib.mjs";
import { ROLES } from "../src/adapters/agents/roles.mjs";
import { resolveProjectId, tryResolveProjectId, projectIdStrength, assertSafeProjectId, normalizeGitRemote } from "../src/adapters/memory/projectId.mjs";
import { createMemoryPort } from "../src/adapters/memory/memoryPort.mjs";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "../src/adapters/memory/memoryTools.mjs";
import { conciliarVereditos, auditarMemoria, renderAuditado, promptAuditoria, MEMORY_VERDICT_SCHEMA, VEREDITOS } from "../src/adapters/memory/memoryValidator.mjs";

let pass = 0, total = 0;
const run = (m, fn) => { total++; try { fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const runA = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };

const ITENS = [
  { doc_id: "id-a", text: "decisão A: usar ports e adapters" },
  { doc_id: "id-b", text: "decisão B: revertida depois" },
];

console.log("conciliação de vereditos (defesa contra citação inventada)");
run("veredito válido classifica o item e separa aplicável de contestado", () => {
  const c = conciliarVereditos(ITENS, [
    { doc_id: "id-a", veredito: "aplica", razao: "segue válido" },
    { doc_id: "id-b", veredito: "desatualizado", razao: "foi revertida na v2" },
  ]);
  assert.strictEqual(c.aplicaveis.length, 1);
  assert.strictEqual(c.descartados.length, 1);
  assert.strictEqual(c.descartados[0].doc_id, "id-b");
  assert.strictEqual(c.invalidos.length, 0);
});
run("doc_id INVENTADO é descartado como inválido (citar a fonte não pode ser teatro)", () => {
  const c = conciliarVereditos(ITENS, [{ doc_id: "id-que-nao-existe", veredito: "nao_se_aplica", razao: "x" }]);
  assert.strictEqual(c.invalidos.length, 1, "id fora da lista injetada tem que ser rejeitado");
  assert.match(c.invalidos[0].motivo, /inventada/);
  assert.strictEqual(c.descartados.length, 0, "e NÃO pode descartar item nenhum com base numa citação falsa");
});
run("veredito fora do enum é inválido (não vira 'aplica' nem 'descartado' por acidente)", () => {
  const c = conciliarVereditos(ITENS, [{ doc_id: "id-a", veredito: "talvez", razao: "x" }]);
  assert.strictEqual(c.invalidos.length, 1);
  assert.strictEqual(c.itens.find((i) => i.doc_id === "id-a").veredito, "aplica", "item com veredito inválido fica por omissão, não some");
});
run("item NÃO julgado é MANTIDO (esquecer de listar não pode apagar memória legítima)", () => {
  const c = conciliarVereditos(ITENS, [{ doc_id: "id-a", veredito: "aplica", razao: "ok" }]);
  const b = c.itens.find((i) => i.doc_id === "id-b");
  assert.strictEqual(b.veredito, "aplica");
  assert.strictEqual(b.julgado, false, "e tem que ficar MARCADO como não-julgado, para não parecer aprovado");
});
run("o enum é exatamente o que o dono pediu (aplica / desatualizado / nao_se_aplica)", () => {
  assert.deepStrictEqual(VEREDITOS, ["aplica", "desatualizado", "nao_se_aplica"]);
  const p = MEMORY_VERDICT_SCHEMA.parameters.properties.itens.items;
  assert.deepStrictEqual(p.required, ["doc_id", "veredito", "razao"], "razao é OBRIGATÓRIA: veredito sem justificativa é opinião");
});

console.log("read-only ESTRUTURAL (capacidade ausente, não regra combinada)");
await runA("o auditor recebe availableTools:[] — não existe tool de memória na mão dele", async () => {
  let visto = null;
  const factory = { run: async (_r, _p, opts) => { visto = opts; return { ok: true, text: JSON.stringify({ itens: [] }) }; } };
  await auditarMemoria({ factory, assunto: "x", itens: ITENS });
  assert.deepStrictEqual(visto.availableTools, [], "fail-closed no SDK: só a tool de submit chega ao auditor");
  assert.strictEqual(visto.schema.name, "submit_memory_audit", "e a resposta vem por tool template, não por prosa");
});
run("o MÓDULO do auditor não referencia escrita de memória (grep negativo estrutural)", () => {
  // Se um dia alguém importar `save`/`buildSaveMetadata` aqui, o read-only vira convenção de novo. Este teste
  // quebra o build nesse dia. Path resolvido a partir deste arquivo — grep que não acha o arquivo dá falso-limpo.
  const src = readFileSync(new URL("../src/adapters/memory/memoryValidator.mjs", import.meta.url), "utf8");
  for (const proibido of [".save(", "buildSaveMetadata", "includeAgentOutput", "createMemoryPort"]) {
    assert.ok(!src.includes(proibido), `o auditor NÃO pode referenciar "${proibido}" — read-only tem que ser estrutural`);
  }
});
run("o prompt manda AUDITAR, não resumir nem concordar (senão vira eco do contexto)", () => {
  const p = promptAuditoria("assunto", ITENS);
  assert.match(p, /AUDITAR, não resumir e não concordar/);
  assert.match(p, /NÃO invente id/);
  assert.ok(p.includes("[id-a]") && p.includes("[id-b]"), "os ids têm que chegar ao modelo para ele poder copiar");
});

console.log("degradação honesta");
await runA("auditor FORA DO AR não apaga a memória — ela segue inteira e sinalizada", async () => {
  const avisos = [];
  const factory = { run: async () => ({ ok: false, error: "modelo indisponível" }) };
  const r = await auditarMemoria({ factory, assunto: "x", itens: ITENS, log: (m) => avisos.push(m) });
  assert.strictEqual(r.auditado, false);
  assert.strictEqual(r.aplicaveis.length, 2, "sem auditoria, TUDO continua chegando (não vira blackout)");
  assert.ok(avisos.some((m) => /sem auditoria/i.test(m)), "e o fato tem que ser dito: " + JSON.stringify(avisos));
});
await runA("auditor que não submete tool também degrada (não inventa veredito de prosa)", async () => {
  const factory = { run: async () => ({ ok: true, text: "claro, todos os itens parecem bons!" }) };
  const r = await auditarMemoria({ factory, assunto: "x", itens: ITENS });
  assert.strictEqual(r.auditado, false);
  assert.strictEqual(r.aplicaveis.length, 2);
});
run("o CONTESTADO não some do prompt — entra rotulado para a mesa poder discordar do auditor", () => {
  const c = conciliarVereditos(ITENS, [{ doc_id: "id-b", veredito: "desatualizado", razao: "revertida na v2" }]);
  const txt = renderAuditado(c);
  assert.match(txt, /\[id-a\]/, "o aplicável entra normal");
  assert.match(txt, /CONTESTADO PELA AUDITORIA/);
  assert.match(txt, /DESATUALIZADO: revertida na v2/, "com o motivo, para a mesa julgar o julgamento");
});
await runA("sem itens citáveis, não gasta worker (auditoria só existe se houver o que auditar)", async () => {
  let chamou = false;
  const r = await auditarMemoria({ factory: { run: async () => { chamou = true; return { ok: true, text: "{}" }; } }, assunto: "x", itens: [] });
  assert.strictEqual(chamou, false, "não pode spawnar worker à toa");
  assert.strictEqual(r.auditado, false);
});

run("ISOLAMENTO do worker é ESTRUTURAL, não auto-relato do modelo", () => {
  const fac = readFileSync(new URL("../src/adapters/agents/agentFactory.mjs", import.meta.url), "utf8");
  assert.match(fac, /MODO_AUTO_WORKER_CONFIGDIR/, "o worker tem que ter configDir próprio declarado");
  assert.match(fac, /\.modo-auto["'\s,)]|"\.modo-auto"/, "e ele aponta para ~/.modo-auto, não para ~/.copilot");
  const dir = join(homedir(), ".modo-auto", "worker-config", "installed-plugins");
  if (existsSync(dir)) {
    assert.deepStrictEqual(readdirSync(dir), [], "o configDir do worker tem que estar SEM plugins — qualquer um ali vira tool na mão do worker sem revisão");
  }
});

console.log("MATRIZ de papéis: nenhum recebe tool de memória (afirmação estrutural, não auto-relato)");
run("todo papel do catálogo: manifesto SEM tool de memória, em toda combinação", () => {
  // Eu tinha "provado" isolamento PERGUNTANDO a um worker quais tools ele tinha — auto-relato: prova o que o
  // modelo DIZ, não o que o processo recebeu. Aqui a regra que MONTA o manifesto é afirmada diretamente, para
  // TODOS os papéis e nas duas combinações que existem (com e sem tool template, com e sem allowlist).
  const papeis = [...Object.keys(ROLES), "sombra", "auditor-memoria", "papel-dinamico-inexistente"];
  const proibidas = /mem[oó]r|recall|memory|save|store|embed/i;
  for (const role of papeis) {
    for (const schemaName of [null, "submit_x"]) {
      for (const availableTools of [null, [], ["read"]]) {
        // SEM escopo cravado pelo pai (memoryToolNames vazio) — o caso padrão: nenhum papel vê memória.
        const e = computeToolExposure({ role, schemaName, availableTools, researchToolNames: ["web_search", "web_read"] });
        const suja = e.toolNames.filter((n) => proibidas.test(n));
        assert.deepStrictEqual(suja, [], `papel "${role}" recebeu tool de memória sem o pai cravar escopo: ${JSON.stringify(e)}`);
        if (Array.isArray(availableTools)) {
          const sujaAvail = (e.availableTools || []).filter((n) => proibidas.test(n));
          assert.deepStrictEqual(sujaAvail, [], `allowlist de "${role}" liberou memória: ${JSON.stringify(e)}`);
        }
      }
    }
  }
});
run("papel FAIL-CLOSED não ganha memória nem com escopo cravado (foi pedido text-only de propósito)", () => {
  const e = computeToolExposure({ role: "revisor", schemaName: "submit_x", availableTools: [], memoryToolNames: ["memory_search"] });
  assert.ok(!e.temMemoria, "allowlist explícita = o chamador quer text-only; dar busca contraria o pedido dele");
  assert.deepStrictEqual(e.availableTools, ["submit_x"]);
});
run("com escopo cravado, papel aberto ganha SÓ LEITURA (não existe tool de escrita no toolset)", () => {
  const e = computeToolExposure({ role: "documentacao", memoryToolNames: MEMORY_TOOL_NAMES });
  assert.deepStrictEqual(e.toolNames, ["memory_search"], "o toolset de memória é UMA tool, e ela é de busca");
  assert.ok(e.temMemoria);
  assert.ok(!MEMORY_TOOL_NAMES.some((n) => /save|write|delete|update/i.test(n)), "nenhum nome de escrita pode existir no toolset");
});
run("só o pesquisador ganha pesquisa — e nem ele ganha memória", () => {
  const p = computeToolExposure({ role: "pesquisador", researchToolNames: ["web_search", "web_read"] });
  assert.deepStrictEqual(p.toolNames, ["web_search", "web_read"]);
  const r = computeToolExposure({ role: "revisor", researchToolNames: ["web_search", "web_read"] });
  assert.deepStrictEqual(r.toolNames, [], "papel que não é pesquisador não recebe tool custom nenhuma");
});
run("availableTools:[] + schema = fail-closed com APENAS a submit (o caso do auditor)", () => {
  const e = computeToolExposure({ role: "revisor", schemaName: "submit_memory_audit", availableTools: [] });
  assert.deepStrictEqual(e.availableTools, ["submit_memory_audit"], "allowlist tem que conter só a submissão: " + JSON.stringify(e));
});

console.log("procedência do project_id (escopo derivado do caminho não pode parecer sólido)");
console.log("project_id: escopo OBRIGATÓRIO e fail-loud (contrato do copilot-memory, não da pasta)");
run("sem marcador e sem git remote → LANÇA (não inventa escopo a partir do caminho)", () => {
  // A escada tem DUAS rungs e um erro. Os fallbacks de caminho/nome-de-pasta foram removidos upstream de
  // propósito: eram a fonte do escopo-lixo (C:\, Temp, AppData virando "projeto"). Eu tinha uma cópia vendada
  // com a escada ANTIGA e cheguei a relatar "o escopo sai da pasta" como se fosse o produto. Este teste trava
  // o contrato certo para a cópia não divergir de novo em silêncio.
  const dir = mkdtempSync(join(tmpdir(), "sem-escopo-"));
  assert.throws(() => resolveProjectId(dir), /não foi possível resolver project_id/i);
  assert.strictEqual(projectIdStrength(dir), "none");
  assert.strictEqual(tryResolveProjectId(dir), null, "a variante best-effort devolve null, nunca um id inventado");
});
run("marcador declarado vence e converge de SUBPASTA (worktree/subpasta = MESMO id)", () => {
  const raiz = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(raiz, ".memory"), { recursive: true });
  writeFileSync(join(raiz, ".memory", "project.json"), JSON.stringify({ metadata: { defaults: { project_id: "dono/projeto" } } }));
  assert.strictEqual(resolveProjectId(raiz), "dono/projeto");
  assert.strictEqual(projectIdStrength(raiz), "declared");
  const sub = join(raiz, "src", "fundo");
  mkdirSync(sub, { recursive: true });
  // Sem git, a subpasta não tem âncora até a raiz — e o contrato é falhar, não subir o filesystem procurando.
  assert.throws(() => resolveProjectId(sub), /não foi possível resolver/i, "walk-up ilimitado é o que criava lixo");
});
run("git remote é normalizado e portável (mesmo id de https e de ssh)", () => {
  assert.strictEqual(normalizeGitRemote("https://github.com/Acme/Widgets.git"), "github.com/acme/widgets");
  assert.strictEqual(normalizeGitRemote("git@github.com:Acme/Widgets.git"), "github.com/acme/widgets");
});
run("PISO anti-caminho: id com cara de path é RECUSADO mesmo se alguém declarar", () => {
  assert.throws(() => assertSafeProjectId("C:\\Users\\allan\\.copilot"), /caminho de sistema de arquivos/);
  assert.throws(() => assertSafeProjectId("/home/x/proj"), /caminho de sistema de arquivos/);
  assert.strictEqual(assertSafeProjectId("github.com/dono/appdata"), "github.com/dono/appdata", "segmento 'appdata' num id legítimo passa");
});
await runA("port SEM escopo resolvível: erro VISÍVEL, nunca busca em escopo inventado", async () => {
  const port = createMemoryPort({
    cwdProvider: () => mkdtempSync(join(tmpdir(), "sem-git-")),
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => { throw new Error("NÃO PODE chegar aqui"); }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q");
  assert.strictEqual(r.ok, false);
  assert.ok(/escopo não resolvido/.test(r.error || ""), "tem que dizer que é ESCOPO, não confundir com offline: " + JSON.stringify(r));
  assert.ok(!r.offline, "e não pode se disfarçar de daemon fora do ar");
});

await runA("CONTRATO validado em monorepo, subpasta funda, worktree e repo local (não só nos repos do dono)", async () => {
  // A crítica era justa: eu tinha validado o fail-loud só contra os DOIS repos do próprio dono. Se o contrato
  // quebrasse num monorepo ou numa worktree, o fail-loud deixaria de ser proteção e viraria bloqueio de terceiro
  // legítimo. Aqui os cenários são construídos com git DE VERDADE e medidos.
  const { execFileSync } = await import("node:child_process");
  const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true });
  try { execFileSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }); }
  catch { console.log("    (git indisponível — cenários de repo não exercitáveis aqui)"); return; }

  const base = mkdtempSync(join(tmpdir(), "escopo-"));
  // A) monorepo COM remote: raiz e subpasta funda têm que dar o MESMO id (subpasta não pode divergir).
  const mono = join(base, "mono"); mkdirSync(join(mono, "pacotes", "api", "src"), { recursive: true });
  git(["init", "-q"], mono); git(["remote", "add", "origin", "https://github.com/Acme/Mono.git"], mono);
  assert.strictEqual(resolveProjectId(mono), "github.com/acme/mono");
  assert.strictEqual(resolveProjectId(join(mono, "pacotes", "api", "src")), "github.com/acme/mono", "subpasta funda de monorepo TEM que convergir");

  // B) repo local SEM remote e SEM marcador — o caso do terceiro. LANÇA, com o conserto na mensagem.
  const local = join(base, "local"); mkdirSync(join(local, "sub"), { recursive: true });
  git(["init", "-q"], local);
  for (const d of [local, join(local, "sub")]) {
    assert.throws(() => resolveProjectId(d), /\.memory\/project\.json|git remote origin/, "sem identificador estável tem que LANÇAR com o conserto junto");
  }

  // C) SEM remote mas COM marcador na raiz: raiz e subpasta convergem (é a âncora do git toplevel funcionando).
  const marc = join(base, "marcado"); mkdirSync(join(marc, ".memory"), { recursive: true }); mkdirSync(join(marc, "pacotes", "web"), { recursive: true });
  git(["init", "-q"], marc);
  writeFileSync(join(marc, ".memory", "project.json"), JSON.stringify({ metadata: { defaults: { project_id: "acme/monorepo" } } }));
  assert.strictEqual(resolveProjectId(marc), "acme/monorepo");
  assert.strictEqual(resolveProjectId(join(marc, "pacotes", "web")), "acme/monorepo", "marcador na raiz TEM que valer para a subpasta");

  // D) WORKTREE: cada sessão do app é uma worktree com caminho próprio — o id tem que ser o do repo base.
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], mono);
  const wt = join(base, "wt");
  git(["worktree", "add", "-q", wt, "-b", "wt"], mono);
  assert.strictEqual(resolveProjectId(wt), "github.com/acme/mono", "worktree NÃO pode virar outro projeto");
});

console.log("decisão de produto VERSIONADA (não pode viver só no session-state)");
run("o ADR do alvo da memória viaja NO ARTEFATO e fixa os não-negociáveis", () => {
  // O auditor externo cobrou 3× e tinha razão no ponto estrutural: uma decisão que só existe no session-state de
  // UMA máquina volta a ser "oral" para qualquer outra sessão, runtime ou pessoa. Este teste garante que o ADR
  // está no pacote instalado — se alguém tirar `docs/adr` do vendor ou do `files`, o artefato fica sem a decisão
  // e o teste QUEBRA aqui, no próprio artefato.
  const adr = new URL("../docs/adr/ADR-001-memoria-read-only-nos-agentes.md", import.meta.url);
  assert.ok(existsSync(adr), "o ADR do alvo da memória tem que estar DENTRO do artefato: " + adr.pathname);
  const t = readFileSync(adr, "utf8");
  for (const naoNegociavel of [
    "leitura escopada, nunca escrita",
    "Adaptador, não dependência",
    "Escrita NUNCA",
    "CRAVADO PELO PAI",
    "Público-alvo",
  ]) {
    assert.ok(t.includes(naoNegociavel), `o ADR precisa fixar "${naoNegociavel}" — sem isso vira prosa, não decisão`);
  }
});

console.log("tool de memória no worker: escopo CRAVADO, leitura apenas, com teto");
await runA("o escopo NÃO é parâmetro da tool — o modelo não pode escolher projeto", async () => {
  // É o ponto do desenho: o agente não recebe "projeto" como argumento que ele possa errar ou forjar. O escopo
  // vem do `recall` já escopado do pai. Se um dia alguém adicionar `project` aos parameters, isto quebra.
  const { tools } = createMemoryTools({ recall: async () => ({ ok: true, results: [] }), projectId: "dono/proj" });
  const props = Object.keys(tools[0].parameters.properties);
  assert.deepStrictEqual(props.sort(), ["query", "topK"], "a superfície do modelo é só query/topK: " + JSON.stringify(props));
  assert.ok(!JSON.stringify(tools[0].parameters).match(/project|scope|escopo/i), "escopo não pode ser argumento");
});
await runA("sem port de memória, o toolset é VAZIO (adaptador, não dependência)", async () => {
  const { tools } = createMemoryTools({ recall: null, projectId: "dono/proj" });
  assert.deepStrictEqual(tools, [], "sem memória o worker roda igual, sem tool nenhuma");
});
await runA("o recall do pai é usado TAL COMO ESTÁ — o handler não monta escopo", async () => {
  const vistos = [];
  const { tools } = createMemoryTools({ recall: async (q, o) => { vistos.push({ q, o }); return { ok: true, results: [{ doc_id: "d-1", text: "achado", score: 0.9 }] }; }, projectId: "dono/proj" });
  const r = JSON.parse(await tools[0].handler({ query: "como publicar" }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.results[0].doc_id, "d-1", "o resultado chega CITÁVEL ao modelo: " + JSON.stringify(r));
  assert.ok(!("project_id" in (vistos[0].o || {})) && !("namespace" in (vistos[0].o || {})), "o handler não pode injetar escopo: " + JSON.stringify(vistos[0].o));
});
await runA("indisponibilidade é DISTINGUÍVEL de 'não achei' (senão o modelo conclui que não há conhecimento)", async () => {
  const { tools } = createMemoryTools({ recall: async () => ({ ok: false, offline: true, results: [] }), projectId: "dono/proj" });
  const r = JSON.parse(await tools[0].handler({ query: "x" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.indisponivel, true, "tem que DIZER que é indisponibilidade: " + JSON.stringify(r));
  const vazio = createMemoryTools({ recall: async () => ({ ok: true, results: [] }), projectId: "dono/proj" });
  const r2 = JSON.parse(await vazio.tools[0].handler({ query: "x" }));
  assert.strictEqual(r2.ok, true, "busca sem resultado é SUCESSO com lista vazia, não indisponibilidade");
});
await runA("teto de buscas: estourar RECUSA EXPLICANDO, nunca devolve lista vazia (que seria mentira)", async () => {
  const { tools, state } = createMemoryTools({ recall: async () => ({ ok: true, results: [] }), projectId: "dono/proj", maxChamadas: 2 });
  await tools[0].handler({ query: "a" }); await tools[0].handler({ query: "b" });
  const r = JSON.parse(await tools[0].handler({ query: "c" }));
  assert.strictEqual(r.limite, true, "a 3ª tem que ser recusada COM motivo: " + JSON.stringify(r));
  assert.strictEqual(state.usadas, 2, "e o contador não pode passar do teto");
});
await runA("handler NUNCA lança para o SDK (erro vira JSON visível)", async () => {
  const { tools } = createMemoryTools({ recall: async () => { throw new Error("daemon explodiu"); }, projectId: "dono/proj" });
  const r = JSON.parse(await tools[0].handler({ query: "x" }));
  assert.strictEqual(r.ok, false);
  assert.match(r.detail || "", /daemon explodiu/, "o erro real tem que aparecer, não sumir: " + JSON.stringify(r));
});
await runA("port com projectId CRAVADO ignora o cwd (é o coração da Fase 2)", async () => {
  // Teste bilateral: (a) com id cravado, o cwd é irrelevante; (b) sem id cravado, o cwd manda. Só (a) seria
  // insuficiente — passaria mesmo se o cravado estivesse sendo ignorado e o cwd resolvesse por acaso.
  const semProjeto = mkdtempSync(join(tmpdir(), "sem-proj-"));
  const chamadas = [];
  const port = createMemoryPort({
    projectId: "dono/cravado",
    cwdProvider: () => semProjeto,
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async (q, o) => { chamadas.push(o); return { results: [] }; }, save: async () => ({ id: "1" }) }),
  });
  const r = await port.recall("q");
  assert.strictEqual(r.ok, true, "com id cravado, um cwd SEM projeto não pode impedir a busca: " + JSON.stringify(r));
  assert.strictEqual(chamadas[0].metadata.project_id, "dono/cravado", "e o escopo consultado é o CRAVADO: " + JSON.stringify(chamadas[0].metadata));

  const semCravar = createMemoryPort({
    cwdProvider: () => semProjeto,
    discoverFn: async () => ({ url: "http://fake" }),
    clientFactory: () => ({ search: async () => ({ results: [] }), save: async () => ({ id: "1" }) }),
  });
  const r2 = await semCravar.recall("q");
  assert.strictEqual(r2.ok, false, "sem cravar, o MESMO cwd sem projeto tem que falhar — senão o teste acima passaria por acaso");
  assert.match(r2.error || "", /escopo não resolvido/);
});
run("id cravado com cara de CAMINHO é recusado (o piso vale também para o cravado)", () => {
  assert.throws(() => assertSafeProjectId("C:\\Users\\x\\.copilot"), /caminho de sistema de arquivos/);
});

console.log(`\nmemory-validator-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
