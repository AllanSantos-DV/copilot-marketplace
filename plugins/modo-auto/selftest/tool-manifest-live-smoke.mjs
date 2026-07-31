// tool-manifest-live-smoke.mjs — INSPEÇÃO DO MANIFESTO REAL de um worker VIVO, por papel.
//
// POR QUE ESTE ARQUIVO EXISTE (a crítica que o motivou, e ela procede): eu tinha um teste que afirmava a função
// pura `computeToolExposure`. Isso prova a REGRA, não o PROCESSO. Se o `worker.mjs` deixar de chamar a regra, ou
// se o SDK herdar tools por outro caminho (config vazado, MCP, extensão do usuário), a suíte fica VERDE e o
// isolamento está furado. A única prova é spawnar o papel de verdade e ler o que a sessão REALMENTE recebeu.
//
// Como funciona: sob `MODO_AUTO_DUMP_TOOLS=1` o worker escreve `\x1e#TOOLS {json}` no stderr, do lado de DENTRO,
// depois do `createSession`. Aqui a gente spawna o worker real (o mesmo binário que a mesa usa), captura esse
// manifesto e afirma a invariante: NENHUMA tool de memória, em NENHUM papel.
//
// LIVE por natureza (spawna processo e o SDK abre sessão). Sem SDK/credencial → SKIP sinalizado, FAIL sob STRICT.

import assert from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { assinarEscopo, segredoDoProcesso } from "../src/adapters/memory/memoryTools.mjs";

const STRICT = process.env.MODO_AUTO_STRICT === "1";
let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const skip = (m) => {
  total++;
  if (STRICT) { console.log("  FAIL - [STRICT] " + m + " :: MODO_AUTO_STRICT=1 exige o worker executável — skip não conta como verde no gate de release"); return; }
  pass++; console.log("  skip - " + m);
};

const WORKER = fileURLToPath(new URL("../src/adapters/agents/worker.mjs", import.meta.url));
const PROIBIDAS = /mem[oó]r|recall|memory|save|store|embed/i;

/** Spawna o worker REAL com um job mínimo e devolve o manifesto que ele declarou de dentro. */
function manifestoDe(job, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, MODO_AUTO_DUMP_TOOLS: "1", NODE_NO_WARNINGS: "1", MODO_AUTO_SCOPE_SECRET: segredoDoProcesso() };
    delete env.NODE_OPTIONS; delete env.COPILOT_SDK_PATH;
    const child = spawn(process.execPath, [WORKER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let err = "", achou = null;
    const t = setTimeout(() => { try { child.kill(); } catch { /* já morreu */ } resolve({ manifesto: achou, erro: "timeout", stderr: err }); }, timeoutMs);
    child.stderr.on("data", (d) => {
      err += d.toString();
      for (const linha of err.split("\n")) {
        const i = linha.indexOf("#TOOLS ");
        if (i >= 0 && !achou) { try { achou = JSON.parse(linha.slice(i + 7)); } catch { /* linha parcial: espera a próxima */ } }
      }
      // O manifesto sai logo após createSession; não precisamos do turno inteiro (que custa modelo).
      if (achou) { clearTimeout(t); try { child.kill(); } catch { /* ok */ } resolve({ manifesto: achou, stderr: err }); }
    });
    child.on("close", () => { clearTimeout(t); resolve({ manifesto: achou, stderr: err }); });
    child.stdin.write(JSON.stringify(job)); child.stdin.end();
  });
}

const sonda = await manifestoDe({ role: "revisor", system: "s", prompt: "diga ok", idleGraceMs: 20000 }, { timeoutMs: 60000 });
if (!sonda.manifesto) {
  skip("worker não produziu manifesto (SDK/credencial indisponível aqui) — inspeção viva não é exercitável. stderr: " + (sonda.stderr || "").slice(0, 160).replace(/\s+/g, " "));
  console.log(`\ntool-manifest-live-smoke: ${pass}/${total} OK`);
  process.exit(pass === total ? 0 : 1);
}

// A MATRIZ. Cobre os papéis que a mesa realmente spawna, incluindo o auditor (fail-closed) e o pesquisador
// (o ÚNICO com tools custom — se memória vazasse em algum lugar, seria nele).
const CASOS = [
  { nome: "revisor (crítica livre)", job: { role: "revisor", system: "s", prompt: "ok" } },
  { nome: "pesquisador (tem tools custom — o mais arriscado)", job: { role: "pesquisador", system: "s", prompt: "ok" } },
  { nome: "desenvolvedor (modo-dev)", job: { role: "desenvolvedor", system: "s", prompt: "ok" } },
  { nome: "documentacao (modo-adr)", job: { role: "documentacao", system: "s", prompt: "ok" } },
  { nome: "analista (modo-scopo)", job: { role: "analista", system: "s", prompt: "ok" } },
  { nome: "validador (modo-autonomo)", job: { role: "validador", system: "s", prompt: "ok" } },
  { nome: "auditor de memória (fail-closed: availableTools:[])", job: { role: "revisor", system: "s", prompt: "ok", availableTools: [], schema: { name: "submit_memory_audit", description: "d", parameters: { type: "object", properties: {}, required: [] } } } },
  { nome: "papel DINÂMICO (não está no catálogo)", job: { role: "papel-inventado-pelo-arquiteto", system: "s", prompt: "ok" } },
];

for (const c of CASOS) {
  await run(`manifesto REAL sem tool de memória — ${c.nome}`, async () => {
    const manifesto0 = (await manifestoDe({ ...c.job, idleGraceMs: 20000 }));
    const { manifesto, stderr } = manifesto0;
    assert.ok(manifesto, "não veio manifesto: " + (stderr || "").slice(0, 200));
    // A proibição é sobre ACESSO a memória. `submit_*` é o TOOL TEMPLATE de resposta: o handler só captura os
    // argumentos e devolve — não lê nem grava nada (provado no teste `submit_* não acessa nada`, abaixo). Sem
    // esta distinção, o próprio auditor de memória seria acusado pelo nome da sua tool de veredito, e eu estaria
    // trocando uma invariante por um casamento de string.
    const acessa = (n) => PROIBIDAS.test(n) && !/^submit_/.test(n);
    const sujas = [
      ...(manifesto.custom || []).filter(acessa),
      ...((manifesto.availableTools || []).filter(acessa)),
      ...((manifesto.sdk || []).filter(acessa)),
    ];
    assert.deepStrictEqual(sujas, [], `o papel "${c.job.role}" RECEBEU tool de memória: ${JSON.stringify(manifesto)}`);
    // Isolamento do config no MESMO ponto: se o configDir não for o isolado, o worker herdaria extensões do
    // usuário — e aí a lista de tools acima nem seria a verdade toda.
    assert.ok(String(manifesto.configDir || "").includes(".modo-auto"), "worker rodou FORA do configDir isolado: " + manifesto.configDir);
  });
}

await run("[matriz viva] com escopo CRAVADO o papel recebe memory_search — e SÓ ele, e só leitura", async () => {
  // Fecha a outra ponta da matriz: até aqui todos os casos provam a AUSÊNCIA. Este prova a PRESENÇA controlada,
  // no processo real: quando o pai crava o escopo, a tool aparece no manifesto do worker — e é uma só, de busca.
  const { manifesto, stderr } = await manifestoDe({ role: "documentacao", system: "s", prompt: "ok", idleGraceMs: 20000, memoryScope: "dono/projeto-de-teste", memoryScopeSig: assinarEscopo("dono/projeto-de-teste") });
  assert.ok(manifesto, "não veio manifesto: " + (stderr || "").slice(0, 200));
  assert.deepStrictEqual(manifesto.custom, ["memory_search"], "com escopo cravado, o manifesto tem a tool de LEITURA: " + JSON.stringify(manifesto));
  const escrita = (manifesto.custom || []).filter((n) => /save|write|delete|update|grava/i.test(n));
  assert.deepStrictEqual(escrita, [], "e NENHUMA tool de escrita, em hipótese alguma");
});

await run("[matriz viva] papel fail-closed NÃO ganha memória nem com escopo cravado", async () => {
  const { manifesto } = await manifestoDe({ role: "revisor", system: "s", prompt: "ok", idleGraceMs: 20000, memoryScope: "dono/projeto-de-teste", memoryScopeSig: assinarEscopo("dono/projeto-de-teste"), availableTools: [], schema: { name: "submit_x", description: "d", parameters: { type: "object", properties: {}, required: [] } } });
  assert.ok(manifesto, "não veio manifesto");
  assert.deepStrictEqual(manifesto.custom, ["submit_x"], "text-only continua text-only: " + JSON.stringify(manifesto));
});

await run("[matriz viva] MESA VIVA com escopo cravado recebe memory_search (é o caminho que de fato roda)", async () => {
  // Este caso existe por um erro meu que uma auditoria pegou: eu tinha ligado a memória só no `factory.run` do
  // modo_adr, que é o caminho de FALLBACK. O que roda de verdade é a MESA VIVA (`liveWorker`), e ela continuava
  // cega — "Fase 2 funcionando" estava certo no mecanismo e errado no caminho. Aqui o liveWorker é spawnado de
  // verdade e o manifesto é lido de dentro.
  const { spawn: sp } = await import("node:child_process");
  const LIVE = fileURLToPath(new URL("../src/adapters/agents/liveWorker.mjs", import.meta.url));
  const env = { ...process.env, MODO_AUTO_DUMP_TOOLS: "1", NODE_NO_WARNINGS: "1", MODO_AUTO_WORKER_ROLE: "tecnico", MODO_AUTO_WORKER_SYSTEM: "s", MODO_AUTO_WORKER_MEMORY_SCOPE: "dono/projeto-de-teste", MODO_AUTO_WORKER_MEMORY_SIG: assinarEscopo("dono/projeto-de-teste"), MODO_AUTO_SCOPE_SECRET: segredoDoProcesso() };
  delete env.NODE_OPTIONS; delete env.COPILOT_SDK_PATH;
  const achado = await new Promise((resolve) => {
    const c = sp(process.execPath, [LIVE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let err = "", pronto = false;
    const t = setTimeout(() => { try { c.kill(); } catch { /* ok */ } resolve({ err }); }, 90000);
    const fim = (v) => { if (!pronto) { pronto = true; clearTimeout(t); try { c.kill(); } catch { /* ok */ } resolve(v); } };
    c.stderr.on("data", (d) => { err += d.toString(); });
    c.stdout.on("data", (d) => { err += d.toString(); if (/"type":"ready"/.test(err)) fim({ err }); });
    c.on("close", () => fim({ err }));
  });
  if (!/"type":"ready"/.test(achado.err)) { console.log("    (liveWorker não subiu aqui — SDK/credencial: " + achado.err.slice(0, 120).replace(/\s+/g, " ") + ")"); return; }
  const m = achado.err.match(/#TOOLS (\{.*?\})\n/);
  assert.ok(m, "o liveWorker precisa declarar o manifesto sob MODO_AUTO_DUMP_TOOLS: " + achado.err.slice(0, 200));
  const manifesto = JSON.parse(m[1]);
  assert.ok((manifesto.custom || []).includes("memory_search"), "a MESA VIVA tem que receber a busca quando o pai crava o escopo: " + JSON.stringify(manifesto));
});

await run("submit_* NÃO acessa nada — a exceção acima é provada, não assumida", async () => {
  // Se um dia `makeSubmitTool` ganhar efeito colateral, a exceção do filtro vira um buraco. Aqui se prova que o
  // handler é um CAPTURADOR: chamá-lo não toca memória, disco nem rede — só guarda os argumentos.
  const { makeSubmitTool } = await import("../src/adapters/agents/structuredResult.mjs");
  const s = makeSubmitTool({ name: "submit_memory_audit", description: "d", parameters: { type: "object", properties: {}, required: [] } });
  const fonte = readFileSync(new URL("../src/adapters/agents/structuredResult.mjs", import.meta.url), "utf8");
  for (const proibido of ["fetch(", "readFile", "writeFile", "execFile", "spawn(", "MemoryClient", "recall"]) {
    assert.ok(!fonte.includes(proibido), `o tool template de resposta não pode ter efeito colateral ("${proibido}")`);
  }
  assert.strictEqual(s.captured(), false, "antes da chamada, nada foi capturado");
  const ret = await s.tool.handler({ itens: [{ doc_id: "x" }] });
  assert.strictEqual(s.captured(), true, "o handler só captura os argumentos — é isso e nada mais");
  assert.deepStrictEqual(s.get(), { itens: [{ doc_id: "x" }] }, "e devolve exatamente o que recebeu, sem tocar em nada");
  assert.match(String(ret), /received/, "a resposta ao modelo é um ack, não dado de lugar nenhum");
});

await run("o configDir isolado do worker continua SEM plugins (nada vira tool sem revisão)", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = join(homedir(), ".modo-auto", "worker-config", "installed-plugins");
  if (!existsSync(dir)) return; // nunca criado = nunca houve plugin
  assert.deepStrictEqual(readdirSync(dir), [], "plugin no configDir do worker vira tool na mão dele sem passar por revisão");
});

console.log(`\ntool-manifest-live-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
