// scheduler.mjs — SCHEDULER ÚNICO do daemon para o automático (`config.enabled:true`). Roda em cadência
// própria (setInterval), independente de qualquer prompt/hook de sessão — é o que garante que a janela
// de inatividade configurada é atingida mesmo que o usuário fique horas sem digitar nada. Nunca sobrepõe
// ticks (um `_running` local, além do lock de arquivo que unloadIdle já usa via lib/lock.mjs).
import { unloadIdle } from "./unload.mjs";
import { readConfig } from "./config.mjs";
import { resolveCopilotHome } from "./home.mjs";

export const DEFAULT_INTERVAL_MS = 60_000; // cadência de avaliação do automático (independe do poll do painel)

/**
 * @param {{
 *   home?: string,
 *   intervalMs?: number,
 *   dryRun?: boolean,              // false em produção (mata de verdade quando idle); testes forçam true.
 *   isEnabledFn?: () => boolean,   // default: lê config.enabled do disco a cada tick.
 *   unloadIdleFn?: Function,       // injetável para teste; default: unloadIdle real.
 * }} opts
 */
export function createScheduler({
  home = resolveCopilotHome(),
  intervalMs = DEFAULT_INTERVAL_MS,
  dryRun = false,
  isEnabledFn = () => readConfig({ home }).enabled,
  unloadIdleFn = unloadIdle,
} = {}) {
  let timer = null;
  let running = false;
  let tickCount = 0;

  async function tick() {
    if (running) return; // nunca sobrepõe: um tick lento não dispara um 2º em paralelo
    if (!isEnabledFn()) return; // automático desligado => scheduler é inerte (fail-closed)
    running = true;
    tickCount++;
    try {
      await unloadIdleFn({ home, dryRun });
    } catch { /* nunca derruba o scheduler; a próxima cadência tenta de novo */ }
    finally { running = false; }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    isRunningTick() { return running; },
    get tickCount() { return tickCount; },
  };
}
