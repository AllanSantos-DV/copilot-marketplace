// memory-namespace-live-smoke.mjs — CONTRATO contra o daemon REST **VIVO** (não fake).
//
// Por que existe: os smokes de namespace usavam `discoverFn` e um client FALSO. Isso prova a lógica, mas NÃO
// prova o contrato com o serviço — e a falha que quase passou nesta sessão (verde-vazio) foi de WIRING, que é
// exatamente o que fake não pega. Aqui o isolamento é exercitado ponta a ponta contra o daemon real.
//
// LIVE por natureza: precisa do daemon de memória no ar. Fora do gate determinístico (roda em `npm run test:live`).
// Sem daemon → SKIP SINALIZADO, nunca falso verde.

import assert from "node:assert";
import { createMemoryPort, buildScope } from "../src/adapters/memory/memoryPort.mjs";

let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const skip = (m) => { total++; pass++; console.log("  skip - " + m); };

const port = createMemoryPort({ log: () => {} });
const online = await port.recall("ping", { topK: 1 });

if (online.ok === false && online.offline) {
  skip("daemon de memória OFFLINE — contrato ao vivo não é exercitável aqui (SINALIZADO, não é verde falso)");
  console.log(`\nmemory-namespace-live-smoke: ${pass}/${total} OK`);
  process.exit(0);
}

const MARCA = "PROVA-NS-" + Date.now().toString(36);
const projeto = port.projectId();

await run("save no namespace responde ok e devolve o escopo sufixado", async () => {
  const r = await port.save(`${MARCA}: decisão registrada pela mesa no arquivo de ADRs`, { type: "adr-registro", namespace: "adr" });
  assert.strictEqual(r.ok, true, "save falhou: " + JSON.stringify(r));
  assert.strictEqual(r.scope, buildScope(projeto, "adr"), "o escopo gravado tem que ser o do namespace: " + r.scope);
});

// o índice do daemon é assíncrono — espera curta antes de consultar
await new Promise((r) => setTimeout(r, 2000));

await run("o escopo PRINCIPAL NÃO enxerga a saída da mesa (o auto-envenenamento morre aqui)", async () => {
  const r = await port.recall(MARCA, { topK: 5 });
  assert.strictEqual(r.ok, true, "recall principal falhou: " + JSON.stringify(r));
  assert.ok(!(r.results || []).some((x) => String(x.text || "").includes(MARCA)), "a saída da mesa VAZOU para o escopo do projeto");
});

await run("o escopo #adr ENXERGA (não virou write-only — o arquivo é consultável)", async () => {
  const r = await port.recall(MARCA, { topK: 5, namespace: "adr" });
  assert.strictEqual(r.ok, true, "recall do namespace falhou: " + JSON.stringify(r));
  assert.ok((r.results || []).some((x) => String(x.text || "").includes(MARCA)), "o registro não voltou do próprio namespace — seria AMNÉSIA");
});

await run("recall online é ok:true com 0 resultados quando não acha (≠ offline)", async () => {
  const r = await port.recall("zzz-string-que-nao-existe-" + MARCA, { topK: 3 });
  assert.strictEqual(r.ok, true, "busca sem resultado é SUCESSO, não falha");
  assert.ok(!r.offline, "e nunca pode se confundir com offline");
});

await run("save de saída de agente SEM namespace quebra ALTO (não grava no escopo principal)", async () => {
  await assert.rejects(() => port.save("nao deveria gravar", { type: "adr-registro" }), /exige 'namespace'/);
});

console.log(`\nmemory-namespace-live-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
