// modo-auto — ENTRY. Núcleo hexagonal: core agnóstico + adapter de perfil.
//
// Toggle = RE-JOIN (provado por probe): o `ask_user` só é interceptável quando `onUserInputRequest`
// é passado NO `joinSession`. Então:
//   • base (OFF): join SÓ com a tool de controle → inerte (ask_user nativo, humano responde);
//   • ON: re-join COM `onUserInputRequest` (mesa responde) + `session.idle` (revisa o Stop).
// Controle na Fase 1 pela tool `modo_auto` (on/off/status); canvas toggle é slice à parte.

import { createOrchestrator } from "./src/core/orchestrator.mjs";
import { createModoAutonomo } from "./src/adapters/profiles/modoAutonomo.mjs";
import { buildAskHandler, buildAskUserOverrideTool, makeIdleHandler } from "./src/adapters/session/joinSessionAdapter.mjs";
import { acquireOrConnect as _acquireOrConnect, releaseClaim as _releaseClaim, updateOwnerInfo as _updateOwnerInfo, startHeartbeat as _startHeartbeat, setArmed as _setArmed } from "./src/adapters/session/askBridgeClaim.mjs";
import { createAskBridgeOwner as _createAskBridgeOwner, createAskBridgeResponder as _createAskBridgeResponder, registerWithOwner as _registerWithOwner } from "./src/adapters/session/askBridgeServer.mjs";
import { loadAskBridge } from "./src/adapters/session/askBridgeShared.mjs";
import { DEFAULTS as ASK_DEFAULTS } from "./src/adapters/session/askBridgeProtocol.mjs";
import { abReport, f2Report, f4Threshold, rolloutAlert } from "./src/adapters/review/rolloutGate.mjs";
import { createRolloutFlags } from "./src/adapters/review/rolloutFlags.mjs";
import { auditSpans, formatSpanAudit } from "./src/adapters/activity/spanSchema.mjs";
import { checkSetup, formatSetup, FIX_COMMAND } from "./src/adapters/health/setupCheck.mjs";
import { pruneWorkerSessions, formatPrune } from "./src/adapters/agents/workerConfigPrune.mjs";
import { readProvenance, formatProvenance } from "./src/adapters/health/buildProvenance.mjs";
import { createToggleState } from "./src/toggle/state.mjs";
import { createMemoryPort } from "./src/adapters/memory/memoryPort.mjs";
import { projectIdStrength, detectarEscopoSuspeito, resolveProjectIdWithProvenance } from "./src/adapters/memory/projectId.mjs";
import { avisoMemoria, statusMemoriaCurto } from "./src/adapters/memory/memoryNotice.mjs";
import { createPlanPort } from "./src/adapters/plan/planPort.mjs";
import { createAgentFactory } from "./src/adapters/agents/agentFactory.mjs";
import { createMesa } from "./src/adapters/agents/mesa.mjs";
import { createGatePort } from "./src/adapters/gates/gatePort.mjs";
import { createModoAdr } from "./src/adapters/profiles/modoAdr.mjs";
import { createAdrNudge } from "./src/adapters/adr/adrNudge.mjs";
import { createModoDev } from "./src/adapters/profiles/modoDev.mjs";
import { validateCatalog } from "./src/adapters/skills/catalog.mjs";
import { createPipeline } from "./src/adapters/pipeline/pipeline.mjs";
import { slice, inferDeps } from "./src/adapters/pipeline/slicer.mjs";
import { probeAvailableModels } from "./src/adapters/models/modelProbe.mjs";
import { createModelRouter } from "./src/adapters/models/modelRouter.mjs";
import { createScopePort } from "./src/adapters/scope/scopePort.mjs";
import { createModoScopo } from "./src/adapters/profiles/modoScopo.mjs";
import { createModoReuso } from "./src/adapters/profiles/modoReuso.mjs";
import { createModoSeguranca } from "./src/adapters/profiles/modoSeguranca.mjs";
import { createCodeAnalysis } from "./src/adapters/scope/codeAnalysis.mjs";
import { createDeepPanel } from "./src/adapters/review/deepPanel.mjs";
import { createShadowConsolidator } from "./src/adapters/shadow/shadowConsolidator.mjs";
import { createModoSombra } from "./src/adapters/shadow/modoSombra.mjs";
import { createShadowVerifier } from "./src/adapters/shadow/shadowVerifier.mjs";
import { resolveRepoRoot } from "./src/adapters/shadow/verifyTools.mjs";
import { createFindingsTracker } from "./src/adapters/shadow/findingsTracker.mjs";
import { formatContestation } from "./src/adapters/shadow/contestationView.mjs";
import { loadMemoryPlugin, isUsable } from "./src/adapters/plugin/pluginBridge.mjs";
import { createEmbedder } from "./src/adapters/embed/embedder.mjs";
import { workers, setWorkerLog } from "./src/adapters/util/workerRegistry.mjs";
import { spawn } from "node:child_process";
import { renderGuideText } from "./src/adapters/canvas/guide.mjs";
import { ModoAutoPanel, PANEL_CANVAS_ID, PANEL_INSTANCE_ID, PANEL_TITLE } from "./src/adapters/canvas/panel.mjs";
import { installBundledAgents } from "./src/adapters/agentInstall/installAgents.mjs";
import { createActivityRegistry } from "./src/adapters/activity/activityRegistry.mjs";
import { createTelemetrySink } from "./src/adapters/activity/telemetrySink.mjs";
import { gapsFromSink } from "./src/adapters/activity/gapDetector.mjs";
import { proposeImprovements } from "./src/adapters/activity/selfImprove.mjs";
import { injectionPrecision, lowPrecisionGap } from "./src/adapters/activity/injectionTracker.mjs";
import { aggregateCost, formatCostLine, renderCostReport } from "./src/adapters/activity/costMeter.mjs";
import { routeSpan, aggregateRoutes, formatRouteLine, routeAlert, routeAlertThrottled, ROUTE_WINDOW_MS, ROUTE_ALERT_THROTTLE_MS } from "./src/adapters/adr/routerTelemetry.mjs";
import { createDeliveryLedger } from "./src/adapters/activity/deliveryLedger.mjs";
import { readBrief } from "./src/adapters/util/briefFile.mjs";
import { createProposalStore, improvementNudge, maxStartedAt, nudgeThrottled } from "./src/adapters/activity/proposalStore.mjs";
import { createLiveMesa } from "./src/adapters/agents/liveMesa.mjs";
import { createLiveWorker } from "./src/adapters/agents/liveWorkerClient.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, readFileSync as fsReadFileSync, existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url)); // pasta do plugin (p/ agentes empacotados)

// ask-bridge: bindings MUTÁVEIS — default = BUNDLED (este plugin). No 1º boot, initAskBridge() chama
// loadAskBridge() e, se a lib COMPARTILHADA (~/.ask-bridge/lib) for major-compatível, troca para as fns de lá
// (fonte única cross-plugin). Falha/incompat → fica no bundled, sinalizado (FAIL LOUD no log). Nunca silencioso.
let acquireOrConnect = _acquireOrConnect, releaseClaim = _releaseClaim, updateOwnerInfo = _updateOwnerInfo, startHeartbeat = _startHeartbeat, setArmed = _setArmed;
let createAskBridgeOwner = _createAskBridgeOwner, createAskBridgeResponder = _createAskBridgeResponder, registerWithOwner = _registerWithOwner;
let askBridgeSource = "bundled", askBridgeVersion = null, _askBridgeInit = null;
function initAskBridge(log = () => {}) {
  if (_askBridgeInit) return _askBridgeInit;
  _askBridgeInit = (async () => {
    try {
      const r = await loadAskBridge({ log });
      const a = r?.api || {};
      if (a.acquireOrConnect) acquireOrConnect = a.acquireOrConnect;
      if (a.setArmed) setArmed = a.setArmed;
      if (a.releaseClaim) releaseClaim = a.releaseClaim;
      if (a.updateOwnerInfo) updateOwnerInfo = a.updateOwnerInfo;
      if (a.startHeartbeat) startHeartbeat = a.startHeartbeat;
      if (a.createAskBridgeOwner) createAskBridgeOwner = a.createAskBridgeOwner;
      if (a.createAskBridgeResponder) createAskBridgeResponder = a.createAskBridgeResponder;
      if (a.registerWithOwner) registerWithOwner = a.registerWithOwner;
      askBridgeSource = r?.source || "bundled"; askBridgeVersion = r?.version || null;
      log(`[modo-auto] ask-bridge: fonte=${askBridgeSource} versão=${askBridgeVersion || "?"}${r?.reason ? " (" + r.reason + ")" : ""}`);
    } catch (e) { log("[modo-auto] initAskBridge falhou (segue com BUNDLED): " + (e?.message || e)); }
  })();
  return _askBridgeInit;
}

// Startup FAIL LOUD: o catálogo de skills precisa estar ÍNTEGRO (skills existem no disco, bundles/gates
// resolvem) ANTES de qualquer injeção. Se estiver quebrado, a extensão falha AQUI — nunca silenciosa.
validateCatalog();

// Toggles conscientes (todas OFF por padrão). Chaveadas por sessão: nascem pelo env (fallback) e são
// RE-CHAVEADAS pela sessionId REAL do host em reflect() (ver `rekeyed`), pra não vazar entre sessões.
const state = createToggleState(process.env.SESSION_ID || "");
const deepState = createToggleState(process.env.SESSION_ID || "", { key: "deep" }); // modo PROFUNDO (painel multi-família), OFF default
const shadowState = createToggleState(process.env.SESSION_ID || "", { key: "shadow" }); // modo SOMBRA (contestação background), OFF default

let hostSession = null;
let rekeyed = false;   // toggles/nudge já re-chaveadas pela sessionId real? (1ª join só)
let idleOff = null;
let sdk = null; // { joinSession, approveAll } — só fora do smoke
let modelRouter = null; // roteador de modelo por capacidade (montado no startup após probar os disponíveis)
let pluginMem = null;   // MemoryClient do plugin copilot-memory (reuso), se instalado — senão null (fallback vendado)
const logHost = (m) => { try { hostSession?.log?.("[modo-auto] " + m); } catch { /* ignore */ } };
// RAIZ dos dados do modo-auto (telemetria/entregas/propostas/shadow). Overridável por env → permite auditar o
// fluxo REAL extension→tools→export num diretório isolado (o smoke tools-export aponta pra um tmp e invoca as tools
// exportadas). Default inalterado (~/.modo-auto) — retrocompat.
const MODO_HOME = process.env.MODO_AUTO_HOME || pathJoin(homedir(), ".modo-auto");
setWorkerLog(logHost); // o registro de workers loga o residual de tree-kill pelo host (FAIL-LOUD)

// MemoryPort: usa o MemoryClient do PLUGIN quando presente (single source of truth); senão o vendado (default).
const memory = createMemoryPort({ cwdProvider: () => process.cwd(), clientFactory: (url) => pluginMem ? new pluginMem(url) : null, log: logHost });
const plan = createPlanPort({ sessionProvider: () => hostSession, log: logHost });   // PlanPort → plan.md/transcript
const telemetry = createTelemetrySink({ dir: pathJoin(MODO_HOME, "telemetry"), log: logHost }); // persistência determinística dos spans (histórico p/ auto-melhoria)
const proposals = createProposalStore({ dir: pathJoin(MODO_HOME, "proposals"), log: logHost }); // store DEDICADO das propostas de auto-melhoria (dedup + cursor/watermark)
const rolloutFlags = createRolloutFlags({ dir: MODO_HOME, log: logHost }); // flags F1/F2/F4 PERSISTIDAS (ligáveis por tool — env não é acionável dentro do app)
const activity = createActivityRegistry({ onEnd: (span) => telemetry.persist(span), log: logHost }); // observabilidade dos workers (painel) + telemetria persistida
// EFICÁCIA (GAP 2): persiste o VEREDITO de uma fase do modo-dev como span v2 (stage dev-verdict) — o gapDetector
// mede rounds/escalate/exhausted. Fonte ÚNICA (DRY) usada por modo_dev E pelo pipeline. Aritmética pura (Princípio 11).
const recordVerdict = (v) => telemetry.persist({ stage: "dev-verdict", status: v?.pass ? "done" : "fail", role: "tech-lead", startedAt: Date.now(), traceId: v?.gid || null, group: v?.gid || null, taskType: v?.taskType || null, spanVersion: 2, verdict: v || null });
const factory = createAgentFactory({ cwdProvider: () => process.cwd(), getRouter: () => modelRouter, activity, log: logHost }); // AgentFactoryPort → workers (modelo roteado + registro)
// MOTOR DA MESA VIVA (debate round-robin turno a turno): cada agente é uma sessão Copilot viva.
// MEMÓRIA CRAVADA AQUI, e não em cada perfil: este é o gargalo por onde TODO agente de mesa nasce (modo_adr,
// modo_dev, modo_reuso, modo_seguranca, sombra). Ligar perfil a perfil seria repetir a regra em N lugares e
// deixar o N+1 nascer cego — que foi exatamente o defeito que uma auditoria pegou: eu havia ligado a memória só
// no caminho de FALLBACK do modo_adr, e o caminho VIVO (o que de fato roda) continuava sem.
// O escopo é resolvido UMA vez, pelo processo pai, com o cwd da SESSÃO. Sem plugin/escopo → null → sem tool.
//
// E O HUMANO PRECISA SABER DISSO. Antes, a mesa rodando SEM memória era indistinguível da mesa rodando COM: o
// modelo recebia um JSON que dizia "indisponível", mas o dono via só o resultado e não tinha como saber que a
// deliberação foi feita às cegas. Degradação silenciosa para o usuário é o mesmo defeito que passei a sessão
// caçando no código — só que na camada de cima. O aviso sai UMA vez por processo (não a cada worker, senão vira
// ruído) e diz o motivo E o conserto.
let avisouEscopo = false;
/**
 * Status da memória em UMA linha, para viajar no RESULTADO das tools da mesa. O aviso longo continua no log
 * (útil pra depurar), mas o log da sessão do host é INVISÍVEL numa sessão por voz/daemon — que é justamente
 * como este produto é usado. Se o dono não vê, a mesa cega continua parecendo igual à informada, e o aviso não
 * cumpriu a função. O resultado da tool é o canal que ele de fato recebe.
 */
const statusMesa = () => {
  let escopo = null, origem = "?", suspeita = null;
  try {
    const p = resolveProjectIdWithProvenance(process.cwd());
    escopo = p.projectId; origem = p.source;
    // A suspeita vem da MESMA chamada — nada de deduzir depois, que era o defeito que este conserto matou.
    suspeita = { risco: p.risco, alternativa: p.alternativa };
  } catch { /* sem escopo → statusMemoriaCurto já diz "indisponível" */ }
  return statusMemoriaCurto({ escopo, origem, suspeita });
};
const memoryScopeParaMesa = () => {
  let escopo = null, motivo = "";
  try { escopo = memory.projectId() || null; }
  catch (e) { motivo = e?.message || String(e); }
  if (!avisouEscopo) {
    avisouEscopo = true;
    const origem = escopo ? (() => { try { return projectIdStrength(process.cwd()); } catch { return "?"; } })() : "?";
    const suspeita = escopo ? (() => { try { return detectarEscopoSuspeito(process.cwd()); } catch { return null; } })() : null;
    logHost(avisoMemoria({ escopo, origem, motivo, suspeita }).texto);
  }
  return escopo;
};
const liveMesa = createLiveMesa((a) => createLiveWorker({ ...a, cwd: process.cwd(), memoryScope: memoryScopeParaMesa(), log: logHost }), { order: ["tecnico", "pesquisador", "negocio", "advogado-diabo", "revisor", "facilitador"], log: logHost });
const gate = createGatePort({ factory, log: logHost });                              // GatePort → skills reais (F4)
const adr = createModoAdr({ log: logHost });                                         // perfil modo-adr (planejamento; usa a mesa VIVA via caps)
const dev = createModoDev({ log: logHost });                                         // perfil modo-dev (build + gates de código)
const pipeline = createPipeline({ dev, log: logHost });                              // pipeline paralela (fatiador + git-flow + merge)
let scope = createScopePort({ cwdProvider: () => process.cwd(), log: logHost });     // ScopePort → grafo (plugin > vendado) | garimpo manual
const scopo = createModoScopo({ log: logHost });                                     // perfil modo-scopo (mesa de análise de escopo)
const codeAnalysis = createCodeAnalysis({ log: logHost });                           // evidência determinística (jscpd/depcheck), opcional
const reuso = createModoReuso({ log: logHost });                                     // perfil modo-reuso (análise de reúso/enxugamento → ADR lean via OTF)
const seguranca = createModoSeguranca({ log: logHost });                             // perfil modo-seguranca (auditoria SAST → ADR de segurança via OTF)
const deep = createDeepPanel({ factory, memoryScopeProvider: memoryScopeParaMesa, log: logHost }); // painel de consenso multi-família (escopo no gargalo)ti-família (modo profundo, opt-in)
const shadowConsolidator = createShadowConsolidator({ log: logHost });               // consolidador do modo-sombra (dossiê de contestação)
const sombra = createModoSombra({ consolidator: shadowConsolidator, log: logHost }); // perfil modo-sombra (contestação background + pré-ADR)
const embedder = createEmbedder({ log: logHost });                                   // embedder DEDICADO do sombra (drift determinístico, isolado do servidor)
// REFORMA DO SOMBRA (Fases 4-7): o VERIFICADOR (tools read-only, cap/cooldown) e o TRACKER de findings
// (hash + dedup + máquina de estados, file-backed por sessão). O tracker é lazy/memoizado por sessionId (o id
// só existe em call-time); reseta ao (re)ligar o sombra. É o que tira a cegueira EM PRODUÇÃO (não mais dead code).
let shadowVerifierInst = null, findingsInst = null, findingsSid = null, deliveryInst = null, deliverySid = null;
function currentSid() { return hostSession?.sessionId || process.env.SESSION_ID || ("proc-" + process.pid); }
// LEDGER de ENTREGAS (GAP 3 — aceitação POR AÇÃO): file-backed por sessão (mesmo padrão do findingsTracker). A
// próxima entrega aceita as anteriores; rejeição é explícita (modo_aceite). Determinístico, sem timer.
function getDeliveries() {
  const sid = currentSid();
  if (deliveryInst && deliverySid === sid) return deliveryInst;
  const dir = pathJoin(MODO_HOME, "deliveries"); try { fsMkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const file = pathJoin(dir, `deliveries-${String(sid).replace(/[^\w.-]/g, "_")}.jsonl`);
  deliveryInst = createDeliveryLedger({
    append: (line) => { try { appendFileSync(file, line); } catch (e) { logHost("[entregas] append falhou (sinalizado): " + (e?.message || e)); } },
    readAll: () => { try { return fsExistsSync(file) ? fsReadFileSync(file, "utf8") : ""; } catch { return ""; } },
    log: logHost,
  });
  deliverySid = sid; return deliveryInst;
}
// registra uma entrega da mesa (best-effort SINALIZADO — telemetria de aceitação nunca derruba a entrega real).
// Também emite um SPAN de telemetria (stage:"delivery", SEM role → fora do custo) p/ a aceitação ficar VISÍVEL no
// mesmo stream do gapDetector (GAP 3a: acceptance no span, não só no ledger próprio). Cruzamento custo×aceitação fica
// possível pela leitura unificada dos spans; correlação por traceId da deliberação é incremento futuro (sinalizado).
async function recordDelivery(artifact, kind) {
  try {
    const r = await getDeliveries().deliver(artifact, { kind });
    try { const m = getDeliveries().metrics(); telemetry.persist({ stage: "delivery", status: "done", startedAt: Date.now(), spanVersion: 2, delivery: { kind, hash: r?.hash || null, deep: deepState.get(), accepted: r?.accepted?.length || 0, acceptanceRate: m.precision, resolved: m.resolved, rejected: m.rejected } }); } catch { /* span é enriquecimento */ }
    return r;
  } catch (e) { logHost(`[entregas] recordDelivery falhou (sinalizado): ${e?.message || e}`); return null; }
}
function getVerifier() {
  if (!shadowVerifierInst) {
    const root = resolveRepoRoot(process.cwd());
    if (!root) logHost(`[verifier] AVISO: cwd '${process.cwd()}' NÃO é raiz de repo git → verificação git DEGRADA sinalizada (tracked/commits = null, NUNCA falso "não existe/untracked").`);
    else if (root !== process.cwd()) logHost(`[verifier] repo-root resolvido: ${root} (cwd era ${process.cwd()})`);
    shadowVerifierInst = createShadowVerifier({ repo: root || process.cwd(), log: logHost });
  }
  return shadowVerifierInst;
}
function getFindings() {
  const sid = currentSid();
  if (findingsInst && findingsSid === sid) return findingsInst;
  const dir = pathJoin(MODO_HOME, "shadow"); try { fsMkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const file = pathJoin(dir, `findings-${String(sid).replace(/[^\w.-]/g, "_")}.jsonl`);
  findingsInst = createFindingsTracker({
    append: (line) => { try { appendFileSync(file, line); } catch (e) { logHost("[findings] append falhou (sinalizado): " + (e?.message || e)); } },
    readAll: () => { try { return fsExistsSync(file) ? fsReadFileSync(file, "utf8") : ""; } catch { return ""; } },
    embedder, log: logHost,
  });
  findingsSid = sid; return findingsInst;
}
const mesa = createMesa({ factory, memory, plan, gate, log: logHost });              // orquestração da mesa (F3/F4)
const profile = createModoAutonomo({ log: logHost });          // adapter de PERFIL (v1)
const orch = createOrchestrator({ profile, caps: {
  memory, plan, factory, mesa, gate, adr, dev, deep, liveMesa, embedder,
  get router() { return modelRouter; },        // resolvido em call-time (setado no startup)
  deepEnabled: () => deepState.get(),           // modo profundo é opt-in, off por padrão — escolha consciente
  // COOPERAÇÃO modo-auto × modo-sombra: o onStop reusa o dossiê JÁ consolidado do sombra (cache, sem LLM) quando
  // o sombra está ligado. sombra off → null (retrocompat). Só leitura do cache — não dispara consolidação.
  sombraDossier: () => (shadowState.get() ? sombra.getDossier() : null),
}, log: logHost }); // NÚCLEO + caps

const adrNudge = createAdrNudge({ sessionId: process.env.SESSION_ID || "", log: logHost });

// Caps do modo-sombra (background): deep-research ON por padrão neste perfil (a decisão consciente é ligar o sombra).
// liveMesa: no HANDOFF (focal) a contestação vira mesa viva; o onTurn de background segue leve (ephemeral).
const sombraCaps = () => ({ factory, plan, memory, scope, deep, embedder, liveMesa,
  verifier: getVerifier(),      // Fase 4-5: verifica alegações binárias com tools read-only antes de emitir
  findings: getFindings(),      // Fase 3-6: hash + dedup + máquina de estados (mata a re-emissão)
  sessionId: () => hostSession?.sessionId || process.env.SESSION_ID || ("proc-" + process.pid),
  // Este span NÃO passa pelo activityRegistry (não é chamada de LLM), então nada carimbava `id` nem
  // `spanVersion`: os 238 registros existentes eram inanalisáveis por identidade (não dá para juntar com
  // outras fontes nem deduplicar). Carimbamos aqui os mesmos campos que o registry garante nos demais.
  recordConsolidation: (rec) => telemetry.persist({
    id: "cons-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    spanVersion: 3,
    stage: "sombra-consolidation", status: "done", startedAt: Date.now(), ...rec,
  }),
  get router() { return modelRouter; } });

// Painel canvas ENXUTO: reflete o estado ao vivo dos 3 interruptores e delega o flip ao MESMO caminho
// dos tools (applyToggle). SDK-free/testável; o `canvas` (wrapper do host) é criado no guard do startup.
let canvas = null;
const panel = new ModoAutoPanel({
  stateProvider: () => ({ auto: state.get(), deep: deepState.get(), sombra: shadowState.get() }),
  onToggle: (key, value) => applyToggle(key, value),
  activityProvider: () => activity.snapshot(),
  log: logHost,
});

// FONTE ÚNICA do flip dos interruptores (tools E painel usam) — mantém o comportamento idêntico:
// modo-auto re-join (reflect); sombra reseta o dossiê ao ligar; deep é lido em call-time. FAIL LOUD.
async function applyToggle(key, value) {
  const v = !!value;
  if (key === "auto") { state.set(v); requestReflect(); return v; }
  if (key === "deep") { deepState.set(v); return v; }
  if (key === "sombra") { shadowState.set(v); if (v) { sombra.reset(); shadowVerifierInst = null; findingsInst = null; findingsSid = null; } return v; }
  throw new Error("applyToggle: chave desconhecida " + key);
}

// Surfacing do modo-adr: SessionStart injeta a diretriz LEVE; prompt-submit re-injeta THROTTLED
// (anti-repeat) — rede de segurança contra a compactação. NÃO depende do toggle do modo-auto.
export const hooks = {
  onSessionStart: async () => {
    const parts = [];
    const d = adrNudge.onStart(); if (d) parts.push(d);
    // AUTO-MELHORIA (nudge por watermark + THROTTLE): se há spans NOVOS desde a última análise E passou a janela
    // de throttle desde o último nudge, sugere rodar (evita cutucar toda sessão se o usuário ignorar).
    try {
      const spans = telemetry.read({});
      const cur = proposals.getCursor();
      const n = nudgeThrottled(improvementNudge(spans, cur.ts), cur.lastNudgedTs);
      if (n) { parts.push(n); proposals.markNudged(Date.now()); }
      // MONITOR+ALERTA (humano no loop) do roteador ADR: se as rotas saíram da faixa saudável, surfaça um alerta
      // ACIONÁVEL — mas com JANELA DESLIZANTE (14d, anti-congelamento) e COOLDOWN (re-emite só se o conjunto de sinais
      // mudou ou passou 24h, anti alert-fatigue). Reusa os spans e o cursor (cur) já lidos. Best-effort.
      const { emit: routeEmit, sig: routeSig } = routeAlertThrottled(
        aggregateRoutes(spans, { windowMs: ROUTE_WINDOW_MS }),
        { lastSig: cur.lastRouteAlertSig, lastTs: cur.lastRouteAlertTs },
      );
      if (routeEmit) { parts.push(routeEmit); proposals.markRouteAlert(Date.now(), routeSig); }
      // ROLLOUT das fases de melhoria (F1/F2/F4): o go/no-go deixa de depender de LEMBRAR de rodar `modo_rollout`.
      // Quando a amostra fecha, o veredito ACIONÁVEL vem sozinho no início da sessão — com o MESMO cooldown por
      // assinatura (re-emite só se a decisão MUDOU ou passou 24h). Best-effort SINALIZADO.
      const fl0 = rolloutFlags.get();
      const ra = rolloutAlert(spans, { f1On: fl0.f1, f2Ms: fl0.f2BudgetMs, f4On: fl0.f4 });
      if (ra.emit && (ra.sig !== cur.lastRolloutAlertSig || Date.now() - (cur.lastRolloutAlertTs || 0) >= ROUTE_ALERT_THROTTLE_MS)) {
        parts.push(ra.emit);
        proposals.markRolloutAlert(Date.now(), ra.sig);
      }
    } catch (e) { logHost("[auto-melhoria] nudge onStart falhou (sinalizado): " + (e?.message || e)); }
    // AUTOCURA DE SETUP: os WORKERS da mesa usam o CLI do npm global (não o binário auto-atualizado do app). Se
    // estiver atrás, a mesa AVISA com o conserto — CLI velho = conpty velho = popup de assertion sob o spawn
    // rápido de workers, que é justamente o que a mesa faz. Best-effort e SEM cooldown de 24h: um setup quebrado
    // não deve ser silenciado (o aviso some sozinho quando o conserto é feito).
    try {
      const setup = checkSetup();
      if (setup.message) parts.push(setup.message);
    } catch (e) { logHost("[setup] autodiagnóstico falhou (sinalizado): " + (e?.message || e)); }
    // HIGIENE: sessão de worker é fire-and-die e nada as removia (medido: 6135 pastas órfãs). Poda por
    // idade no início da sessão — barato, e lixo acumulado mascara estado. Nunca derruba o boot.
    try {
      const pr = pruneWorkerSessions();
      if (pr.removed || !pr.ok) logHost("[prune] " + formatPrune(pr));
    } catch (e) { logHost("[prune] poda de sessões de worker falhou (sinalizado): " + (e?.message || e)); }
    return parts.length ? { additionalContext: parts.join("\n\n") } : undefined;
  },
  onUserPromptSubmitted: async () => {
    const parts = [];
    const nudge = adrNudge.onPrompt(); if (nudge) parts.push(nudge);
    // MODO-SOMBRA (opt-in): boundary de turno NÃO-BLOQUEANTE — surfaça um flag de drift PENDENTE se houver.
    if (shadowState.get()) {
      try {
        const flag = sombra.onTurn(sombraCaps(), { deep: true });
        if (flag) {
          parts.push(formatContestation(flag)); // Fase 3: proveniência legível (base da leitura + [alvo]/[fontes]/[citação parcial] por finding)
        }
        // FAIL-LOUD (anti-lixo-silencioso): se a MINHA precisão acumulada está baixa com amostra suficiente, AVISO
        // em vez de seguir injetando ruído calado — o próprio sombra sinaliza que pode estar errando e sugere calibrar.
        const m = getFindings().metrics();
        if (m.lowPrecision) parts.push(`[modo-sombra — AUTOCRÍTICA] minha precisão está BAIXA: ${(m.precision * 100).toFixed(0)}% em ${m.decided} decisões (alvo ${m.target * 100}%). Muitos findings viraram falso-positivo. Trate minhas contestações com MAIS ceticismo e considere elevar o threshold (modo_sombra) — não quero te empurrar ruído.`);
      } catch (e) { logHost("[modo-sombra] onTurn falhou (sinalizado): " + (e?.message || e)); }
    }
    return parts.length ? { additionalContext: parts.join("\n\n") } : undefined;
  },
};

// Tool de controle do modo (por sessão).
export const tools = [
  {
    name: "modo_auto",
    description:
      "Liga/desliga o MODO AUTONOMO (a mesa responde os ask_user e revisa os Stop) SO nesta sessao. " +
      "action: 'on' liga, 'off' desliga, 'status' consulta. Inerte por padrao.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["on", "off", "status"], description: "on|off|status" } },
      required: ["action"],
    },
    handler: async ({ action }) => {
      if (action === "on") { await applyToggle("auto", true); return ok(`LIGADO (perfil ${profile.id}).`); }
      if (action === "off") { await applyToggle("auto", false); return ok("DESLIGADO (inerte)."); }
      // STATUS HONESTO (Princípio 10, fail-loud): reporta o ARME REAL (sessão joinada + idle fiado), não só o
      // flag do toggle. Se o toggle está ON mas o listener de idle NÃO está fiado (ex.: reload deixou inerte),
      // AUTO-CURA re-armando via reflect(). Assim o status nunca mente "LIGADO" enquanto o gate de Stop está morto.
      const armed = state.get();
      if (!armed) return ok(`DESLIGADO (inerte) — perfil ${profile.id}.`);
      // ON: se há re-join pendente (toggle recém-mudado) ou a sessão ainda não subiu, o arme aplica no FIM deste
      // turno (re-join roda no idle, fora do turno — é o que evita o travamento). Honesto, não trava.
      if (reflectPending || !hostSession) { requestReflect(); logHost("[modo-auto] status: ON, arme pendente → aplica no idle (fim do turno)"); return ok(`LIGADO — o arme (interceptação de ask_user + gate de parada) aplica no FIM deste turno; o re-join roda fora do turno pra NÃO travar. Cheque o status no próximo turno pra confirmar.`); }
      const askMsg = askBridge.role === "owner"
        ? (askBridge.dispatch
          ? "ATIVA (dono da rota; servidor de dispatch UP — mesa + respondedores por first-to-answer)"
          : "⚠️ PARCIAL (dono, mas o servidor de dispatch NÃO subiu → só self-dispatch da mesa; respondedores externos não conectam — ver log)")
        : askBridge.role === "responder"          ? (askBridge.registered
            ? `via respondedor (registrado no dono '${askBridge.owner?.extensionId || "?"}' — a mesa responde por dispatch)`
            : `⚠️ INDISPONÍVEL (não registrei no dono: ${askBridge.reason || "?"})`)
          : askBridge.role === "clashed-fallback"
            ? "⚠️ INDISPONÍVEL (clash inesperado — fallback sem override; ver log)"
            : "off";
      // SAÚDE DO SETUP na mesma linha: o status não pode dizer "armado" e esconder que os WORKERS vão rodar num
      // CLI velho (é o que gera o popup de assertion). Sinalizado só quando há problema; degradação nunca cala.
      let setupMsg = "";
      try { const c = checkSetup(); if (c.stale || c.reason === "worker-sdk-nao-encontrado") setupMsg = ` ⚠️ SETUP: ${formatSetup(c)} — rode modo_setup.`; } catch { /* diagnóstico é enriquecimento */ }
      return ok(`LIGADO e ARMADO (perfil ${profile.id}) — gate de parada fiado no idle (revisa entrega × plano, barra parada incompleta). Interceptação de ask_user: ${askMsg}. ask-bridge: fonte=${askBridgeSource}${askBridgeVersion ? " v" + askBridgeVersion : ""}.${setupMsg}`);
    },
  },
  {
    name: "modo_adr",
    description:
      "MODO ADR (planejamento): dado um BRIEFING, um ROTEADOR DE COMPLEXIDADE decide o caminho (express/mini/full) " +
      "e roda a mesa de ADR (fundamentada na memoria/reuso) para ESCREVER o plano vivo em fases. Plano simples nao " +
      "paga a mesa inteira. Use ANTES de construir algo que precise de plano (implementacao, refactor, fix, " +
      "detalhamento, incremento). Force o caminho com `mesa` (auto|express|mini|full) se quiser. IMPORTANTE: para " +
      "brief COMPLETO, ESCREVA o briefing num ARQUIVO na pasta da sessao e passe o CAMINHO em `briefingPath` (a " +
      "mesa le o arquivo). NAO cole o briefing grande inline — texto grande quebra. `briefing` inline so p/ curto.",
    parameters: {
      type: "object",
      properties: {
        briefingPath: { type: "string", description: "CAMINHO do arquivo com o briefing (RECOMENDADO p/ brief completo — a mesa le o arquivo; sem escaping/limite)" },
        briefing: { type: "string", description: "briefing INLINE (fallback so p/ texto curto; p/ brief grande use briefingPath)" },
        mesa: { type: "string", enum: ["auto", "express", "mini", "full"], description: "roteador de complexidade: auto (triagem decide o caminho), express (só documentador, 0 debate), mini (3 papeis, 1 volta), full (6 papeis, 2-4 voltas). Default auto." },
      },
      required: [],
    },
    handler: async ({ briefingPath, briefing: briefingInline, mesa }) => {
      let briefing;
      try { briefing = readBrief({ path: briefingPath, inline: briefingInline, cwd: process.cwd(), label: "briefing", log: logHost }); }
      catch (e) { return { ok: false, error: `modo_adr: ${e?.message || e}` }; }
      const r = await adr.buildPlan(briefing, { factory, memory, plan, deep, router: modelRouter, liveMesa, embedder, onRoute: (d) => { try { telemetry.persist(routeSpan(d)); } catch (e) { logHost("[modo_adr] route telemetry falhou (sinalizado): " + (e?.message || e)); } } }, { deep: deepState.get(), mesa: mesa || "auto" });
      if (!r.ok) return ok(`ADR falhou: ${r.error || "erro"}`);
      const dv = r.deepReview ? `\n\n[validação PROFUNDA — painel ${r.deepReview.families.join("+")}] ${r.deepReview.pass ? "plano sólido" : "riscos corroborados:\n- " + r.deepReview.findings.join("\n- ")}` : "";
      const caminho = r.path ? `triagem: ${r.tier || "?"} → ${r.path === "express" ? "EXPRESSO (sem debate)" : r.path === "mini" ? "mesa-mini (3 papéis, 1 volta)" : "mesa completa"}${r.triageSource && r.triageSource !== "deterministic" ? " [" + r.triageSource + "]" : ""}` : "";
      const meta = r.engine === "viva" ? ` (mesa viva: ${r.rounds} voltas, convergiu=${r.converged})` : "";
      await recordDelivery((briefing || "").slice(0, 120) + " → " + (r.plan || "").slice(0, 200), "plano"); // GAP 3: entrega (aceite por ação)
      return okMesa(`plano do ADR gerado${r.written ? " (gravado em adr-plan.md — LEIA-o e incorpore ao SEU plan.md; a mesa ADR NÃO toca no plan.md da sessão)" : ""}${caminho ? " — " + caminho : ""}${meta}:\n\n${r.plan}${dv}`);
    },
  },
  {
    name: "modo_dev",
    description:
      "MODO DEV (build por TDD): dada uma FASE do plano, roda o time fixo (tester RED -> developer GREEN " +
      "-> gates de codigo -> QA -> tech-lead) e devolve o TESTE, a IMPL e o veredito pass/mustFix/escalate. " +
      "Use pra construir cada fase.",
    parameters: {
      type: "object",
      properties: {
        phase: { type: "string", description: "a fase do plano a construir" },
        taskType: { type: "string", description: "opcional: tipo da tarefa (api, auth, data, research, refactor, feature, docs, critical…) — escopa as skills injetadas + os gates" },
        maxRounds: { type: "number", description: "opcional: máximo de rodadas de revisão→correção→re-revisão (default 4). O mesmo revisor roda no máx 2× e então rotaciona (anti-viés)." },
        deep: { type: "boolean", description: "opcional: modo PROFUNDO — veredito por painel de consenso multi-família (paralelo). Custa muito mais token; default segue o toggle modo_deep." },
      },
      required: ["phase"],
    },
    handler: async ({ phase, taskType, maxRounds, deep: deepArg }) => {
      const useDeep = deepArg != null ? !!deepArg : deepState.get();
      const r = await dev.develop(phase, { gate, factory, memory, router: modelRouter, deep, recordVerdict, telemetryRead: () => telemetry.read({}), rolloutFlags }, { taskType, maxRounds, deep: useDeep });
      if (!r.ok) return ok(`modo-dev falhou: ${r.error || "erro"}`);
      const status = r.pass ? "PASSOU" : (r.exhausted ? "REPROVOU (esgotou rodadas)" : "REPROVOU");
      const fix = r.mustFix.length ? "\nCorrigir:\n- " + r.mustFix.join("\n- ") : "";
      const esc = r.escalate ? "\nESCALAR ao orquestrador: " + r.escalate : "";
      await recordDelivery(String(phase).slice(0, 120) + " → impl " + (r.pass ? "PASSOU" : "REPROVOU") + " em " + r.rounds + " rodada(s)", "impl"); // GAP 3: entrega (aceite por ação)
      return okMesa(`modo-dev [${status}] (TDD, ${r.rounds} rodada(s)${useDeep ? ", PROFUNDO" : ""})${fix}${esc}\n\nTESTE (RED):\n${r.artifacts.test}\n\nIMPL (GREEN):\n${r.artifacts.impl}`);
    },
  },
  {
    name: "fatiar",
    description:
      "FATIADOR (preview, NÃO muta nada): dadas as FASES do plano, o fatiador infere as dependências reais " +
      "e devolve os GRUPOS de execução (o que roda em paralelo vs sequencial). Use pra ver o plano de " +
      "paralelização antes de executar a pipeline.",
    parameters: {
      type: "object",
      properties: {
        phases: {
          type: "array", description: "fases do plano",
          items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        },
      },
      required: ["phases"],
    },
    handler: async ({ phases }) => {
      const r = await slice(phases, { factory });
      const linhas = r.groups.map((g, i) => `grupo ${i + 1} (${g.length === 1 ? "sequencial" : "paralelo"}): ${g.join(", ")}`).join("\n");
      return ok(`fatiador: ${phases.length} fases → ${r.groups.length} grupos (paralelo=${r.parallel}, largura máx=${r.maxWidth})\n${linhas}\n\ndeps=${JSON.stringify(r.deps)}`);
    },
  },
  {
    name: "modo_pipeline",
    description:
      "MODO PIPELINE (EXECUTA, muta git): fatia o plano, cria um worktree por braço (isolamento total), roda " +
      "cada fase em paralelo pelo modo-dev, integra em develop resolvendo conflitos. O worktree da sessão NÃO " +
      "é tocado. Requer git (projeto folder → git init baseline). Use pra construir um plano multi-fase com paralelismo.",
    parameters: {
      type: "object",
      properties: {
        phases: {
          type: "array", description: "fases do plano { id, text }",
          items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        },
        deps: { type: "object", description: "opcional: dependências { fase: [deps] }; ausente → o fatiador infere" },
        taskType: { type: "string", description: "opcional: tipo da tarefa (escopa skills + gates)" },
      },
      required: ["phases"],
    },
    handler: async ({ phases, deps, taskType }) => {
      const d = deps || await inferDeps(phases, { factory });
      const r = await pipeline.run(phases, d, { factory, gate, memory, router: modelRouter, deep, mesa, recordVerdict }, { taskType, rootCwd: process.cwd(), deep: deepState.get() });
      const linhas = r.results.map((x) => `- ${x.id}: ${x.pass ? "PASSOU" : "REPROVOU"}`).join("\n");
      // Escalações resolvidas PELA MESA vs. as que exigem humano (o ponto do canal de escalação).
      const esc = (r.escalations || []).map((e) =>
        e.resolved
          ? `  ✓ ${e.id || "?"}: resolvida pela mesa → ${String(e.answer).slice(0, 200)}`
          : `  ⚠ ${e.id || "?"}: PRECISA DE HUMANO — ${e.question}`
      ).join("\n");
      const escBloco = esc ? `\nEscalações (${r.escalations.length}, ${(r.forHuman || []).length} p/ humano):\n${esc}` : "";
      const passou = r.results.filter((x) => x.pass).length;
      await recordDelivery(`pipeline: ${r.results.length} fases (${passou} ok) → ${r.integrationBranch}`, "pipeline"); // GAP 3: código construído = entregável
      return okMesa(`modo-pipeline: ${r.results.length} fases em ${r.groups.length} grupos (paralelo=${r.parallel}) → integradas em ${r.integrationBranch}\n${linhas}${escBloco}`);
    },
  },
  {
    name: "modo_reuso",
    description:
      "MODO REUSO (análise de reúso/enxugamento): mesa que analisa um código-base que escalou desorganizado e " +
      "devolve um ADR de refatoração ENXUTA. REUSA evidência DETERMINÍSTICA (grafo do scope + jscpd/depcheck p/ " +
      "clones e deps não usadas) + pesquisa EXTERNA (o crítico avalia libs como 'novo contratado' e mantém o custom " +
      "quando é melhor), delibera na mesa viva e sai na FORMA FIXA (OTF seed lean: hotspots, reúso interno, " +
      "alternativas externas, fases com CHARACTERIZATION TESTS, aceite com BENCHMARK). Enxugar sem quebrar. Use " +
      "quando for analisar/limpar um projeto — em vez de pedir manualmente anti-boilerplate + pesquisa a cada vez.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "a área/assunto do código a analisar p/ reúso e enxugamento" },
        root: { type: "string", description: "opcional: caminho do projeto (default: o aberto)" },
      },
      required: ["subject"],
    },
    handler: async ({ subject, root }) => {
      const r = await reuso.analyze(subject, { factory, liveMesa, scope, codeAnalysis, deep, embedder, root, get router() { return modelRouter; } }, { deep: deepState.get() });
      await recordDelivery(`reúso: ${String(subject).slice(0, 100)} → ADR ${r.phases ? r.phases.length + " fases" : "fallback"}`, "adr-reuso"); // GAP 3: ADR = entregável
      return okMesa(`modo-reuso [${r.engine}] (${r.rounds} voltas; ${r.phases ? r.phases.length + " fases" : "fallback"})\n\nEVIDÊNCIA:\n${r.evidence}\n\n=== ADR DE REÚSO ===\n${r.adr}`);
    },
  },
  {
    name: "modo_seguranca",
    description:
      "MODO SEGURANCA (auditoria de segurança): mesa que audita um código-base e devolve um ADR de correção " +
      "PRIORIZADO POR SEVERIDADE. REUSA evidência DETERMINÍSTICA (SAST: semgrep agnóstico + bandit p/ Python via " +
      "codeAnalysis) + pesquisa EXTERNA (CVE/advisory/OWASP), delibera na mesa viva com um TRIADOR que separa " +
      "verdadeiro-positivo explorável de FALSO-POSITIVO, e sai na FORMA FIXA (OTF seed security: superfície de " +
      "ataque, achados por severidade, triagem, controles existentes, fases que corrigem CRITICAL primeiro com " +
      "TESTE DE REGRESSÃO, aceite com RE-SCAN limpo). Gêmeo do modo_reuso, lente de AMEAÇAS. Use quando for " +
      "auditar segurança — em vez de pedir SAST + triagem manual a cada vez.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "a área/assunto do código a auditar (ex.: 'API de autenticação')" },
        root: { type: "string", description: "opcional: caminho do projeto (default: o aberto)" },
      },
      required: ["subject"],
    },
    handler: async ({ subject, root }) => {
      const r = await seguranca.analyze(subject, { factory, liveMesa, scope, codeAnalysis, deep, embedder, root, get router() { return modelRouter; } }, { deep: deepState.get() });
      await recordDelivery(`segurança: ${String(subject).slice(0, 100)} → ADR ${r.phases ? r.phases.length + " fases" : "fallback"}`, "adr-seguranca"); // GAP 3: ADR = entregável
      return okMesa(`modo-seguranca [${r.engine}] (${r.rounds} voltas; ${r.phases ? r.phases.length + " fases" : "fallback"})\n\nEVIDÊNCIA:\n${r.evidence}\n\n=== ADR DE SEGURANÇA ===\n${r.adr}`);
    },
  },
  {
    name: "modo_scopo",
    description:
      "MODO SCOPO (análise de escopo, só leitura): entende o código-base ATUAL antes de começar um trabalho — " +
      "REUSA o grafo semântico do memory server se disponível (senão garimpa manual, sinalizado), monta o mapa " +
      "(hubs + relevantes) e o analista devolve o que já EXISTE, o que REUSAR, ONDE tocar e as LACUNAS. " +
      "Use em projeto grande antes de planejar/implementar, pra não reinventar.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "o assunto/pedido a escopar" },
        root: { type: "string", description: "opcional: caminho de um projeto externo (default: o aberto)" },
      },
      required: ["subject"],
    },
    handler: async ({ subject, root }) => {
      const r = await scopo.analyze(subject, { scope, factory, memory }, { root });
      return okMesa(`modo-scopo [${r.strategy}${r.reason ? ":" + r.reason : ""}] (hubs=${r.map.hubs}, arquivos=${r.map.files}, nós=${r.map.nodes})\n\n${r.analysis}`);
    },
  },
  {
    name: "modo_deep",
    description:
      "Liga/desliga o MODO PROFUNDO (painel de consenso multi-família): quando ligado, o veredito das revisões " +
      "roda o MESMO material em famílias de modelo diferentes em paralelo e consolida (corroborado × isolado). " +
      "Custa MUITO mais token — OFF por padrão. Use 'on' pra tarefas pesadas (banco, segurança, conceito abstrato).",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["on", "off", "status"], description: "on|off|status" } }, required: ["action"] },
    handler: async ({ action }) => {
      if (action === "on") await applyToggle("deep", true);
      else if (action === "off") await applyToggle("deep", false);
      return ok(`modo profundo: ${deepState.get() ? "LIGADO (painel multi-família no veredito)" : "desligado (revisor único rotacionado)"}`);
    },
  },
  {
    name: "modo_melhoria",
    description:
      "MODO MELHORIA (auto-melhoria da mesa, só leitura + propostas): lê a TELEMETRIA real dos workers " +
      "(spans persistidos), detecta os GAPS determinísticos (falha, timeout/hang, latência, churn) e um " +
      "meta-agente PROPÕE melhorias CONCRETAS da mesa sob 3 gates (Princípio 11 tool-vs-agent, anti-boilerplate, " +
      "caminho-abc). NÃO auto-aplica — devolve propostas versionáveis (gate seu), deduplicadas e persistidas, e " +
      "avança o cursor (watermark) pro nudge saber o que já foi analisado. Use pra 'rodar a fase de auto-melhoria'.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "opcional: janela dos últimos N spans (default: todos do arquivo ativo)" } }, required: [] },
    handler: async ({ limit }) => {
      const spans = telemetry.read(limit ? { limit } : {});
      if (!spans.length) return ok("auto-melhoria: sem telemetria ainda (nenhum worker rodou). Rode a mesa (adr/dev/reuso…) e tente de novo.");
      const gaps = gapsFromSink(telemetry, limit ? { limit } : {});
      // F4 (loop de aprendizado do sombra): se a PRECISÃO das injeções na janela é baixa COM amostra suficiente,
      // injeta um gap sintético 'low-precision' (função PURA testável) → o selfImprove propõe (gate humano) elevar o threshold.
      const prec = injectionPrecision(spans, { windowSize: 10 });
      const lpg = lowPrecisionGap(prec);
      if (lpg) { gaps.gaps.push(lpg); gaps.counts["low-precision"] = (gaps.counts["low-precision"] || 0) + 1; }
      // runAgent = meta-agente capaz (system próprio; taskType research → modelo forte pelo router). Schema-aware (TOOL TEMPLATE).
      const metaSystem = "Você é o AGENTE DE AUTO-MELHORIA da mesa modo-auto. Analisa telemetria e propõe melhorias de processo. Estruture a saída CHAMANDO a tool submit_proposals.";
      const runAgent = (p, schema) => factory.run("auto-melhoria", p, { system: metaSystem, taskType: "research", timeoutMs: 150000, stage: "melhoria", ...(schema ? { schema, availableTools: [] } : {}) });
      let res;
      try { res = await proposeImprovements({ gaps, sample: spans.slice(-20), runAgent }, { log: logHost }); }
      catch (e) { return ok(`auto-melhoria FALHOU (sinalizado): ${e?.message || e}`); }
      const linhas = res.proposals.map((p, i) => `${i + 1}. [${p.kind}·${p.gate}] gap=${p.gap}\n   → ${p.change}${p.abc ? `\n   ABC: ${p.abc}` : ""}`).join("\n");
      const persisted = proposals.add(res.proposals);
      if (!persisted.ok) return ok(`modo-melhoria — gaps=${JSON.stringify(gaps.counts)}; ${res.proposals.length} proposta(s) GERADAS mas PERSISTÊNCIA FALHOU (sinalizado): ${persisted.error}. Cursor NÃO avançado.\n\n${linhas}`);
      // Avança o watermark SÓ num run COMPLETO (sem limit) e APÓS persistir — persist-then-commit. Um run com
      // `limit` é análise-alvo e NÃO marca os spans fora da janela como consumidos (evita desync do nudge).
      if (!limit) { const c = proposals.setCursor({ ts: maxStartedAt(spans) }); if (!c.ok) logHost(`[auto-melhoria] cursor não avançou (sinalizado): ${c.error}`); }
      const precLine = prec.precision != null ? `\n\nPrecisão do sombra (últimas ${prec.injections} injeções): ${(prec.precision * 100).toFixed(0)}% aceitas (${prec.accepted}/${prec.measured} medidas; ${prec.unmeasured} sem medição)` : (prec.injections ? `\n\nPrecisão do sombra: ${prec.injections} injeção(ões), nenhuma medível ainda (acumula)` : "");
      // 8º EIXO (investigar MAIS sinais): a auditoria de cobertura mostra o que a telemetria JÁ traz por tipo de
      // span e QUAIS campos faltam — assim a próxima decisão de instrumentação sai de dado, não de palpite.
      const auditLine = `\n\n${formatSpanAudit(auditSpans(spans))}`;
      return ok(`modo-melhoria — gaps=${JSON.stringify(gaps.counts)}; ${res.proposals.length} proposta(s) (${persisted.added} nova(s), ${persisted.duplicates} já conhecida(s); NÃO auto-aplicadas${limit ? "; run com limit → cursor mantido" : ""})\n\n${linhas || "(sem propostas — mesa saudável na janela)"}\n\nSíntese: ${res.summary || "-"}${precLine}${auditLine}`);
    },
  },
  {
    name: "modo_custo",
    description:
      "CUSTO da mesa (só leitura, aritmética determinística): responde 'quanto custou' — soma tokens (entrada/saída/" +
      "cache) e AIU dos workers, por RUN e total, a partir da telemetria. Custo NÃO-medido aparece SINALIZADO (nunca " +
      "zero fake). Use pra saber o gasto da última deliberação ou se o modo profundo/sombra se paga.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "opcional: janela dos últimos N spans (default: todos)" } }, required: [] },
    handler: async ({ limit }) => {
      try {
        const spans = telemetry.read(limit ? { limit } : {});
        return ok(renderCostReport(spans, (h) => { try { return getDeliveries().stateOf(h); } catch { return null; } }));
      } catch (e) { return { ok: false, error: `modo_custo: ${e?.message || e}` }; }
    },
  },
  {
    name: "modo_rotas",
    description:
      "TELEMETRIA do roteador de complexidade do ADR (só leitura, determinística): quantas decisões foram por " +
      "express|mini|full, % que caiu na zona cinzenta (ambíguo) e % que exigiu desempate LLM. Use pra ver se o " +
      "roteador está economizando a mesa (mais express/mini) e se o safety-net não está operando às cegas.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "opcional: janela dos últimos N spans (default: todos)" } }, required: [] },
    handler: async ({ limit }) => {
      try {
        const spans = telemetry.read(limit ? { limit } : {});
        const agg = aggregateRoutes(spans);
        if (!agg.total) return ok("ADR rotas: nenhuma decisão de roteamento registrada ainda (rode modo_adr).");
        const tiers = Object.entries(agg.byTier).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(" · ");
        const alert = routeAlert(agg);
        return ok(`${formatRouteLine(agg)}\n  por tier: ${tiers || "—"}\n  contagem: express ${agg.byPath.express} · mini ${agg.byPath.mini} · full ${agg.byPath.full} (total ${agg.total})` + (alert ? `\n  ${alert}` : `\n  saúde: OK (dentro da faixa; sem alerta)`));
      } catch (e) { return { ok: false, error: `modo_rotas: ${e?.message || e}` }; }
    },
  },
  {
    name: "modo_rollout",
    description:
      "RUNBOOK EXECUTÁVEL do rollout das fases de melhoria (F1 pré-filtro, F2 budget do ciclo, F4 gate de " +
      "complexidade): mostra o ESTADO das feature-flags, o A/B em andamento e o VEREDITO go/no-go MEDIDO nos " +
      "spans (p95 filtrado × controle + qualidade). Use pra saber SE e QUANDO ligar/desligar cada fase — em vez " +
      "de decidir no escuro. Só leitura, determinístico.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "set"], description: "status (padrão) = runbook + veredito; set = LIGA/DESLIGA as fases (persistido)" },
        f1: { type: "boolean", description: "set: liga/desliga o pré-filtro de diff do revisor (F1)" },
        bypassPct: { type: "number", description: "set: % de ciclos de CONTROLE do A/B do F1 (0..100, default 20)" },
        f2BudgetMs: { type: "number", description: "set: teto do CICLO de remediação em ms (0 = desligado)" },
        f4: { type: "boolean", description: "set: liga/desliga o gate de complexidade (F4)" },
        f4MaxLines: { type: "number", description: "set: override do threshold do F4 em linhas (0 = usa o P25 medido)" },
      },
      required: [],
    },
    handler: async ({ action, f1, bypassPct, f2BudgetMs, f4, f4MaxLines }) => {
      try {
        if (action === "set") {
          const patch = {};
          if (f1 != null) patch.f1 = f1;
          if (bypassPct != null) patch.bypassPct = bypassPct;
          if (f2BudgetMs != null) patch.f2BudgetMs = f2BudgetMs;
          if (f4 != null) patch.f4 = f4;
          if (f4MaxLines != null) patch.f4MaxLines = f4MaxLines;
          if (!Object.keys(patch).length) return { ok: false, error: "modo_rollout set: nada a mudar (passe f1/bypassPct/f2BudgetMs/f4/f4MaxLines)" };
          const r = rolloutFlags.set(patch);
          if (!r.ok) return { ok: false, error: `modo_rollout set: ${r.error}` };
          const fl = r.flags;
          return ok(`flags do rollout ATUALIZADAS (persistidas em ${rolloutFlags.path}):\n  F1 pré-filtro=${fl.f1 ? "ON (bypass " + fl.bypassPct + "%)" : "OFF"} · F2 budget=${fl.f2BudgetMs > 0 ? fl.f2BudgetMs + "ms" : "OFF"} · F4 gate=${fl.f4 ? "ON" + (fl.f4MaxLines ? " (limite " + fl.f4MaxLines + " linhas)" : " (P25 medido)") : "OFF"}\n  Valem a partir do PRÓXIMO ciclo de modo_dev. Rode \`modo_rollout\` após ~100 ciclos pro veredito go/no-go.`);
        }
        const spans = telemetry.read({});
        const fl = rolloutFlags.get();
        const f1On = fl.f1, f2 = fl.f2BudgetMs, f4On = fl.f4;
        const bypass = fl.bypassPct;
        const ab = abReport(spans);
        const f2r = f2Report(spans, { budgetMs: Number.isFinite(f2) && f2 > 0 ? f2 : null });
        const th = f4Threshold(spans, { override: fl.f4MaxLines || null });
        const linhas = [
          `FLAGS (fonte: ${fl.source}): F1 pré-filtro=${f1On ? "ON (bypass " + bypass + "%)" : "OFF"} · F2 budget do ciclo=${f2 > 0 ? f2 + "ms" : "OFF"} · F4 gate=${f4On ? "ON" : "OFF"}`,
          `F1 A/B: ${ab.ok ? `${ab.go ? "✅ GO" : "⛔ NO-GO"} — p95 filtrado ${ab.p95Filtered}ms × controle ${ab.p95Control}ms (ganho ${ab.gainPct}%), reprovação ${ab.failPctFiltered}% × ${ab.failPctControl}% · ${ab.filtered}/${ab.control} ciclos\n  → ${ab.verdict}` : `aguardando amostra (${ab.reason})`}`,
          `F2 budget: ${f2r.ok ? `${f2r.go ? "✅ GO" : "⛔ NO-GO"} — ${f2r.blown}/${f2r.cycles} ciclos cortados (${f2r.blownPct}%), p95 ${f2r.p95}ms${f2r.budgetMs ? " vs teto " + f2r.budgetMs + "ms" : ""}\n  → ${f2r.verdict}` : `aguardando amostra (${f2r.reason})`}`,
          `F4 threshold: ${th == null ? "indisponível — precisa de >= 500 spans v3 OU um override explícito (modo_rollout action=set f4MaxLines=n); gate NÃO atua (fallback seguro)" : Math.round(th) + " linhas" + (fl.f4MaxLines ? " (override do dono)" : " (P25 medido)")}`,
          `PROCEDIMENTO (prescrito pela mesa): 1) \`modo_rollout action=set f1=true\` (bypass 20%); 2) rodar >= 100 ciclos de modo_dev; ` +
          `3) rodar \`modo_rollout\`: GO → \`action=set bypassPct=5\`; NO-GO → \`action=set f1=false\`; 4) só então o F2 (\`action=set f2BudgetMs=<ms>\`); ` +
          `5) F4 só com 500 spans v3 (ou f4MaxLines explícito). F1+F2 juntas são BLOQUEADAS — sem isolar, não dá pra saber qual reverter.`,
        ];
        return ok(linhas.join("\n"));
      } catch (e) { return { ok: false, error: `modo_rollout: ${e?.message || e}` }; }
    },
  },
  {
    name: "modo_setup",
    description:
      "SAÚDE DO SETUP da mesa (autodiagnóstico + conserto guiado): os WORKERS da mesa NÃO usam o binário " +
      "auto-atualizado do app — eles resolvem o CLI @github/copilot pelo PATH (npm global), que fica para trás e " +
      "traz um conpty antigo (popup de assertion no spawn rápido de workers). action=status mostra as versões " +
      "medidas; action=fix roda a atualização (só quando não há workers da mesa rodando).",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["status", "fix"], description: "status (padrão) ou fix (atualiza o CLI global)" } },
      required: [],
    },
    handler: async ({ action }) => {
      try {
        const c = checkSetup();
        if (action !== "fix") {
          const extra = c.stale ? `\n  ${c.message}` : (c.reason === "worker-sdk-nao-encontrado" ? `\n  ${c.message}` : "\n  (a mesa vai spawnar workers no CLI atual)");
          // PROVENIÊNCIA: quem audita o runtime (mirror podado, sem .git e sem test/) não consegue distinguir
          // "o commit não existe" de "não dá pra medir daqui" — e conclui o primeiro. O carimbo responde isso.
          let prov = "";
          try { prov = `\n  ${formatProvenance(readProvenance(HERE))}`; } catch (e) { prov = `\n  proveniência do build: falha ao ler (sinalizado): ${e?.message || e}`; }
          let hyg = "";
          try { hyg = `\n  ${formatPrune(pruneWorkerSessions())}`; } catch (e) { hyg = `\n  poda: falhou (sinalizado): ${e?.message || e}`; }
          return ok(`${formatSetup(c)}${extra}\n  caminho do CLI dos workers: ${c.packageDir || "(não localizado)"}${prov}${hyg}`);
        }
        if (!c.stale) return ok(`nada a consertar — ${formatSetup(c)}`);
        // GUARDA: no Windows um .node EM USO não é sobrescrito. Se há worker vivo, o update falha pela metade.
        const vivos = typeof workers.size === "function" ? workers.size() : 0;
        if (vivos > 0) return { ok: false, error: `modo_setup fix: há ${vivos} worker(s) da mesa em execução — no Windows o .node em uso NÃO é sobrescrito. Espere as mesas terminarem (ou feche-as) e rode de novo.` };
        logHost(`[setup] aplicando conserto: ${FIX_COMMAND}`);
        const r = await new Promise((resolve) => {
          // Windows: desde o hardening do Node, spawnar um .cmd SEM shell dá EINVAL. Por isso shell:true aqui —
          // e os argumentos são CONSTANTES (nada vem do usuário), então não há superfície de injeção.
          const p = spawn("npm", ["i", "-g", "@github/copilot@latest"], { windowsHide: true, shell: true });
          let out = "", err = "";
          p.stdout.on("data", (d) => { out += d.toString(); });
          p.stderr.on("data", (d) => { err += d.toString(); });
          p.on("error", (e) => resolve({ code: -1, out, err: String(e?.message || e) }));
          p.on("close", (code) => resolve({ code, out, err }));
        });
        const depois = checkSetup();
        if (r.code !== 0) return { ok: false, error: `modo_setup fix: npm saiu com código ${r.code}. ${String(r.err || r.out).split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}` };
        return ok(`conserto aplicado (${FIX_COMMAND}).\n  antes: CLI v${c.workerVersion} · depois: CLI v${depois.workerVersion || "?"} (app v${depois.appVersion || "?"})\n  ${depois.stale ? "⚠️ AINDA desatualizado — verifique se outro copilot no PATH está na frente do npm global." : "✅ setup em dia."}`);
      } catch (e) { return { ok: false, error: `modo_setup: ${e?.message || e}` }; }
    },
  },
  {
    name: "modo_aceite",
    description:
      "ACEITAÇÃO das entregas da mesa (GAP 3, POR AÇÃO — não relógio): a próxima entrega ACEITA as anteriores (o " +
      "dono prosseguiu); rejeição é EXPLÍCITA. action=status mostra a taxa de aceitação + as entregas ABERTAS; " +
      "action=rejeitar + hash marca uma entrega como não-aceita. Determinístico, reusa o ledger de findings.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "rejeitar"], description: "status (padrão) ou rejeitar" },
        hash: { type: "string", description: "hash da entrega a rejeitar (de action=status)" },
      },
      required: [],
    },
    handler: async ({ action = "status", hash }) => {
      try {
        const led = getDeliveries();
        if (action === "rejeitar") {
          if (!hash) return { ok: false, error: "modo_aceite rejeitar: informe o hash da entrega (veja em action=status)" };
          const r = led.reject(String(hash));
          return ok(r.changed ? `entrega ${hash} → REJEITADA (não-aceita). A taxa de aceitação reflete isso.` : `entrega ${hash} já estava terminal (${r.state}) — sem mudança.`);
        }
        const m = led.metrics();
        const open = led.open();
        const rate = m.precision == null ? "sem entrega decidida ainda" : `${(m.precision * 100).toFixed(0)}% aceitas (${m.resolved}/${m.decided})`;
        const openList = open.length ? "\nAbertas (aguardando próxima ação ou rejeição):\n" + open.map((o) => `- [${o.hash}] ${o.text.slice(0, 90)}`).join("\n") : "\n(nenhuma entrega aberta)";
        return ok(`Aceitação das entregas (por AÇÃO — a próxima entrega aceita as anteriores; rejeição é explícita):\n  taxa: ${rate} · ${m.resolved} aceitas, ${m.rejected} rejeitadas${openList}`);
      } catch (e) { return { ok: false, error: `modo_aceite: ${e?.message || e}` }; }
    },
  },
  {
    name: "modo_guia",
    description:
      "GUIA do modo-auto (só leitura): explica ao usuário, em resumo COESO, o que o produto faz, os 3 " +
      "interruptores conscientes (modo-auto, profundo, sombra) e o estado ATUAL de cada um. Use quando o " +
      "usuário perguntar 'o que é isso / como funciona / o que ligar', ou no onboarding, ANTES de ligar nada.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      return ok(renderGuideText({ auto: state.get(), deep: deepState.get(), sombra: shadowState.get() }));
    },
  },
  {
    name: "modo_painel",
    description:
      "Abre o PAINEL visual (canvas) do modo-auto: mostra os 3 interruptores conscientes (modo-auto, modo " +
      "profundo, modo-sombra) com STATUS ao vivo + 1 parágrafo cada, e permite ligar/desligar cada um pelo " +
      "painel (mesmo efeito dos tools). Use quando o usuário quiser ver/controlar o estado visualmente.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      if (!canvas || !hostSession?.rpc?.canvas?.open) return ok("painel indisponível (canvas não registrado nesta sessão).");
      await panel.ensureServer();
      await hostSession.rpc.canvas.open({ canvasId: PANEL_CANVAS_ID, instanceId: PANEL_INSTANCE_ID });
      return ok("🧠 Painel do modo-auto aberto no canvas lateral.");
    },
  },
  {
    name: "modo_sombra",
    description:
      "Liga/desliga o MODO-SOMBRA (contestação anti-bajulação em background): um 2º cérebro isolado lê a conversa " +
      "(inclusive o que você resumiu por VOZ), questiona o que a sessão não questiona (público-alvo, dor real, o que " +
      "já existe, fit de arquitetura) e, se a base derrapar, solta um aviso SUGESTIVO na virada do turno. Roda deep-" +
      "research multi-família ON por padrão (custo elevado). OFF por padrão. Reativo — não interrompe o raciocínio.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["on", "off", "status"], description: "on|off|status" } }, required: ["action"] },
    handler: async ({ action }) => {
      if (action === "on") { await applyToggle("sombra", true); return ok("modo-sombra LIGADO ⚠️ AVISO: roda Deep Research multi-família POR PADRÃO — custo de token ELEVADO. Contesta em background e avisa só quando o drift for alto (sugestivo). Desligue com modo_sombra off."); }
      if (action === "off") { await applyToggle("sombra", false); return ok("modo-sombra desligado."); }
      let metricLine = "";
      if (shadowState.get()) { try { const m = getFindings().metrics(); const pTxt = m.precision == null ? "s/ decisão ainda" : `${(m.precision * 100).toFixed(0)}%` + (m.lowPrecision ? ` ⚠️ BAIXA (<${m.target * 100}% com N≥${m.minDecided}: ruído — eleve o threshold)` : m.significant ? " ✓" : ` (N=${m.decided}<${m.minDecided}: amostra insuficiente p/ julgar)`); metricLine = `\nfindings: ${m.total} (emitted ${m.emitted}, resolved ${m.resolved}, rejected ${m.rejected}, expired ${m.expired}) · precisão ${pTxt}`; } catch { /* ignore */ } }
      return ok(`modo-sombra: ${shadowState.get() ? "LIGADO (contestação background, verificador ON, deep-research ON)" : "desligado"}${metricLine}`);
    },
  },
  {
    name: "sombra_preadr",
    description:
      "HANDOFF do modo-sombra (pré-ADR): mande o PLANO/ideia que a sessão pretende construir; o agente sombra " +
      "compara com o dossiê de contestação que acumulou (perguntas críticas, reuso local/mercado, deep-research) e " +
      "devolve o VEREDITO (aprova/corrige) + um PRÉ-ADR. Use ANTES de ir pro modo_adr/modo_dev. Para plano COMPLETO, " +
      "ESCREVA num ARQUIVO da sessão e passe o CAMINHO em `planoPath` (a mesa lê o arquivo); `plano` inline só p/ curto.",
    parameters: {
      type: "object",
      properties: {
        planoPath: { type: "string", description: "CAMINHO do arquivo com o plano (RECOMENDADO p/ plano completo)" },
        plano: { type: "string", description: "plano INLINE (fallback só p/ texto curto)" },
      },
      required: [],
    },
    handler: async ({ planoPath, plano: planoInline }) => {
      let plano;
      try { plano = readBrief({ path: planoPath, inline: planoInline, cwd: process.cwd(), label: "plano", log: logHost }); }
      catch (e) { return { ok: false, error: `sombra_preadr: ${e?.message || e}` }; }
      const r = await sombra.handoff(plano, sombraCaps());
      const corr = r.corrections.length ? "\nCORREÇÕES antes de construir:\n- " + r.corrections.join("\n- ") : "";
      await recordDelivery(`pré-ADR: ${String(plano).slice(0, 100)} → ${r.approve ? "APROVA" : "REVISAR"}`, "pre-adr"); // GAP 3: pré-ADR = entregável
      return ok(`sombra pré-ADR [${r.approve ? "APROVA" : "REVISAR"} · drift ${r.drift}]${corr}\n\n=== PRÉ-ADR ===\n${r.preAdr}`);
    },
  },
  {
    name: "sombra_resolver",
    description:
      "Fecha o loop de uma contestação do modo-sombra: marca um achado (pelo HASH que veio na injeção, ex.: f-abc123) " +
      "como 'resolved' (você endereçou — terminal), 'rejected' (não procede — terminal) ou 'addressed' (acatado, em " +
      "andamento — NÃO-terminal, silencia a re-emissão mas ainda não conta na precisão). Assim o sombra NÃO re-emite " +
      "aquele achado e a precisão da contestação passa a ser medida. Use quando acatar OU descartar uma contestação.",
    parameters: {
      type: "object",
      properties: {
        hash: { type: "string", description: "o marcador do achado (ex.: f-1a2b3c...) que veio na contestação" },
        status: { type: "string", enum: ["resolved", "rejected", "addressed"], description: "resolved = endereçado (terminal); rejected = não procede (terminal); addressed = acatado, em andamento (não-terminal)" },
        reason: { type: "string", description: "opcional: por quê" },
      },
      required: ["hash", "status"],
    },
    handler: async ({ hash, status, reason }) => {
      if (!shadowState.get()) return ok("modo-sombra desligado — nada a resolver.");
      const st = String(status || "");
      if (!["resolved", "rejected", "addressed"].includes(st)) return { ok: false, error: `sombra_resolver: status inválido '${status}' — use resolved|rejected|addressed` };
      try {
        const r = getFindings().transition(String(hash), st, { turn: 0 });
        if (!r.changed) return ok(`achado ${hash} já estava terminal (${r.state}) — sem mudança.`);
        const tail = st === "addressed" ? "Marcado em andamento (não re-emitido); marque resolved/rejected ao concluir." : "O sombra não re-emitirá este achado.";
        return ok(`contestação ${hash} → ${r.state}${reason ? " (" + reason + ")" : ""}. ${tail}`);
      } catch (e) { return { ok: false, error: `sombra_resolver: ${e?.message || e}` }; }
    },
  },
  {
    name: "sombra_provenance",
    description:
      "AUDITORIA da proveniência do modo-sombra (só leitura): mostra, para os achados ATIVOS da sessão (ou UM por " +
      "`hash`), DE ONDE o sombra tirou cada contestação — o ALVO (plan|execution|premise), as FONTES " +
      "(type:path «snippet») e se a citação está completa/parcial/indeterminada. Use pra checar se o sombra está " +
      "olhando a coisa certa (leu o plano? qual fonte?) ANTES de acatar/rejeitar um achado.",
    parameters: {
      type: "object",
      properties: {
        hash: { type: "string", description: "opcional: o marcador de UM achado (ex.: f-1a2b3c); vazio = todos os ativos" },
      },
      required: [],
    },
    handler: async ({ hash } = {}) => {
      if (!shadowState.get()) return ok("modo-sombra desligado — sem proveniência a auditar.");
      try {
        const tracker = getFindings();
        const items = hash ? [tracker.get(String(hash))].filter(Boolean) : tracker.active();
        if (!items.length) return ok(hash ? `nenhum achado ativo com hash ${hash}.` : "nenhum achado ativo nesta sessão.");
        const fmt = (f) => {
          const srcs = Array.isArray(f.sources) && f.sources.length
            ? f.sources.map((s) => `${s.type}${s.path ? ":" + s.path : ""}${s.snippet ? " «" + String(s.snippet).slice(0, 80) + "»" : ""}`).join("; ")
            : "(sem fontes citadas)";
          const cit = f.citationComplete === true ? "completa" : f.citationComplete === false ? "PARCIAL" : "indeterminada (v1)";
          return `- [${f.hash}] alvo=${f.target || "unknown"} · citação ${cit}\n    ${f.text}\n    fontes: ${srcs}`;
        };
        return ok(`Proveniência dos achados${hash ? " " + hash : " ativos"} (${items.length}):\n` + items.map(fmt).join("\n"));
      } catch (e) { return { ok: false, error: `sombra_provenance: ${e?.message || e}` }; }
    },
  },
  {
    name: "deep_gate",
    description:
      "GATE PROFUNDO ad-hoc (só leitura): roda um material QUALQUER (plano, código ou conceito abstrato) por um " +
      "painel de consenso multi-família em paralelo e consolida os achados (corroborados por ≥2 famílias vs isolados). " +
      "Prova de conceito estruturada; custa mais token. Para material COMPLETO, ESCREVA num ARQUIVO da sessão e passe " +
      "o CAMINHO em `materialPath` (a mesa lê o arquivo); `material` inline só p/ texto curto.",
    parameters: {
      type: "object",
      properties: {
        materialPath: { type: "string", description: "CAMINHO do arquivo com o material (RECOMENDADO p/ material completo)" },
        material: { type: "string", description: "material INLINE (fallback só p/ texto curto)" },
        taskType: { type: "string", description: "opcional: tipo da tarefa (escopa as famílias/capacidade)" },
      },
      required: [],
    },
    handler: async ({ materialPath, material: materialInline, taskType }) => {
      let material;
      try { material = readBrief({ path: materialPath, inline: materialInline, cwd: process.cwd(), label: "material", log: logHost }); }
      catch (e) { return { ok: false, error: `deep_gate: ${e?.message || e}` }; }
      const critique = `Avalie CRITICAMENTE (adversarial) o material abaixo — fure premissas, riscos, segurança, casos-limite e lacunas. Liste achados CONCRETOS, curto.\n\nMATERIAL:\n${material}`;
      const dp = await deep.review({ material, critiquePrompt: critique, router: modelRouter, taskType, panelRole: "revisor" });
      if (!dp.ok) return ok(`deep-gate indisponível: ${dp.reason} (famílias: ${dp.families.join(", ") || "nenhuma"}). Precisa de ≥2 famílias de modelo liberadas.`);
      const fix = dp.verdict.findings.length ? "\nCORROBORADOS (corrigir):\n- " + dp.verdict.findings.join("\n- ") : "";
      const watch = dp.watch.length ? "\nISOLADOS (verificar):\n- " + dp.watch.join("\n- ") : "";
      const esc = dp.verdict.escalate ? "\nESCALAR: " + dp.verdict.escalate : "";
      return okMesa(`deep-gate [${dp.verdict.pass ? "PASSOU" : "REPROVOU"}] — painel ${dp.families.join("+")}${fix}${watch}${esc}`);
    },
  },
];
const ok = (msg) => ({ resultType: "success", textResultForLlm: "modo-auto: " + msg });
/**
 * Resultado de uma tool DELIBERATIVA (mesa/painel): carimba o status da memória na frente.
 *
 * Existe como wrapper e não como edição em cada tool porque carimbar em N lugares é exatamente o erro que já me
 * custou dois bugs nesta sessão — a tool N+1 nasce sem o carimbo e ninguém percebe. Aqui, quem delibera usa
 * `okMesa` e o status vem junto por construção.
 * Por que no RESULTADO e não no log: o log da sessão do host é invisível em voz/daemon (medido). Se o dono não
 * vê, a mesa cega continua parecendo igual à informada — que é o defeito inteiro.
 */
const okMesa = (msg) => ok(`${statusMesa()}\n${msg}`);

let askOverrideClashed = false; // true se o override de ask_user colidiu (fallback reativo do joinSessionResilient)
let askClaim = null;            // o claim do ask-bridge quando SOU o dono (p/ release no re-join/exit)
let askOwner = null;           // servidor de dispatch (Fase 2) quando SOU o dono
let askResponder = null;       // servidor /ask (Fase 2) quando sou respondedor
let askHeartbeatStop = null;   // para o timer de heartbeat do dono (gap Windows PID-recycle)
let askBridge = { role: "off", owner: null }; // "owner" | "responder" | "clashed-fallback" | "off"
const sessionKey = () => process.env.SESSION_ID || (hostSession && hostSession.sessionId) || "default";
// A mesa como RESPONDEDOR: recebe {question,choices,allowFreeform} e devolve a resposta (via orch.handleQuestion).
const mesaAnswer = async (p) => { try { const r = await orch.handleQuestion({ question: String(p?.question || ""), choices: Array.isArray(p?.choices) ? p.choices : [], allowFreeform: p?.allowFreeform !== false }); return { answer: r && typeof r.answer === "string" ? r.answer : null }; } catch (e) { logHost("[modo-auto] ask-bridge mesaAnswer erro (sinalizado): " + (e?.message || e)); return { answer: null }; } };
function closeAskServers() { try { askHeartbeatStop?.(); } catch { /* ignore */ } askHeartbeatStop = null; try { askOwner?.close(); } catch { /* ignore */ } try { askResponder?.close(); } catch { /* ignore */ } askOwner = null; askResponder = null; }

// joinSession RESILIENTE ao clash de tool: o override de ask_user (overridesBuiltInTool) só pode existir UMA vez
// por sessão. Se outra extensão (ex.: copilot-mobile com o celular armado) já o registrou, o joinSession LANÇA
// "ask_user already registered / name clash". Em vez de derrubar o modo-auto inteiro, re-junta com o toolset BASE
// (sem o override): o gate de Stop e os tools seguem; só a interceptação da mesa fica indisponível NESTA sessão
// (SINALIZADO). Erro que NÃO é clash SOBE (fail loud).
async function joinSessionResilient(joinFn, cfg, armed, baseTools) {
  try {
    askOverrideClashed = false;
    return await joinFn(cfg);
  } catch (e) {
    if (armed && /already registered|name clash/i.test(String(e?.message || e))) {
      logHost("[modo-auto] ask_user já tomado por outra extensão (clash — copilot-mobile ainda não participa do ask-bridge/Fase 2) → carregando SEM o override (SINALIZADO): " + (e?.message || e));
      askOverrideClashed = true;
      askBridge = { role: "clashed-fallback", owner: askBridge.owner || null };
      try { if (askClaim) { askClaim.release(); askClaim = null; } } catch { /* ignore */ } // NÃO sou o dono real (é o outro plugin) → solto o lockfile p/ não me anunciar como dono falso
      closeAskServers();
      return await joinFn({ ...cfg, tools: baseTools });
    }
    throw e;
  }
}

// RE-JOIN pendente: o toggle do modo-auto troca as TOOLS (override ask_user), o que EXIGE re-join (provado:
// registerTools dinâmico NÃO intercepta). Mas re-join DENTRO do turno da tool derruba o transporte → a tool trava.
// Então o toggle só MARCA `reflectPending`; o RE-JOIN roda no próximo `session.idle` (turno acabou → seguro). O
// handler de idle é MESTRE e registrado SEMPRE (mesmo OFF) pra poder consumir o pending quando OFF→ON.
let reflectPending = false;
const requestReflect = () => { reflectPending = true; };

// Reflete o estado ON/OFF via RE-JOIN. Idempotente. No smoke (sem SDK) só atualiza o estado.
async function reflect() {
  if (!sdk) return;
  reflectPending = false; // este reflect já aplica o estado atual → não há troca pendente após ele
  const { joinSession, approveAll } = sdk;
  try { idleOff?.(); } catch { /* ignore */ }
  idleOff = null;
  try { if (askClaim) { askClaim.release(); askClaim = null; } } catch { /* ignore */ } // solta o claim antes de re-juntar
  closeAskServers();
  askBridge = { role: "off", owner: null };
  // NÃO chama disconnect() aqui: disconnect() sinaliza ao app Copilot que a extensão quer encerrar →
  // ele REINICIA o processo inteiro (novo PID), matando o turno em curso. O joinSession abaixo
  // supersede a sessão antiga naturalmente. disconnect() permanece SÓ no deactivate() (shutdown real).
  const staleSession = hostSession;
  hostSession = null;
  const armed = state.get();
  const cfg = { onPermissionRequest: approveAll, tools, hooks };
  if (canvas) cfg.canvases = [canvas];   // painel registrado (criado no guard do startup)
  if (armed) {
    // Override do ask_user + coordenação ask-bridge. Mantém onUserInputRequest (belt-and-suspenders).
    cfg.onUserInputRequest = buildAskHandler(orch, { log: logHost });
    let claim = null;
    await initAskBridge(logHost); // troca p/ a lib COMPARTILHADA se compatível (idempotente, roda 1×)
    // SINAL DE CONTROLE AUTÔNOMO (protocolo 1.2.0): DECLARA que esta sessão é regida pela mesa. Plugins de RELAY
    // (whatsapp-bridge — bind de UMA sessão) devem CEDER a tecla do ask_user aqui. Regra do dono: sessão com
    // modo-auto ARMADO = a mesa responde; o relay atende as OUTRAS sessões. Best-effort SINALIZADO.
    try { setArmed(sessionKey(), true, { extensionId: "modo-auto" }); }
    catch (e) { logHost("[modo-auto] ask-bridge: setArmed falhou (sinalizado): " + (e?.message || e)); }
    try { claim = await acquireOrConnect(sessionKey(), { extensionId: "modo-auto" }); }
    catch (e) { logHost("[modo-auto] ask-bridge acquireOrConnect FALHOU (FAIL LOUD, sinalizado): " + (e?.message || e)); }
    if (!claim || claim.isOwner) {
      // DONO: sobe o servidor de dispatch (Fase 2), registra a MESA como respondedor local, grava porta/token no
      // owner.json (p/ respondedores conectarem), e o override DESPACHA (mesa local + remotos, first-to-answer).
      // Se o servidor não subir, degrada FAIL-LOUD p/ self-dispatch da mesa (Fase 1).
      askClaim = claim && claim.isOwner ? claim : null;
      let dispatchSrc = orch, dispatchUp = false;
      try {
        askOwner = createAskBridgeOwner({ log: logHost });
        const { port, token } = await askOwner.start();
        askOwner.addLocalResponder("modo-auto-mesa", mesaAnswer, 0);
        if (askClaim) updateOwnerInfo(sessionKey(), { loopbackPort: port, token });
        if (askClaim) { try { askHeartbeatStop = startHeartbeat(sessionKey()); } catch (e) { logHost("[modo-auto] ask-bridge: heartbeat NÃO iniciou (sinalizado): " + (e?.message || e)); } }
        dispatchSrc = { handleQuestion: async (q) => ({ answer: await askOwner.dispatch(q.question, q) }) };
        dispatchUp = true;
      } catch (e) { closeAskServers(); logHost("[modo-auto] ask-bridge: servidor de dispatch NÃO subiu (FAIL LOUD, sinalizado) → self-dispatch direto da mesa; respondedores externos NÃO conectam nesta sessão (owner.json SEM loopbackPort): " + (e?.message || e)); }
      cfg.tools = [...tools, buildAskUserOverrideTool(dispatchSrc, { log: logHost })];
      askBridge = { role: "owner", dispatch: dispatchUp, owner: claim?.owner || null };
    } else {
      // RESPONDEDOR: se o DONO participa do dispatch (owner.json tem loopbackPort/token), sobe /ask e registra a
      // mesa. Rastreia se REGISTROU de fato — o status NÃO mente (não diz "responde" se o registro falhou).
      const o = claim.owner || {};
      let responderOk = false, responderReason = "";
      if (o.loopbackPort && o.token) {
        try {
          askResponder = createAskBridgeResponder(mesaAnswer, { log: logHost });
          const { url } = await askResponder.start();
          // PRAZO DO RESPONDEDOR = quanto a MESA realmente leva pra deliberar. Era 60000 e ERA O BUG: o dono do
          // ask-bridge honra o answerTimeoutMs que o respondedor DECLARA (não impõe o dele), então a mesa pedia
          // pra ser cortada em 1 min e deliberava em mais que isso → "timeout:60000" no dispatch e a pergunta
          // caía no humano. MEDIDO no log do dono (2026-07-28): ask às 17:54:07 → corte às 17:55:07 (60s exatos).
          // Agora usa a janela canônica do protocolo (mesaAnswerTimeoutMs). first-to-answer segue valendo: se o
          // humano responder antes, ele ganha — o prazo maior NÃO atrasa ninguém, só evita o corte prematuro.
          await registerWithOwner(o.loopbackPort, o.token, { responderId: "modo-auto-mesa", url, priority: 0, answerTimeoutMs: ASK_DEFAULTS.mesaAnswerTimeoutMs });
          responderOk = true;
          logHost(`[modo-auto] ask-bridge: registrado como RESPONDEDOR no dono '${o.extensionId}' (a mesa responde via dispatch)`);
        } catch (e) { closeAskServers(); responderReason = "registro no dono falhou: " + (e?.message || e); logHost("[modo-auto] ask-bridge: registro no dono FALHOU (FAIL LOUD, sinalizado): " + (e?.message || e)); }
      } else {
        responderReason = `dono '${o.extensionId || "?"}' ainda NÃO participa do dispatch (Fase 2 pendente do lado dele)`;
        logHost(`[modo-auto] ask-bridge: ${responderReason} → a mesa não responde nesta sessão (sinalizado).`);
      }
      askBridge = { role: "responder", registered: responderOk, reason: responderReason, owner: o };
    }
  } else {
      // DESARMADO: retira o sinal — o relay (whatsapp) volta a valer nesta sessão (a tecla é dele de novo).
      try { setArmed(sessionKey(), false, { extensionId: "modo-auto" }); }
      catch (e) { logHost("[modo-auto] ask-bridge: setArmed(false) falhou (sinalizado): " + (e?.message || e)); }
  }
  hostSession = await joinSessionResilient(joinSession, cfg, armed, tools);
  // staleSession: NÃO chama disconnect() nem em background — o app Copilot trata qualquer disconnect()
  // desta extensão como sinal de encerramento e reinicia o processo. Deixa a sessão velha vazar/GC.
  // REKEY: assim que temos a sessionId REAL do host, re-chaveia as toggles/nudge por ela (o env pode não
  // vir → cairia no "default" compartilhado = vazamento entre sessões). Só na 1ª vez (rekeyed guard).
  if (!rekeyed && hostSession?.sessionId) {
    rekeyed = true;
    const sid = hostSession.sessionId;
    state.rekey(sid); deepState.rekey(sid); shadowState.rekey(sid); adrNudge.rekey(sid);
    // Se o estado persistido DESTA sessão difere do que usamos pra montar o cfg, re-reflete pra aplicar.
    if (state.get() !== armed) { logHost(`rekey → estado real da sessão difere; re-refletindo`); return reflect(); }
  }
  // Idle-mestre: registrado SEMPRE (armado ou não) — no fim de cada turno consome um RE-JOIN pendente (troca
  // ON/OFF do override ask_user) de forma SEGURA (turno acabou), e, quando armado, roda o gate de Stop. É o que
  // impede o travamento: o re-join nunca acontece dentro do turno da tool modo_auto.
  idleOff = hostSession.on("session.idle", makeIdleHandler({
    shouldReflect: () => reflectPending,
    onReflect: async () => { await reflect(); },
    isArmed: () => state.get(),
    handleStop: (a) => orch.handleStop(a),
    sendContinuation: (prompt) => hostSession.send({ prompt }),
    workspacePath: () => hostSession?.workspacePath,
    log: logHost,
  }));
  logHost(armed ? "ARMADO (re-join com handler + idle)" : "inerte (base sem handler)");
}

// UNLOAD — mata a ÁRVORE de todos os workers ainda vivos no descarregamento (senão o NETO pesado do SDK vaza
// órfão no reload/shutdown, ~300-450MB cada). Export PURO chamável pelo host; e via signal handler (SIGTERM/SIGINT)
// que é o gatilho REAL de encerramento do processo da extensão. Best-effort SINALIZADO, budget curto e coerente.
let _deactivating = false;
async function drainWorkers(reason) {
  if (_deactivating) return; _deactivating = true;
  const n = workers.size();
  if (n) logHost(`[deactivate] ${reason}: encerrando ${n} worker(s) vivo(s) por árvore`);
  try { const r = await workers.killAll({ budgetMs: 2500, perKillTimeout: 2000, drainMs: 1500 }); if (r.residual.length) logHost(`[deactivate] residual (não morreram): ${r.residual.join(",")}`); }
  catch (e) { logHost("[deactivate] killAll falhou (sinalizado): " + (e?.message || e)); }
}
export async function deactivate() { try { if (askClaim) askClaim.release(); } catch { /* ignore */ } try { releaseClaim(sessionKey()); } catch { /* ignore */ } closeAskServers(); await drainWorkers("deactivate"); try { await hostSession?.disconnect(); } catch { /* ignore */ } }

if (!process.env.MODO_AUTO_SMOKE) {
  const { joinSession, createCanvas } = await import("@github/copilot-sdk/extension");
  const { approveAll } = await import("@github/copilot-sdk");
  sdk = { joinSession, approveAll };
  // Canvas do painel: o server (ModoAutoPanel) é SDK-free/testável; createCanvas (host-only) só embrulha
  // o open() → sobe o server sob demanda e devolve {title,url}. Registrado em reflect() via cfg.canvases.
  try {
    canvas = createCanvas({
      id: PANEL_CANVAS_ID,
      displayName: "modo-auto",
      description: "Painel do modo-auto: os 3 interruptores conscientes (modo-auto, profundo, sombra) com status e liga/desliga.",
      open: async () => { await panel.ensureServer(); return { title: PANEL_TITLE, url: panel.url }; },
    });
  } catch (e) { logHost(`AVISO — canvas do painel não registrado (${e?.message || e}); tools seguem funcionando.`); }
  // O plugin TRAZ seu agente de sessão: instala os .agent.md empacotados na pasta global (~/.copilot/agents/).
  // Best-effort SINALIZADO — falhar aqui não derruba a extensão (é enriquecimento).
  try {
    const rep = installBundledAgents(pathJoin(HERE, "agents"), { log: logHost });
    const changed = [...rep.installed, ...rep.updated];
    if (changed.length) logHost(`agentes do plugin instalados em ${rep.dir}: ${changed.join(", ")} (reinicie a sessão p/ selecioná-los)`);
    if (rep.errors.length) logHost(`AVISO — install de agente com erros (sinalizado): ${rep.errors.map((e) => e.name).join(", ")}`);
  } catch (e) { logHost(`AVISO — install de agentes falhou (sinalizado): ${e?.message || e}`); }
  // Roteamento de modelo: prova os modelos LIBERADOS na assinatura e monta o router por capacidade.
  // Falha do probe = modo degradado SINALIZADO (worker cai no default), não silêncio nem crash.
  try {
    const models = await probeAvailableModels({ cwd: process.cwd() });
    modelRouter = createModelRouter({ available: models, log: logHost });
    logHost(`modelos disponíveis (${models.filter((m) => m.enabled !== false).length}): ${modelRouter.available().join(", ")}`);
  } catch (e) {
    logHost(`AVISO — probe de modelos falhou (${e?.message || e}); sem roteamento, worker usa o modelo default.`);
  }
  // REUSO do plugin copilot-memory (dependência OPCIONAL): se instalado, o modo-auto usa o graphClient e o
  // MemoryClient DELE (single source of truth); senão, mantém os clients vendados. O servidor fica agnóstico.
  try {
    const p = await loadMemoryPlugin({ log: logHost });
    if (isUsable(p)) {
      scope = createScopePort({ cwdProvider: () => process.cwd(), graph: p.graph, log: logHost }); // grafo do PLUGIN
      pluginMem = p.client.MemoryClient;                                                            // MemoryClient do PLUGIN
      logHost(`REUSO ativo: grafo + memória via plugin copilot-memory v${p.version}`);
    } else {
      logHost(`plugin copilot-memory ausente/indisponível → clients vendados (sem dependência)`);
    }
  } catch (e) {
    logHost(`AVISO — resolução do plugin falhou (${e?.message || e}); clients vendados.`);
  }
  await reflect(); // join inicial refletindo o estado persistido (inerte se OFF)
  // Encerramento do PROCESSO da extensão (host manda SIGTERM/SIGINT no reload/shutdown): drena a árvore dos workers
  // ANTES de sair, senão os netos do SDK ficam órfãos. process.once = dispara 1×; sai depois do budget curto.
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => { try { releaseClaim(sessionKey()); } catch { /* ignore */ } drainWorkers(sig).finally(() => process.exit(0)); });
}
