// memory-namespace-live-smoke.mjs — CONTRATO contra o daemon REST **VIVO** (não fake).
//
// Por que existe: os smokes de namespace usavam `discoverFn` e um client FALSO. Isso prova a lógica, mas NÃO
// prova o contrato com o serviço — e a falha que quase passou nesta sessão (verde-vazio) foi de WIRING, que é
// exatamente o que fake não pega. Aqui o isolamento é exercitado ponta a ponta contra o daemon real.
//
// LIVE por natureza: precisa do daemon de memória no ar. Fora do gate determinístico (roda em `npm run test:live`).
//
// SEM daemon o comportamento DEPENDE de quem está rodando, e os dois usos são legítimos e opostos:
//  • TERCEIRO (clone anônimo da vitrine): não tem daemon nenhum, e não deve ter. Falhar ali seria um vermelho
//    mentiroso sobre um artefato que está correto. → SKIP SINALIZADO.
//  • MEU GATE DE RELEASE: aqui o daemon É dependência crítica. Deixar o skip virar verde é exatamente o
//    anti-padrão que faz release passar sem exercitar a garantia. → MODO_AUTO_STRICT=1 transforma skip em FALHA.
// STRICT positivo NÃO é "não deu skip": é daemon respondeu E as invariantes passaram. Um daemon no ar porém
// quebrado tem que ficar vermelho, não passar sujo.
import assert from "node:assert";
import { createMemoryPort, buildScope } from "../src/adapters/memory/memoryPort.mjs";
import { discover } from "../src/adapters/memory/daemon.mjs";
import { MemoryClient } from "../src/adapters/memory/client.mjs";

const STRICT = process.env.MODO_AUTO_STRICT === "1";

let pass = 0, total = 0;
const run = async (m, fn) => { total++; try { await fn(); pass++; console.log("  ok - " + m); } catch (e) { console.log("  FAIL - " + m + " :: " + (e?.message || e)); } };
const skip = (m) => {
  total++;
  if (STRICT) { console.log("  FAIL - [STRICT] " + m + " :: MODO_AUTO_STRICT=1 exige a dependência NO AR — skip não conta como verde no gate de release"); return; }
  pass++; console.log("  skip - " + m);
};

const port = createMemoryPort({ log: () => {} });
const online = await port.recall("ping", { topK: 1 });

if (online.ok === false && online.offline) {
  skip("daemon de memória OFFLINE — contrato ao vivo não é exercitável aqui (SINALIZADO, não é verde falso)");
  console.log(`\nmemory-namespace-live-smoke: ${pass}/${total} OK`);
  process.exit(pass === total ? 0 : 1);
}

const MARCA = "PROVA-NS-" + Date.now().toString(36);
const projeto = port.projectId();

await run("save no namespace responde ok e devolve o escopo sufixado", async () => {
  const r = await port.save(`${MARCA}: decisão registrada pela mesa no arquivo de ADRs`, { type: "adr-registro", namespace: "adr" });
  assert.strictEqual(r.ok, true, "save falhou: " + JSON.stringify(r));
  assert.strictEqual(r.scope, buildScope(projeto, "adr"), "o escopo gravado tem que ser o do namespace: " + r.scope);
});


// O índice do daemon é ASSÍNCRONO. Um `sleep` fixo é aposta: curto demais dá falso vermelho, longo demais faz
// todo mundo esperar à toa. Aqui a espera é por CONDIÇÃO, com teto — e se o teto estourar, é falha de verdade.
async function until(cond, { tentativas = 12, intervaloMs = 750 } = {}) {
  for (let i = 0; i < tentativas; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return false;
}

await run("o escopo #adr ENXERGA (não virou write-only — o arquivo é consultável)", async () => {
  const achou = await until(async () => {
    const r = await port.recall(MARCA, { topK: 5, namespace: "adr" });
    return r.ok && (r.results || []).some((x) => String(x.text || "").includes(MARCA));
  });
  assert.ok(achou, "o registro não voltou do próprio namespace mesmo após ~9s — seria AMNÉSIA");
});

await run("o escopo PRINCIPAL NÃO enxerga a saída da mesa (o auto-envenenamento morre aqui)", async () => {
  const r = await port.recall(MARCA, { topK: 5 });
  assert.strictEqual(r.ok, true, "recall principal falhou: " + JSON.stringify(r));
  assert.ok(!(r.results || []).some((x) => String(x.text || "").includes(MARCA)), "a saída da mesa VAZOU para o escopo do projeto");
});

await run("recall online é ok:true com 0 resultados quando não acha (≠ offline)", async () => {
  const r = await port.recall("zzz-string-que-nao-existe-" + MARCA, { topK: 3 });
  assert.strictEqual(r.ok, true, "busca sem resultado é SUCESSO, não falha");
  assert.ok(!r.offline, "e nunca pode se confundir com offline");
});

await run("save de saída de agente SEM namespace quebra ALTO (não grava no escopo principal)", async () => {
  await assert.rejects(() => port.save("nao deveria gravar", { type: "adr-registro" }), /exige 'namespace'/);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// TESTE NEGATIVO — a rede que faltava. Até aqui só se provava o caminho FELIZ (o que a mesa grava HOJE vai para o
// namespace e o escopo principal não vê). Isso não cobre o LEGADO: documentos de saída de agente gravados ANTES
// da separação vivem no escopo principal e voltariam na busca. Eu tinha provado isso À MÃO nesta sessão — prova
// manual não roda de novo e não protege contra regressão.
//
// ORDEM DELIBERADA (é o que impede o verde vazio): primeiro provo que o veneno ESTÁ LÁ (abrindo a escotilha), só
// então provo que o recall padrão NÃO o traz. Na ordem inversa o teste passaria por indexação atrasada — o
// documento ainda não visível daria "não voltou" e eu leria isso como "a guarda funcionou".
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const VENENO = `selftest-neg-${RUN_ID}: plano antigo gravado como conhecimento (legado pré-namespace)`;
let venenoId = null;
try {
  const info = await discover();
  const raw = new MemoryClient(info.url);
  // Plantado pelo CLIENT, não pelo port: o port QUEBRA ALTO nesta gravação (é a 1ª camada, e ela funciona). Para
  // exercitar a 2ª camada é preciso simular o corpus de antes dela existir.
  const saved = await raw.save(VENENO, { project_id: projeto, type: "plan", source_type: "agent_output" });
  venenoId = saved?.id || saved?.documentId || null;

  await run("[negativo] o veneno legado É alcançável com a escotilha aberta (senão o próximo teste é vazio)", async () => {
    const achou = await until(async () => {
      const r = await port.recall(VENENO, { topK: 10, includeAgentOutput: true });
      return r.ok && (r.results || []).some((x) => String(x.text || "").includes(RUN_ID));
    });
    assert.ok(achou, "o documento plantado não ficou visível nem com a escotilha — sem isto o teste seguinte passa por engano");
  });

  await run("[negativo] o recall PADRÃO BLOQUEIA o veneno legado (2ª camada, fail-closed)", async () => {
    const r = await port.recall(VENENO, { topK: 10 });
    assert.strictEqual(r.ok, true, "recall falhou: " + JSON.stringify(r));
    assert.strictEqual(r.filtered, true, "o recall padrão tem que estar FILTRADO");
    const vazou = (r.results || []).filter((x) => String(x.text || "").includes(RUN_ID));
    assert.strictEqual(vazou.length, 0, "saída de agente legado VAZOU no recall padrão: " + JSON.stringify(vazou.map((v) => v.text.slice(0, 80))));
  });
} finally {
  // Teardown por runId: o veneno é lixo real no corpus do projeto. Deixá-lo seria envenenar de verdade o que este
  // teste existe para proteger — e cada execução acumularia mais um.
  if (venenoId) {
    try { const info = await discover(); await new MemoryClient(info.url).remove(venenoId); console.log("  (teardown: veneno " + venenoId + " removido)"); }
    catch (e) { console.log("  AVISO: teardown do veneno FALHOU (" + (e?.message || e) + ") — documento " + venenoId + " ficou no corpus"); }
  }
}

console.log(`\nmemory-namespace-live-smoke: ${pass}/${total} OK`);
process.exit(pass === total ? 0 : 1);
