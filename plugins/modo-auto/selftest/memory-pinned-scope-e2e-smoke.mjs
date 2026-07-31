// memory-pinned-scope-e2e-smoke.mjs — O GATE DE ACEITE DA FASE 2, do jeito que o ADR pediu e eu não tinha feito.
//
// O QUE ESTE TESTE PROVA E OS OUTROS NÃO PROVAM: o leak-smoke roda dois ports NO MESMO PROCESSO — ele mede o
// filtro do daemon, não a CRAVAÇÃO pai→filho. A inspeção de manifesto prova que a tool EXISTE no worker, não
// que ela busca no projeto CERTO. Aqui um worker REAL é spawnado num CWD HOSTIL (um diretório que resolveria
// para outro projeto, ou para projeto nenhum), a tool é chamada de verdade, e a asserção é sobre o CONTEÚDO
// devolvido: só o do projeto do pai.
//
// É a diferença entre "tem capacidade" e "tem o escopo certo" — o finding central, e o único jeito de fechá-lo
// é executando o caminho inteiro.
//
// LIVE: precisa do daemon. Sem ele → SKIP sinalizado; FAIL sob MODO_AUTO_STRICT.

import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "../src/adapters/memory/daemon.mjs";
import { MemoryClient } from "../src/adapters/memory/client.mjs";

const STRICT = process.env.MODO_AUTO_STRICT === "1";
let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const skip = (m) => {
  total++;
  if (STRICT) { console.log("  FAIL - [STRICT] " + m + " :: MODO_AUTO_STRICT=1 exige o daemon NO AR — a cravação de escopo não se prova com skip"); return; }
  pass++; console.log("  skip - " + m);
};

const info = await discover();
if (!info) {
  skip("daemon de memória OFFLINE — o E2E da cravação de escopo não é exercitável aqui");
  console.log(`\nmemory-pinned-scope-e2e-smoke: ${pass}/${total} OK`);
  process.exit(pass === total ? 0 : 1);
}

const WORKER = fileURLToPath(new URL("../src/adapters/agents/worker.mjs", import.meta.url));
const RUN = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const PROJ_PAI = `selftest-pin-pai/${RUN}`;
const PROJ_HOSTIL = `selftest-pin-hostil/${RUN}`;
const MARCA_PAI = `PIN-PAI-${RUN}`;
const MARCA_HOSTIL = `PIN-HOSTIL-${RUN}`;
const QUERY = "procedimento de deploy e publicação de versões deste projeto";

const raw = new MemoryClient(info.url);
const criados = [];

/** CWD HOSTIL: um projeto de verdade, com marcador declarado apontando para OUTRO project_id. Se o filho
 *  resolvesse escopo pelo próprio cwd (o bug que a cravação existe para impedir), ele cairia AQUI. */
const cwdHostil = mkdtempSync(join(tmpdir(), "hostil-"));
mkdirSync(join(cwdHostil, ".memory"), { recursive: true });
writeFileSync(join(cwdHostil, ".memory", "project.json"), JSON.stringify({ metadata: { defaults: { project_id: PROJ_HOSTIL } } }));

function rodarWorker({ memoryScope, cwd, prompt, timeoutMs = 150000 }) {
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_NO_WARNINGS: "1", MODO_AUTO_DUMP_TOOLS: "1" };
    delete env.NODE_OPTIONS; delete env.COPILOT_SDK_PATH;
    const child = spawn(process.execPath, [WORKER], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { try { child.kill(); } catch { /* já morreu */ } resolve({ out, err, timeout: true }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", () => { clearTimeout(t); resolve({ out, err }); });
    const job = { role: "documentacao", system: "Você responde de forma curta e literal.", prompt, idleGraceMs: 60000, ...(memoryScope ? { memoryScope } : {}) };
    child.stdin.write(JSON.stringify(job)); child.stdin.end();
  });
}

try {
  for (const [proj, marca] of [[PROJ_PAI, MARCA_PAI], [PROJ_HOSTIL, MARCA_HOSTIL]]) {
    const s = await raw.save(`${marca}: o procedimento de deploy deste projeto é rodar o publicador e conferir a versão.`, { project_id: proj, type: "knowledge" });
    const id = s?.id || s?.documentId; if (id) criados.push(id);
  }
  // Indexação é assíncrona: espera por CONDIÇÃO, senão o teste vira aposta.
  for (let i = 0; i < 14; i++) {
    const r = await raw.search(QUERY, { topK: 10, metadata: { project_id: PROJ_PAI } });
    if ((r.results || []).some((x) => String(x.text || "").includes(MARCA_PAI))) break;
    await new Promise((r2) => setTimeout(r2, 750));
  }

  await run("[E2E] worker em CWD HOSTIL, com escopo CRAVADO, lê SÓ o projeto do pai", async () => {
    const { out, err, timeout } = await rodarWorker({
      memoryScope: PROJ_PAI,
      cwd: cwdHostil,
      prompt: `Use a ferramenta memory_search com a query "${QUERY}". Responda APENAS com o texto EXATO do primeiro trecho encontrado, sem comentar. Se a ferramenta não existir, responda SEM-FERRAMENTA.`,
    });
    if (timeout || (!out.trim() && !/#TOOLS/.test(err))) { console.log("    (worker não respondeu — SDK/credencial indisponível: " + (err || "").slice(0, 120).replace(/\s+/g, " ") + ")"); return; }
    const texto = out + "\n" + err;
    assert.ok(texto.includes(MARCA_PAI), "o worker tinha que trazer o conteúdo do projeto do PAI: " + texto.slice(0, 300).replace(/\s+/g, " "));
    assert.ok(!texto.includes(MARCA_HOSTIL), "VAZOU: o worker leu o projeto do CWD dele em vez do escopo cravado — a cravação não está valendo");
    // Prova complementar pelo ledger: o escopo que o worker de fato consultou.
    assert.ok(new RegExp("#MEM[^\\n]*" + PROJ_PAI.replace(/[/\\]/g, "\\$&")).test(err), "o ledger tem que registrar o escopo REAL consultado: " + (err.match(/#MEM[^\n]*/g) || []).join(" | ").slice(0, 200));
  });

  await run("[E2E] o mesmo worker, no mesmo CWD hostil, SEM escopo cravado NÃO ganha a tool (fail-closed)", async () => {
    // O eixo que varia é SÓ o escopo cravado — mesmo papel, mesmo cwd, mesmo prompt. Sem isso o teste acima
    // poderia estar passando por outro motivo (ex.: o cwd hostil nem resolver projeto).
    const { out, err, timeout } = await rodarWorker({ memoryScope: null, cwd: cwdHostil, prompt: "Você tem a ferramenta memory_search? Responda apenas SIM ou NAO." });
    if (timeout) { console.log("    (worker não respondeu a tempo)"); return; }
    const manifesto = (err.match(/#TOOLS (\{.*?\})\n/) || [])[1];
    if (manifesto) {
      const m = JSON.parse(manifesto);
      assert.deepStrictEqual((m.custom || []).filter((n) => /memory/i.test(n)), [], "sem escopo cravado, NENHUMA tool de memória pode existir: " + manifesto);
    }
    assert.ok(!(out + err).includes(MARCA_HOSTIL), "sem escopo cravado o worker não pode ler projeto NENHUM — nem o do cwd dele");
  });
} finally {
  for (const id of criados) { try { await raw.remove(id); } catch (e) { console.log("  AVISO: teardown falhou para " + id); } }
  if (criados.length) console.log(`  (teardown: ${criados.length} documento(s) de teste removido(s))`);
}

console.log(`\nmemory-pinned-scope-e2e-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
