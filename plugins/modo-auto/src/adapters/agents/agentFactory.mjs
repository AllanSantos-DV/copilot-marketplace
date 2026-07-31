// AgentFactoryPort — cria/reusa PAPÉIS e roda cada um como sub-agente headless (worker de node
// LIMPO). É o que permite a mesa: N papéis (fixos + dinâmicos) rodando em paralelo, cada um com seu
// system prompt. Reusa o catálogo; cria papel dinâmico quando o pré-análise pede um fora dele.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getRole, dynamicRole, CORE_ROLES } from "./roles.mjs";
import { envDoWorker } from "./workerLib.mjs";
import { validarEscopoInjetado, assinarEscopo, segredoDoProcesso } from "../memory/memoryTools.mjs";
import { designRole } from "./architect.mjs";
import { SKILLS_ROOT, composeSystem } from "../skills/skillLoader.mjs";
import { resolveNode } from "../util/resolveNode.mjs";
import { workers } from "../util/workerRegistry.mjs";
import { createUsageChannel } from "./usageChannel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "worker.mjs");

// Credencial PINADA no carregamento do módulo — momento em que a extensão roda como filha do app e o
// token injetado por ele está garantidamente presente. Fixar aqui (em memória, nunca em disco) é o que
// torna os workers IMUNES a um shell que zerou GH_TOKEN depois. Ver o comentário no spawn.
const PINNED_AUTH_TOKEN = String(process.env.GH_TOKEN || "").trim() || null;

// CONTEXTO DE TELEMETRIA da deliberação em curso. Medido: `taskType` chegava em ~1,4% dos spans, o que INVALIDA
// qualquer análise causal (não dá para comparar variantes do revisor sem saber o TIPO da tarefa). A causa não era
// o registro — ele já aceita o campo — e sim que passá-lo dependia de lembrar em ~31 pontos de chamada; e os que
// mais produzem span (deepPanel: 1545, sombra: 539) simplesmente não passavam.
//
// POR QUE AsyncLocalStorage e não uma variável de módulo: o modo-sombra roda EM PARALELO com a mesa. Um contexto
// global seria uma CORRIDA — a consolidação do sombra sobrescreveria o contexto do modo_dev e carimbaria spans com
// o taskType errado, que é PIOR que campo nulo (dado errado passa por dado bom numa análise). ALS dá escopo por
// cadeia assíncrona: cada deliberação enxerga o SEU contexto, sem vazar para a vizinha.
import { AsyncLocalStorage } from "node:async_hooks";
const RUN_ALS = new AsyncLocalStorage();

/** Executa `fn` com o contexto de telemetria da deliberação. Todo worker disparado dentro dela herda. */
export function withRunContext(ctx, fn) { return RUN_ALS.run({ ...(ctx || {}) }, fn); }
/** Contexto da deliberação atual (vazio fora de uma). Sempre CÓPIA — mutar o retorno não contamina. */
export function getRunContext() { return { ...(RUN_ALS.getStore() || {}) }; }

// Limpa o stderr do worker p/ o diagnóstico: descarta o RUÍDO do Node (ExperimentalWarning do node:sqlite
// do CLI, dicas de --trace-warnings) que MASCARAVA o erro real (aparecia no lugar do "worker erro:"/timeout).
// Prefere a linha "worker erro:" quando existe; senão devolve as linhas úteis. Recorta a 300 chars.
export function cleanStderr(raw) {
  const NOISE = /ExperimentalWarning|--trace-warnings|is an experimental feature|\bnode:sqlite\b|DeprecationWarning/i;
  const lines = String(raw || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  const i = lines.findIndex((l) => /worker erro:/i.test(l));
  const useful = i >= 0 ? lines.slice(i) : lines;
  return useful.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
}

// Teto anti-ZUMBI do processo filho (backstop do PAI, NÃO relógio de turno): o child auto-encerra no silêncio
// real via o próprio heartbeat (~idleGrace); este cap só pega um PROCESSO que travou e não saiu. DOIS caminhos
// EXPLÍCITOS: (1) `maxWallMs` FINITO → `maxWallMs + 60s` (buffer p/ o child abortar sozinho antes); (2) SEM
// limite de parede (default `Infinity` = indeterminado) → `HARD_CAP_MS` constante (30 min). Pura/testável.
export const WORKER_HARD_CAP_MS = 30 * 60 * 1000;
/**
 * Teto do killer do PAI (backstop anti-zumbi).
 * @param {number} maxWallMs  limite absoluto de parede; `Infinity`/ausente = sem limite (default).
 * @param {number} [hardCapMs] teto usado quando não há limite de parede.
 * @returns {number} `maxWallMs + 60s` quando finito; senão `WORKER_HARD_CAP_MS` (30 min).
 * SÓ é usado quando o dono pede um TETO DE PAREDE EXPLÍCITO (maxWallMs finito). No default (Infinity), o PAI
 * NÃO usa relógio de parede — usa o reaper POR ATIVIDADE (computeParentIdle). Pura/testável.
 */
export function computeParentCap(maxWallMs, hardCapMs = WORKER_HARD_CAP_MS) {
  return Number.isFinite(maxWallMs) ? maxWallMs + 60000 : hardCapMs;
}
// IDLE do reaper do PAI (CONTROLE POR ATIVIDADE, não relógio de turno): quanto tempo o filho pode ficar
// TOTALMENTE MUDO (sem 1 byte/heartbeat) antes de ser considerado ZUMBI. Reseta a cada atividade do filho, então
// um agente que TRABALHA nunca é morto por tempo decorrido. Generoso: > idle-grace do filho (que dispara antes).
export const PARENT_IDLE_FLOOR_MS = 4 * 60 * 1000;
export function computeParentIdle(childIdleMs, floor = PARENT_IDLE_FLOOR_MS) {
  return Math.max(floor, (Number(childIdleMs) || 0) + 120000);
}

/**
 * @param {{ cwdProvider?: ()=>string, model?: string, getRouter?: ()=>object|null, activity?: object|null, log?: (m:string)=>void }} [opts]
 *   activity: registro de atividade OPCIONAL (observabilidade do painel) — no-op se ausente.
 * @returns {import("../../core/ports.mjs").AgentFactoryPort}
 */
export function createAgentFactory({ cwdProvider = () => process.cwd(), model, getRouter = () => null, activity = null, memoryScopeProvider = null, log = () => {} } = {}) {
  const catalog = new Map();
  for (const id of CORE_ROLES) { const r = getRole(id); if (r) catalog.set(id, r); }

  const get = (id) => catalog.get(id) || getRole(id) || null;
  const create = (id, subject) => { const r = dynamicRole(id, subject || id); catalog.set(id, r); log(`papel dinâmico criado: ${id}`); return r; };
  // DESENHO de papel dinâmico pelo ARQUITETO (substitui o template). Reusa se já existe. FAIL LOUD.
  const design = async (id, subject) => {
    const existing = get(id);
    if (existing && existing.kind === "designed") return existing;
    const coverage = [...catalog.values()].map((r) => r.title).filter(Boolean);
    const role = await designRole(id, subject, { factory: api, coverage }); // erro SOBE
    catalog.set(id, role);
    log(`papel desenhado pelo arquiteto: ${id} (${role.title})`);
    return role;
  };

  // Roda UM papel com um prompt → { ok, role, title, text, error? }. Spawna node LIMPO (worker).
  // opts.system sobrescreve o system do papel; opts.skills (nomes de skills globais) são INJETADAS no
  // system; opts.skillDirectories carrega skills nativas; opts.cwd roda o worker num diretório específico;
  // opts.model força um modelo; senão o ROUTER escolhe por capacidade (papel + opts.taskType).
  function run(roleId, prompt, { subject, timeoutMs = 200000, maxWallMs = Infinity, system, skillDirectories, skills, cwd, model: modelOverride, taskType, reasoningEffort, stage, group, topic, traceId, availableTools, schema, semMemoria = false } = {}) {
    // Papel resolvido: do catálogo/registro; senão, shell APENAS quando há `system` explícito (ex.: gate).
    // Sem papel e sem system → FAIL LOUD (nada de template silencioso; papéis dinâmicos usam factory.design).
    const role = get(roleId) || (system ? { id: roleId, title: roleId, kind: "shell", system } : null);
    if (!role) throw new Error(`agentFactory.run: papel '${roleId}' nao existe e nenhum system foi fornecido (papeis dinamicos: use factory.design)`);
    let sys = system || role.system;
    let skillDirs = skillDirectories;
    if (Array.isArray(skills) && skills.length) {
      sys = composeSystem(sys, skills); // FAIL LOUD: skill ausente → LANÇA
      skillDirs = skillDirs || [SKILLS_ROOT];
    }
    // Roteamento de modelo por CAPACIDADE (papel + tipo de tarefa) quando não vier modelo explícito.
    let chosenModel = modelOverride || model;
    let effort = reasoningEffort;
    if (!modelOverride) {
      const router = getRouter?.();
      if (router) {
        const r = router.route({ role: roleId, taskType }); // FAIL LOUD dentro do router
        chosenModel = r.model;
        if (effort == null) effort = r.reasoningEffort || undefined;
      }
    }
    // Observabilidade (opcional, no-op se ausente): registra o worker no painel. `end` grava em TODOS os
    // caminhos de conclusão (via finish) — spawn error, timeout, close, stdin error.
    const ctx = getRunContext();
    const act = activity ? activity.start({ role: roleId, taskType: taskType || ctx.taskType || null, model: chosenModel || null, stage: stage || ctx.stage || null, group: group || null, topic: topic || ctx.topic || null, traceId: traceId || ctx.traceId || null }) : null;
    return new Promise((resolve) => {
      // ENV pelo CHOKE POINT ÚNICO (`envDoWorker`), em ALLOWLIST. Antes era `{...process.env}` + deletes: uma
      // variável NOVA (segredo, config, escopo de outro produto) chegava ao filho por padrão, e a proteção
      // dependia de alguém lembrar de excluí-la. Agora nasce bloqueada. E a regra é a MESMA do liveWorkerClient
      // — a duplicação entre os dois spawners já produziu o mesmo bug duas vezes nesta sessão.
      const env = envDoWorker({
        extras: {
          // O segredo é o que permite ao filho VERIFICAR a assinatura do escopo (que viaja no job, por stdin).
          MODO_AUTO_SCOPE_SECRET: segredoDoProcesso(),
          MODO_AUTO_WORKER_CWD: cwd || cwdProvider(),
          ...(chosenModel ? { MODO_AUTO_WORKER_MODEL: chosenModel } : {}),
        },
      });
      // ISOLAMENTO — MEDIDO, não presumido. Testei apontar COPILOT_HOME/XDG_CONFIG_HOME para ~/.copilot com o
      // `configDirectory` isolado: o worker NÃO vazou nenhuma extensão do usuário. Ou seja, este CLI **não honra
      // essas variáveis** e elas NÃO servem de segunda linha de defesa — seria falsa sensação de segurança
      // deixá-las aqui comentadas como "defesa em profundidade". Quem isola de verdade é a opção
      // `configDirectory` do createSession, e por isso o worker VERIFICA o efeito dela após criar a sessão
      // (ver a checagem de isolamento em worker.mjs) em vez de confiar na assinatura da API.
      env.MODO_AUTO_WORKER_CONFIGDIR = env.MODO_AUTO_WORKER_CONFIGDIR || join(homedir(), ".modo-auto", "worker-config");
      // CREDENCIAL PINADA (não herdada do shell do momento). O worker autentica pelo GH_TOKEN que o app
      // injeta; um shell que zerou essa variável — gesto CORRETO e necessário para `git`/`gh` de conta
      // pessoal — fazia o worker cair numa credencial sem cota e devolver "monthly quota exceeded", um erro
      // que aponta para o lugar errado. Aqui o token é fixado no CARREGAMENTO da extensão (quando o app
      // garantidamente o forneceu) e reinjetado no filho, então o worker deixa de depender de disciplina
      // manual de env. Nada é persistido em disco: vive só em memória deste processo.
      if (PINNED_AUTH_TOKEN && !env.GH_TOKEN) env.GH_TOKEN = PINNED_AUTH_TOKEN;
      env.MODO_AUTO_AUTH_PINNED = env.GH_TOKEN ? "1" : "0"; // o worker usa isto para diagnosticar erro de cota/auth

      let out = "", err = "", done = false, lastBeat = Date.now(), capturedUsage = null;
      let killer = null, reaper = null;
      const clearGuards = () => { if (killer) { clearTimeout(killer); killer = null; } if (reaper) { clearInterval(reaper); reaper = null; } };
      const finish = (r) => { if (!done) { done = true; clearGuards(); if (act != null && activity) { try { const endReason = r.endReason || (r.ok ? "idle" : (/hung:|zombie:/.test(r.error || "") ? "hung" : "error")); const metrics = { inputLines: typeof prompt === "string" ? prompt.split(/\r?\n/).length : undefined, inputTokens: capturedUsage?.inputTokens, outputTokens: capturedUsage?.outputTokens }; activity.end(act, { ...r, endReason, usage: capturedUsage, metrics }); } catch { /* observabilidade nunca derruba o run */ } } resolve(r); } };
      // canal de custo: separa a linha \x1e#USAGE {json} (tokens/nanoAiu do turno) do texto de erro real do worker.
      const usageCh = createUsageChannel({ onUsage: (u) => { capturedUsage = u; }, onText: (line) => { err += line + "\n"; }, log });

      let child;
      try {
        child = spawn(resolveNode(), [WORKER], { env, cwd: cwdProvider(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (e) { return finish({ ok: false, role: roleId, title: role.title, text: "", error: "spawn: " + (e?.message || e) }); }
      workers.track(child); // registra p/ killAll no unload (senão o NETO do SDK vaza órfão)

      // CONTROLE POR ATIVIDADE (NÃO relógio de turno): o filho auto-encerra no SILÊNCIO do SDK via heartbeat
      // (idle-grace) e PULSA \x1e no stderr a cada evento. Aqui o PAI reseta `lastBeat` a cada byte do filho e SÓ
      // mata se ele ficar TOTALMENTE MUDO (sem heartbeat) por `parentIdle` — um agente que TRABALHA nunca morre
      // por tempo decorrido. Relógio de parede FIXO só existe se o dono pedir um teto EXPLÍCITO (maxWallMs finito).
      const bump = () => { lastBeat = Date.now(); };
      if (Number.isFinite(maxWallMs)) {
        const capMs = computeParentCap(maxWallMs);
        killer = setTimeout(() => { workers.reap(child); finish({ ok: false, role: roleId, title: role.title, text: out.trim(), error: `maxwall: teto de parede EXPLÍCITO de ${Math.round(capMs / 1000)}s`, endReason: "hardcap" }); }, capMs);
      } else {
        const parentIdle = computeParentIdle(timeoutMs);
        reaper = setInterval(() => { if (Date.now() - lastBeat > parentIdle) { workers.reap(child); finish({ ok: false, role: roleId, title: role.title, text: out.trim(), error: `zombie: worker MUDO (sem heartbeat) por ${Math.round(parentIdle / 1000)}s`, endReason: "zombie" }); } }, 5000);
      }
      child.stdout.on("data", (d) => { out += d.toString(); bump(); });
      child.stderr.on("data", (d) => { usageCh.feed(d.toString()); bump(); }); // \x1e = heartbeat; \x1e#USAGE {json} = custo; resto = erro
      child.on("close", (code) => {
        usageCh.flush(); // esvazia erro/usage sem \n final
        finish({ ok: code === 0 && !!out.trim(), role: roleId, title: role.title, text: out.trim(), error: code === 0 ? null : (cleanStderr(err) || ("exit " + code)) });
      });
      try {
        // Serialização INTENCIONAL: NÃO enviar Infinity (JSON.stringify o vira `null`); omitir o campo =
        // "sem teto de parede" explícito (o child lê Number.isFinite(msg.maxWallMs) → ausente = Infinity = off).
        const job = { role: roleId, system: sys, prompt, model: chosenModel, idleGraceMs: timeoutMs, skillDirectories: skillDirs, reasoningEffort: effort, ...(schema ? { schema } : {}) };
        if (Number.isFinite(maxWallMs)) job.maxWallMs = maxWallMs;
        // ESCOPO DE MEMÓRIA: o chamador NÃO fornece. Ele era um parâmetro livre (`memoryScope`) e isso era uma
        // porta dos fundos real — qualquer caller (ou um erro de digitação, ou um valor derivado de dado
        // externo) podia injetar um escopo VÁLIDO-porém-ERRADO e abrir o acervo de outro projeto. Validar
        // FORMA não resolve isso: "outro/projeto" tem forma perfeita.
        // A única defesa que funciona é remover a entrada: o escopo passa a vir SEMPRE do provider injetado na
        // criação da factory, que resolve a partir do cwd da SESSÃO. Não é uma regra a respeitar — é um
        // argumento que não existe mais. O caller só pode OPTAR POR NÃO TER (`semMemoria: true`), nunca
        // apontar para outro lugar.
        const escopo = semMemoria ? null : (() => { try { return memoryScopeProvider ? memoryScopeProvider() : null; } catch { return null; } })();
        if (escopo) {
          job.memoryScope = validarEscopoInjetado(escopo);
          // ASSINATURA: o job viaja por stdin, e qualquer código que spawne o binário do worker consegue
          // escrever ali. A forma não prova nada ("outro/projeto" é bem-formado); a assinatura prova que o
          // escopo saiu DESTA factory. Sem ela, o filho recusa e roda sem memória.
          job.memoryScopeSig = assinarEscopo(job.memoryScope);
        }
        // availableTools:[] = papel TEXT-only (crítica/veredito) → desliga os built-ins do CLI. Papéis
        // construtores/revisores VIVOS NÃO passam isto (mantêm as ferramentas — controle é por atividade).
        if (Array.isArray(availableTools)) job.availableTools = availableTools;
        child.stdin.write(JSON.stringify(job));
        child.stdin.end();
      } catch (e) { finish({ ok: false, role: roleId, title: role.title, text: "", error: "stdin: " + (e?.message || e) }); }
    });
  }

  // Roda vários papéis EM PARALELO → [{role,title,text,ok}]. (o pré-análise decide quais)
  async function runMany(roleIds, prompt, opts = {}) {
    return Promise.all(roleIds.map((id) => run(id, prompt, opts)));
  }

  const api = { get, create, design, run, runMany, catalog: () => [...catalog.keys()] };
  return api;
}
