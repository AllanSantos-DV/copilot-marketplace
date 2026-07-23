// scan-hook.mjs — runner do command hook (SessionStart / UserPromptSubmit). Processo SEPARADO, timeout 20s.
// Varre e DESCARREGA as sessões ociosas (as OUTRAS — a sessão atual está protegida pela guarda de
// auto-preservação, pois este processo é descendente do servidor dela). UserPromptSubmit tem THROTTLE de
// 1h, para cobrir quem trabalha horas numa sessão só sem abrir outra. Fire-and-forget: nunca bloqueia o
// chat, nunca lança, sai 0.
import { unloadIdle } from "./lib/unload.mjs";
import { logLine } from "./lib/log.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";
import { shouldScan, markScan } from "./lib/throttle.mjs";
import { readConfig } from "./lib/config.mjs";

const evento = process.argv[2] || "unknown"; // "session-start" | "user-prompt"
const THROTTLE_MS = 60 * 60 * 1000;          // 1h para o UserPromptSubmit

// Injeção de deps (default = as reais) só para o teste de ORDEM: throttle PRIMEIRO, readConfig SÓ se liberar.
export async function main({ home = resolveCopilotHome(), evento: ev = evento, throttleMs = THROTTLE_MS, deps = {} } = {}) {
  const ss = deps.shouldScan || shouldScan;
  const rc = deps.readConfig || readConfig;
  const ui = deps.unloadIdle || unloadIdle;
  const ms = deps.markScan || markScan;
  const log = deps.logLine || logLine;
  if (ev === "user-prompt" && !ss(home, throttleMs)) return { skipped: "throttle" }; // throttle PRIMEIRO (sem ler disco)
  if (!rc({ home }).enabled) { log({ evento: ev, action: "skip-disabled" }); return { skipped: "disabled" }; } // automático OFF
  try {
    const res = await ui({ home, dryRun: false });
    ms(home);
    log({
      evento: ev, action: "scan",
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
  main().finally(() => process.exit(0));
}
