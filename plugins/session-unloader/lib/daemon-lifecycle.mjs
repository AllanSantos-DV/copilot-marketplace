// daemon-lifecycle.mjs — decisão PURA de idle-exit do daemon único. Extraída para ser testável sem
// esperar o IDLE_MS de verdade nem derrubar um processo real. Regra: só sai por idle quando (1) o
// automático está DESLIGADO — se estiver ligado, o scheduler tem de sobreviver independente de
// prompt/painel —, (2) não há lease/heartbeat ativa (painel aberto fazendo poll, ou hook/cliente
// recente) e (3) não há scan em voo (nunca fecha a porta no meio de um scan do sampler).
export function shouldIdleExit({ enabled, lastActivityAt, now = Date.now(), idleMs, scanning = false }) {
  if (enabled) return false;               // automático ligado => nunca idle-exit (scheduler precisa sobreviver)
  if (scanning) return false;              // scan em voo => nunca fecha a porta no meio do trabalho
  const last = Number(lastActivityAt);
  if (!Number.isFinite(last)) return false; // sem histórico de atividade = não decide (fail-safe: não mata)
  return (now - last) >= idleMs;           // lease vencida (sem painel/cliente recente) => pode sair
}
