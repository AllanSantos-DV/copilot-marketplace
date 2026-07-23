// scan-hook.mjs — runner do command hook (SessionStart / UserPromptSubmit). Processo SEPARADO, timeout 20s.
// Varre e DESCARREGA as sessões ociosas (as OUTRAS — a sessão atual está protegida pela guarda de
// auto-preservação, pois este processo é descendente do servidor dela). UserPromptSubmit tem THROTTLE de
// 1h, para cobrir quem trabalha horas numa sessão só sem abrir outra. Fire-and-forget: nunca bloqueia o
// chat, nunca lança, sai 0.
import { unloadIdle } from "./lib/unload.mjs";
import { logLine } from "./lib/log.mjs";
import { resolveCopilotHome } from "./lib/home.mjs";
import { shouldScan, markScan } from "./lib/throttle.mjs";

const evento = process.argv[2] || "unknown"; // "session-start" | "user-prompt"
const THROTTLE_MS = 60 * 60 * 1000;          // 1h para o UserPromptSubmit

async function main() {
  const home = resolveCopilotHome();
  if (evento === "user-prompt" && !shouldScan(home, THROTTLE_MS)) return; // throttlado: nada a fazer
  try {
    const res = await unloadIdle({ home, dryRun: false });
    markScan(home);
    logLine({
      evento, action: "scan",
      killed: res.killed?.length || 0,
      candidates: res.candidates?.length || 0,
      skipped: res.skipped?.length || 0,
    });
  } catch (e) {
    logLine({ evento, action: "scan-error", error: String(e?.message || e) });
  }
}

// Só executa quando rodado como hook (não em import de teste).
if (process.argv[1] && /scan-hook\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().finally(() => process.exit(0));
}
