// scan-hook.mjs — runner do command hook (SessionStart / UserPromptSubmit). Processo SEPARADO, timeout 20s.
// v0.7: CLIENTE FINO do daemon único — nunca importa lib/unload.mjs (scan/guards/kill ficam só no daemon).
// Quando o automático está habilitado, apenas ENCONTRA/SOBE o daemon e pede a ele para avaliar (o daemon
// é quem escaneia e mata, uma vez só para N sessões). UserPromptSubmit tem THROTTLE de 1h, para cobrir
// quem trabalha horas numa sessão só sem abrir outra. Fire-and-forget: nunca bloqueia o chat, nunca
// lança, sai 0. Desabilitado é o caminho barato: nem contata o daemon (fail-closed).
import { logLine } from "./lib/log.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";
import { shouldScan, markScan } from "./lib/throttle.mjs";
import { readConfig } from "./lib/config.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import { requestUnload } from "./lib/daemon-client.mjs";

const THROTTLE_MS = 60 * 60 * 1000;          // 1h para o UserPromptSubmit
const EVENT_NAMES = new Map([
  ["sessionstart", "session-start"],
  ["session-start", "session-start"],
  ["userpromptsubmit", "user-prompt"],
  ["user-prompt", "user-prompt"],
]);

export function resolveEvent({ hookInput = null, fallback = null } = {}) {
  let input = hookInput;
  if (typeof input === "string") {
    try { input = JSON.parse(input); }
    catch { input = null; }
  }
  const fromInput = input && (
    input.hook_event_name
    || input.hookEventName
    || input.event
  );
  const raw = fromInput || fallback;
  return EVENT_NAMES.get(String(raw || "").toLowerCase()) || null;
}

async function readHookInput() {
  if (process.stdin.isTTY) return null;
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); }
  catch (e) { return { parseError: String(e?.message || e) }; }
}

// Injeção de deps (default = as reais) só para o teste de ORDEM: throttle PRIMEIRO, readConfig SÓ se
// liberar, e o daemon SÓ é contatado se o automático estiver ligado (fail-closed barato quando desligado).
export async function main({
  home = resolveCopilotHome(),
  evento = null,
  hookInput = null,
  throttleMs = THROTTLE_MS,
  deps = {},
} = {}) {
  const ss = deps.shouldScan || shouldScan;
  const rc = deps.readConfig || readConfig;
  const ms = deps.markScan || markScan;
  const log = deps.logLine || logLine;
  const ensureDaemonFn = deps.ensureDaemon || ensureDaemon;
  const requestUnloadFn = deps.requestUnload || requestUnload;
  const ev = resolveEvent({ hookInput, fallback: evento || process.argv[2] });
  if (!ev) {
    log({
      evento: "unknown",
      action: "skip-unknown-event",
      error: hookInput?.parseError || null,
    });
    return { skipped: "unknown-event" };
  }
  if (ev === "user-prompt" && !ss(home, throttleMs)) return { skipped: "throttle" }; // throttle PRIMEIRO (sem ler disco)
  const cfg = rc({ home });
  if (!cfg.enabled) { log({ evento: ev, action: "skip-disabled" }); return { skipped: "disabled" }; } // automático OFF
  try {
    // nudge fino: o SCAN/kill de verdade roda no processo do daemon, não aqui (hook nunca importa unload.mjs).
    const res = await requestUnloadFn({ ensureDaemonFn: () => ensureDaemonFn(home), dryRun: false });
    ms(home);
    log({
      evento: ev, action: "hook-nudge",
      killed: res.killed?.length || 0,
      candidates: res.candidates?.length || 0,
      skipped: res.skipped?.length || 0,
    });
    return { scanned: true, res };
  } catch (e) {
    log({ evento: ev, action: "scan-error", error: String(e?.message || e) });
    return { error: true };
  }
}

// Só executa quando rodado como hook (não em import de teste). Boundary de path: exige `/scan-hook.mjs`
// no fim (não casa com `test-...scan-hook.mjs` importado por um teste).
if (process.argv[1] && /(?:^|\/)scan-hook\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  readHookInput()
    .then((hookInput) => main({ hookInput }))
    .finally(() => process.exit(0));
}
