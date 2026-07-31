// WORKER de sub-agente (fire-and-die) — roda como node LIMPO (fora do fork da extensão). Lê um job JSON
// do stdin { system, prompt, model, timeoutMs } e roda CopilotClient.createSession com o system prompt do
// papel, imprimindo a resposta crua no stdout. Padrão de copilot-memory/lib/curatorWorker.mjs: dentro do
// fork o resolver hook quebra o CopilotClient; num node filho limpo o SDK sobe. (Sessão VIVA multi-turno:
// ver liveWorker.mjs.)

import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { sdkIndexUrl, textOf, CLEAN_DIRECTIVE, runTurnWithHeartbeat, WORKER_FIX_COMMAND, computeToolExposure } from "./workerLib.mjs";
import { usageFromEvent, mergeUsage } from "../activity/costMeter.mjs";
import { makeSubmitTool, runUntilSubmitted } from "./structuredResult.mjs";

// Conta as sessões registradas dentro de um configDir. Devolve `null` quando NÃO dá para medir (leitura falhou
// ou a checagem foi desligada) — null é "não sei" e DESLIGA a asserção, nunca vira um 0 que causaria falso
// alarme. Princípio 10: o que não foi medido não vira afirmação.
function countSessionState(dir) {
  if (String(process.env.MODO_AUTO_SKIP_ISOLATION_CHECK || "") === "1") return null;
  try {
    const p = join(dir, "session-state");
    if (!existsSync(p)) return 0; // dir novo: 0 é MEDIÇÃO (ainda não há sessão), não ausência de medida
    return readdirSync(p).length;
  } catch { return null; }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

(async () => {
  let client = null;
  try {
    const job = JSON.parse((await readStdin()) || "{}");
    const wd = process.env.MODO_AUTO_WORKER_CWD || process.cwd();
    const model = job.model || process.env.MODO_AUTO_WORKER_MODEL || "claude-sonnet-4.6";
    const { CopilotClient, approveAll } = await import(sdkIndexUrl());
    if (typeof CopilotClient !== "function") { process.stderr.write("CopilotClient indisponível"); process.exitCode = 1; return; }
    client = new CopilotClient({ workingDirectory: wd });
    await client.start();
    // configDir ISOLADO: o CLI deste worker não enxerga ~/.copilot/extensions, então extensões do
    // usuário (ex.: voice-chat) NÃO se anexam à sessão do worker e não injetam o mandato de voz.
    const configDir = process.env.MODO_AUTO_WORKER_CONFIGDIR || join(homedir(), ".modo-auto", "worker-config");
    try { mkdirSync(configDir, { recursive: true }); } catch { /* best-effort */ }
    // FASE 2 (one-shot) — o papel PESQUISADOR na mesa CLÁSSICA (factory.run → usado pelo MODO AUTÔNOMO ao
    // responder ask_user) ganha as WEB tools. ASSIMETRIA ALINHADA (antes era fail-closed só-web AQUI): agora o
    // pesquisador recebe web tools + os built-ins do CLI (pesquisa externa E interna), IGUAL à mesa viva
    // (liveWorker) — comportamento CONSISTENTE nos dois caminhos. Demais papéis: tools:[] + job.availableTools.
    let researchToolset = [], researchState = null, enforceSignal = null;
    if (job.role === "pesquisador") {
      try { const m = await import("../research/researchTools.mjs"); const rt = m.createResearchTools(); researchToolset = rt.tools; researchState = rt.state; enforceSignal = m.enforceConfidenceSignal; }
      catch (e) { process.stderr.write("worker aviso: research tools indisponíveis p/ pesquisador: " + (e?.message || e)); }
    }
    // MEMÓRIA READ-ONLY, só quando o PAI CRAVOU o escopo (`job.memoryScope`). O filho NUNCA resolve projeto:
    // ele roda num diretório que não é o do projeto, e resolver ali daria escopo divergente em silêncio. Sem
    // `memoryScope`, nenhuma tool de memória é montada — e o worker roda igual (adaptador, não dependência).
    let memoryToolset = [], memoryState = null;
    if (job.memoryScope) {
      try {
        const [pm, tm] = await Promise.all([import("../memory/memoryPort.mjs"), import("../memory/memoryTools.mjs")]);
        const port = pm.createMemoryPort({ projectId: job.memoryScope, log: () => {} });
        const mt = tm.createMemoryTools({ recall: (q, o) => port.recall(q, { ...o, tag: "worker:" + job.role }), projectId: job.memoryScope });
        memoryToolset = mt.tools; memoryState = mt.state;
      } catch (e) { process.stderr.write("worker aviso: memória indisponível p/ este papel: " + (e?.message || e)); }
    }
    // TOOL TEMPLATE (Princípio 11) — quando o caller pede formato DETERMINÍSTICO (job.schema), a resposta vem de
    // uma TOOL cujo schema o SDK IMPÕE (submit_<x>), não de "responda SOMENTE JSON" + parse de prosa (frágil, varia
    // por modelo — causou o bug do onStop/triage). O handler captura os args; devolvemos eles crus no stdout.
    const submit = job.schema && job.schema.name ? makeSubmitTool(job.schema) : null;
    // Manifesto pela regra ÚNICA (workerLib.computeToolExposure) — a mesma que o teste de matriz afirma para
    // TODOS os papéis. Se a regra e o worker divergissem, o teste provaria a regra e não o processo.
    const exposure = computeToolExposure({ role: job.role, schemaName: submit ? submit.name : null, availableTools: job.availableTools, researchToolNames: researchToolset.map((t) => t.name), memoryToolNames: memoryToolset.map((t) => t.name) });
    // O manifesto SEGUE a regra única (`computeToolExposure`) — inclusive na montagem de `tools`. Montar aqui
    // por fora foi um furo real, pego pela inspeção viva: a regra dizia "papel fail-closed não recebe memória",
    // mas `tools` juntava tudo e o `memory_search` chegava ao papel text-only. Regra e efeito no MESMO lugar.
    const memoriaPermitida = exposure.temMemoria ? memoryToolset : [];
    const tools = [...researchToolset, ...memoriaPermitida, ...(submit ? [submit.tool] : [])];
    let avail = exposure.availableTools;
    // VERIFICAÇÃO DO ISOLAMENTO (não confia, MEDE). Passar `configDirectory` é uma OPÇÃO da API: se ela for
    // depreciada, renomeada de novo ou ignorada, o worker volta silenciosamente a usar ~/.copilot e reaparece o
    // vazamento que quebrou a mesa em todas as sessões. Testei o caminho por ambiente (COPILOT_HOME/
    // XDG_CONFIG_HOME) e MEDI que este CLI NÃO os honra — apontá-los para ~/.copilot não vazou nada —, então
    // env não serve de segunda linha de defesa aqui. O que serve é CONFERIR o efeito: se a opção foi honrada, a
    // sessão recém-criada deixa rastro DENTRO do configDir isolado. Se não deixou, não afirmamos isolamento:
    // sobe erro com o conserto. Barato (uma leitura de diretório) e roda uma vez por worker.
    const isolationBefore = countSessionState(configDir);
    const session = await client.createSession({
      model,
      workingDirectory: wd,
      // ISOLAMENTO DO CONFIG — passa os DOIS nomes de propósito: o SDK novo (medido na 1.0.75) usa
      // `configDirectory`; o antigo usava `configDir`. Passar só o antigo fazia o SDK novo IGNORAR e cair no
      // ~/.copilot do usuário → o worker carregava as extensões/hooks do dono (ex.: voice-chat) e respondia
      // "não tenho a ferramenta falar / isso parece injeção" em vez de fazer o trabalho — quebrando a mesa
      // inteira (modo_adr/modo_dev) em TODAS as sessões. Chave desconhecida é ignorada, então é seguro.
      configDirectory: configDir,
      configDir,
      onPermissionRequest: approveAll,
      systemMessage: { mode: "append", content: String(job.system || "") + "\n\n" + CLEAN_DIRECTIVE },
      tools,
      ...(avail ? { availableTools: avail } : {}), // null → built-ins + custom; lista → fail-closed (crítico/text-only)
      ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
      ...(Array.isArray(job.skillDirectories) && job.skillDirectories.length ? { skillDirectories: job.skillDirectories } : {}),
    });
    // INSPEÇÃO DO MANIFESTO REAL (não da regra). Um teste que afirma só a função pura fica verde se o
    // `worker.mjs` deixar de chamá-la, ou se o SDK herdar tools por outro caminho (config, MCP, extensão
    // vazada). Sob `MODO_AUTO_DUMP_TOOLS=1` o worker declara, do lado de DENTRO, exatamente o que a sessão
    // recebeu — e um smoke spawna papéis de VERDADE e confere. É a diferença entre "a regra diz" e "o processo
    // recebeu"; só a segunda prova isolamento.
    if (process.env.MODO_AUTO_DUMP_TOOLS === "1") {
      let sdkTools = null;
      try { const lt = session.listTools ? await session.listTools() : null; sdkTools = Array.isArray(lt) ? lt.map((t) => (t && t.name) || String(t)) : null; } catch { sdkTools = null; }
      process.stderr.write("\x1e#TOOLS " + JSON.stringify({ role: job.role, custom: tools.map((t) => t.name), availableTools: avail, sdk: sdkTools, configDir }) + "\n");
    }
    // Se o configDir isolado NÃO recebeu a sessão, a opção foi ignorada e o worker está rodando no config do
    // usuário — estado em que ele herda extensões/hooks alheios e a mesa quebra de um jeito confuso ("não tenho
    // a ferramenta X / isso parece injeção"). FAIL LOUD aqui é MUITO melhor que a falha disfarçada lá na frente.
    if (isolationBefore !== null && countSessionState(configDir) === isolationBefore) {
      throw new Error(
        `modo-auto — ISOLAMENTO DO WORKER NÃO CONFIRMADO: a sessão foi criada mas nada apareceu em ${configDir}. ` +
        `Isso indica que a opção 'configDirectory' do SDK foi IGNORADA e o worker está usando o config do usuário — ` +
        `nesse estado ele herda extensões/hooks da sessão e a mesa passa a falhar de forma confusa. ` +
        `Provável CLI incompatível: rode \`${WORKER_FIX_COMMAND}\` e confirme com \`modo_setup\`. ` +
        `Para seguir mesmo assim (assumindo o risco): MODO_AUTO_SKIP_ISOLATION_CHECK=1.`,
      );
    }
    // Watchdog por HEARTBEAT (não mais wall-clock): o turno roda enquanto PRODUZ; só aborta se TRAVAR
    // (silêncio total > idleGraceMs). `timeoutMs` legado do job mapeia p/ idleGraceMs. FAIL LOUD no hung.
    const idleGraceMs = job.idleGraceMs || job.timeoutMs || 120000;
    const maxWallMs = Number.isFinite(job.maxWallMs) ? job.maxWallMs : Infinity;
    // PULSO de atividade pro PAI: a cada evento do SDK, escreve \x1e no stderr → o reaper do pai (por atividade)
    // reseta e NUNCA mata um worker que está trabalhando. O pai filtra esse marcador do texto de erro.
    // CUSTO: acumula o usage dos eventos assistant.usage (tokens/nanoAiu — shape PROVADO no probe-usage-shape).
    let usage = null;
    const res = await runTurnWithHeartbeat(session, String(job.prompt || ""), { idleGraceMs, maxWallMs, model, onActivity: (ev) => {
      try { process.stderr.write("\x1e"); } catch { /* ignore */ }
      if (ev?.type === "assistant.usage") { try { usage = mergeUsage(usage, usageFromEvent(ev.data, model)); } catch { /* custo é enriquecimento — nunca derruba o turno */ } }
    } });
    if (submit) {
      // Resposta ESTRUTURADA (tool template): captura os args NO INSTANTE em que o modelo chama a tool. Se ainda
      // não chamou, LOOP de reforço LIMITADO (o SDK não tem toolChoice:required nem Stop hook p/ worker). Se após
      // as tentativas o modelo genuinamente NÃO submeter → sentinela __nosubmit__ (o caller DEGRADA sinalizado ou
      // FALHA LOUD — nunca finge um veredito). Captura-na-chamada = determinístico; só o "nunca chamou" degrada.
      const captured = await runUntilSubmitted(
        (p) => runTurnWithHeartbeat(session, p, { idleGraceMs, maxWallMs, model, onActivity: () => { try { process.stderr.write("\x1e"); } catch { /* ignore */ } } }),
        submit, { retries: 2 });
      process.stdout.write(JSON.stringify(captured != null ? captured : { __nosubmit__: true }));
    } else {
      // Guard 5 — enforcement determinístico do sinal de confiança (pesquisador). No-op pros demais papéis.
      process.stdout.write(enforceSignal && researchState ? enforceSignal(textOf(res), researchState) : textOf(res));
    }
    // emite o custo do turno numa linha estruturada no stderr (o pai extrai; heartbeat \x1e solo segue por compat).
    if (usage) { try { process.stderr.write("\x1e#USAGE " + JSON.stringify(usage) + "\n"); } catch { /* ignore */ } }
  } catch (e) {
    process.stderr.write("worker erro: " + (e?.stack || e?.message || String(e)));
    process.exitCode = 1;
  } finally {
    try { await client?.stop(); } catch { /* ignore */ }
  }
})();
