// Helpers COMPARTILHADOS dos workers (fire-and-die `worker.mjs` E o vivo `liveWorker.mjs`) — DRY, sem
// efeito colateral na importação (o worker.mjs tinha um IIFE; por isso as helpers vivem aqui).

import { pathToFileURL } from "node:url";
import { join, delimiter } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";

// Comando único de conserto do setup dos workers (mesma string do setupCheck; duplicada aqui de
// propósito: o worker roda em node LIMPO e não deve arrastar a árvore de imports da extensão).
export const WORKER_FIX_COMMAND = "npm i -g @github/copilot@latest";

// Recusa EXPLÍCITA de setup — some com a morte opaca ("Cannot find package '@github/copilot-sdk'").
export class WorkerSetupError extends Error {
  constructor(message, detail = {}) { super(message); this.name = "WorkerSetupError"; this.detail = detail; }
}

// LAYOUTS do SDK dentro do pacote @github/copilot, em ordem de preferência. O layout mudou: até ~1.0.5 o SDK
// vinha em `<pkg>/copilot-sdk/index.js`; das versões novas (medido na 1.0.75) ele migrou para um pacote POR
// PLATAFORMA: `<pkg>/node_modules/@github/copilot-<plat>-<arch>/copilot-sdk/index.js`. Suportar OS DOIS é o que
// impede a mesa de quebrar quando o CLI é atualizado (foi exatamente o que aconteceu ao subir 1.0.5 → 1.0.75).
function sdkCandidatesIn(pkgDir) {
  const plat = `${platform()}-${arch()}`; // ex.: win32-x64
  return [
    join(pkgDir, "node_modules", "@github", `copilot-${plat}`, "copilot-sdk", "index.js"), // layout NOVO
    join(pkgDir, "copilot-sdk", "index.js"),                                               // layout ANTIGO
  ];
}

// PISO DO WORKER — por CAPACIDADE MEDIDA, não por número de versão chutado.
// Consultei o registro do npm: o pacote por plataforma aparece como dependência desde 0.0.370-2, ou seja,
// a metadata NÃO delimita o corte. Então o piso não é um semver inventado: é a presença real do layout NOVO
// no pacote instalado. Por que isso é o piso certo: o CLI pré-migração (medido: 1.0.5) IGNORA a opção
// `configDirectory` do createSession — o worker cai em ~/.copilot, herda as extensões do usuário e passa a
// meta-comentar sobre elas. Foi esse vazamento que quebrou a mesa em TODAS as sessões. Rodar assim não é
// "degradação graciosa", é contaminação silenciosa: por isso RECUSAMOS antes de operar.
// Escape consciente: MODO_AUTO_ALLOW_LEGACY_SDK=1 (assume o risco explicitamente).
function readCliVersion(pkgDir) {
  try { return JSON.parse(String(readFileSync(join(pkgDir, "package.json"), "utf8"))).version || null; }
  catch { return null; }
}

/**
 * Resolve o SDK do worker com diagnóstico. Ordem: override explícito → pacote global no PATH (layout NOVO)
 * → SDK do APP instalado → recusa. O layout ANTIGO é registrado mas NÃO é aceito por padrão.
 * @returns {{ url:string, source:string, pkgDir:string|null, cliVersion:string|null }}
 * @throws {WorkerSetupError} quando não há SDK utilizável — com versão medida, caminhos tentados e conserto.
 */
export function resolveWorkerSdk({ env = process.env, home = homedir() } = {}) {
  const override = String(env.MODO_AUTO_SDK_PATH || "").trim();
  if (override && existsSync(override)) return { url: pathToFileURL(override).href, source: "override", pkgDir: null, cliVersion: null };

  const tried = [];
  let legacy = null; // CLI pré-migração encontrado: guardado para a MENSAGEM, não para uso.
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir || !dir.trim()) continue;
    for (const marker of ["copilot.ps1", "copilot.cmd", "copilot"]) {
      try {
        if (!existsSync(join(dir, marker))) continue;
        const pkgDir = join(dir, "node_modules", "@github", "copilot");
        const [modern, ancient] = sdkCandidatesIn(pkgDir);
        tried.push(modern, ancient);
        if (existsSync(modern)) return { url: pathToFileURL(modern).href, source: "npm-global", pkgDir, cliVersion: readCliVersion(pkgDir) };
        if (existsSync(ancient) && !legacy) legacy = { pkgDir, cliVersion: readCliVersion(pkgDir), path: ancient };
      } catch { /* segue */ }
    }
  }

  // FALLBACK: o SDK que acompanha o APP instalado (auto-atualizado). Preferido a qualquer CLI pré-migração.
  for (const p of [env.COPILOT_SDK_PATH, join(home, "AppData", "Local", "Programs", "GitHub Copilot", "copilot-sdk")]) {
    if (!p) continue;
    const idx = /index\.js$/i.test(p) ? p : join(String(p).replace(/^\\\\\?\\/, ""), "index.js");
    tried.push(idx);
    try { if (existsSync(idx)) return { url: pathToFileURL(idx).href, source: "app", pkgDir: null, cliVersion: null }; } catch { /* segue */ }
  }

  if (legacy) {
    if (String(env.MODO_AUTO_ALLOW_LEGACY_SDK || "") === "1") {
      return { url: pathToFileURL(legacy.path).href, source: "npm-global-legacy", pkgDir: legacy.pkgDir, cliVersion: legacy.cliVersion };
    }
    throw new WorkerSetupError(
      `modo-auto — SETUP ABAIXO DO PISO: o CLI que os workers usam (${legacy.pkgDir}${legacy.cliVersion ? `, v${legacy.cliVersion}` : ""}) é PRÉ-MIGRAÇÃO do SDK ` +
      `(só tem o layout antigo copilot-sdk/index.js). Esse CLI IGNORA a opção \`configDirectory\`, então o worker cairia em ~/.copilot, herdaria as ` +
      `extensões da sua sessão e passaria a meta-comentar sobre elas — foi esse vazamento que já quebrou a mesa em todas as sessões. ` +
      `RECUSANDO antes de operar. CONSERTO: encerre as mesas e rode \`${WORKER_FIX_COMMAND}\`, depois confirme com \`modo_setup\`. ` +
      `Para assumir o risco conscientemente: MODO_AUTO_ALLOW_LEGACY_SDK=1.`,
      { reason: "sdk-pre-migracao", cliVersion: legacy.cliVersion, pkgDir: legacy.pkgDir, fix: WORKER_FIX_COMMAND },
    );
  }

  throw new WorkerSetupError(
    `modo-auto — SDK DO WORKER NÃO ENCONTRADO: nenhum \`copilot\` no PATH expôs o SDK e o SDK do app também não foi localizado. ` +
    `Sem isso o worker morreria com "Cannot find package '@github/copilot-sdk'", que não diz nada. Caminhos tentados: ` +
    `${tried.slice(0, 6).join(" | ") || "(PATH vazio)"}${tried.length > 6 ? ` … (+${tried.length - 6})` : ""}. ` +
    `CONSERTO: \`${WORKER_FIX_COMMAND}\` (ou aponte MODO_AUTO_SDK_PATH para o index.js do SDK).`,
    { reason: "sdk-nao-encontrado", tried, fix: WORKER_FIX_COMMAND },
  );
}

// Compat: os workers importam esta função. Agora ela FALHA ALTO em vez de devolver um bare specifier
// que morre com um erro de módulo sem contexto.
export function sdkIndexUrl() {
  return resolveWorkerSdk().url;
}

// Extrai o TEXTO de uma resposta do SDK (content string | array de partes | {text}).
export function textOf(res) {
  const c = res?.data?.content ?? res?.content;
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p?.text || ""))).join("");
  return typeof c.text === "string" ? c.text : "";
}

// Diretiva mínima que impede o sub-agente de meta-comentar sobre ferramentas (voz etc.). O isolamento
// REAL é o configDir do worker (não enxerga ~/.copilot/extensions). Não citar 'voz/falar' — citar planta.
export const CLEAN_DIRECTIVE =
  "Responda em TEXTO direto e curto exatamente o que for pedido, sem preâmbulo e sem meta-comentários.";

// WATCHDOG POR HEARTBEAT (compartilhado pelos DOIS workers — DRY). Substitui o TIMEOUT WALL-CLOCK do
// `session.sendAndWait(prompt, ms)` (que MATA o turno aos `ms` MESMO produzindo — o doc do SDK diz que aquele
// timeout "does not abort in-flight agent work", é só quanto tempo NÓS esperamos). Aqui a regra é a intenção
// do dono: o turno roda por tempo INDETERMINADO ENQUANTO PRODUZ; só aborta se TRAVAR de verdade (silêncio
// total > idleGraceMs). Reúso: usa o STREAM de eventos nativo do SDK (session.on) — cada evento (reasoning/
// streaming delta, tool progress, message…) é um batimento que reseta o cronômetro. FAIL LOUD: hung/erro
// REJEITAM com contexto; o caller vira {ok:false,error} VISÍVEL (nunca finge sucesso).
//
// @param session   sessão viva do SDK (precisa de .send/.on; .abort é best-effort)
// @param prompt    texto do turno
// @param opts.idleGraceMs  silêncio TOTAL (sem NENHUM evento) que caracteriza travamento. default 120s.
// @param opts.maxWallMs    backstop absoluto de parede (anti-runaway). default Infinity = OFF (indeterminado).
// @param opts.onActivity   callback(event) por evento (telemetria/observabilidade). Nunca derruba o turno.
// @param opts.model        rótulo do modelo p/ mensagens de erro.
// @returns Promise<AssistantMessageEvent|undefined>  — a mesma forma do sendAndWait (textOf() funciona igual).
export function runTurnWithHeartbeat(session, prompt, opts = {}) {
  const { idleGraceMs = 120000, maxWallMs = Infinity, onActivity = null, model = "?" } = opts;
  if (typeof session?.on !== "function" || typeof session?.send !== "function")
    return Promise.reject(new Error(`SDK incompatível: session.send/on ausentes (modelo ${model})`));

  return new Promise((resolve, reject) => {
    let last = Date.now(), settled = false, sent = false, finalMsg;
    let unsub = null, watch = null, wall = null;
    const cleanup = () => {
      if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
      if (watch) { clearInterval(watch); watch = null; }
      if (wall) { clearTimeout(wall); wall = null; }
    };
    const settle = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };
    const bump = () => { last = Date.now(); };

    // 1) Assina o stream ANTES de enviar (não perde evento). Cada evento é um batimento.
    try {
      unsub = session.on((event) => {
        bump();
        if (onActivity) { try { onActivity(event); } catch { /* telemetria nunca derruba o turno */ } }
        const t = event?.type;
        if (t === "assistant.message") finalMsg = event;                 // resposta final (mesma forma do sendAndWait)
        else if (t === "session.idle") { if (sent) settle(resolve, finalMsg); } // turno concluiu
        else if (t === "session.error") settle(reject, new Error(`session.error [${event?.data?.errorType || "?"}]: ${event?.data?.message || "erro na sessão"} (modelo ${model})`));
      });
    } catch (e) { return reject(new Error(`on(event) falhou: ${e?.message || e} (modelo ${model})`)); }

    // 2) Vigia periódico: aborta SÓ no silêncio total > idleGraceMs (travou). Produzindo → nunca dispara.
    // NÃO faz unref: o vigia é o mecanismo PRIMÁRIO (garante settle); `cleanup()` o limpa em todo desfecho.
    const tick = Math.max(25, Math.min(Math.floor(idleGraceMs / 2), 5000));
    watch = setInterval(() => {
      const silent = Date.now() - last;
      if (silent > idleGraceMs) {
        try { session.abort?.(); } catch { /* best-effort: cancela o turno em andamento */ }
        settle(reject, new Error(`hung: sem atividade por ${Math.round(silent / 1000)}s (modelo ${model})`));
      }
    }, tick);

    // 3) Backstop absoluto (default OFF): só existe se o dono ligar um teto de parede contra runaway.
    if (Number.isFinite(maxWallMs)) {
      wall = setTimeout(() => {
        try { session.abort?.(); } catch { /* best-effort */ }
        settle(reject, new Error(`maxWall: turno excedeu ${Math.round(maxWallMs / 1000)}s de parede (modelo ${model})`));
      }, maxWallMs);
    }

    // 4) Dispara o turno (send não bloqueia; os eventos fluem pelo on). Falha do send REJEITA (FAIL LOUD).
    try {
      const p = session.send({ prompt: String(prompt || "") });
      sent = true; bump();
      if (p && typeof p.then === "function") p.then(bump).catch((e) => settle(reject, new Error(`send falhou: ${e?.message || e} (modelo ${model})`)));
    } catch (e) { settle(reject, new Error(`send falhou: ${e?.message || e} (modelo ${model})`)); }
  });
}
