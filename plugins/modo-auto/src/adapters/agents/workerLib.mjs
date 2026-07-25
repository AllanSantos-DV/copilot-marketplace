// Helpers COMPARTILHADOS dos workers (fire-and-die `worker.mjs` E o vivo `liveWorker.mjs`) — DRY, sem
// efeito colateral na importação (o worker.mjs tinha um IIFE; por isso as helpers vivem aqui).

import { pathToFileURL } from "node:url";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

// Resolve o index.js do Copilot SDK GLOBAL a partir do `copilot` no PATH (o worker é node LIMPO).
export function sdkIndexUrl() {
  const env = String(process.env.MODO_AUTO_SDK_PATH || "").trim();
  if (env && existsSync(env)) return pathToFileURL(env).href;
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir || !dir.trim()) continue;
    for (const marker of ["copilot.ps1", "copilot.cmd", "copilot"]) {
      try {
        if (existsSync(join(dir, marker))) {
          const sdk = join(dir, "node_modules", "@github", "copilot", "copilot-sdk", "index.js");
          if (existsSync(sdk)) return pathToFileURL(sdk).href;
        }
      } catch { /* segue */ }
    }
  }
  return "@github/copilot-sdk";
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
