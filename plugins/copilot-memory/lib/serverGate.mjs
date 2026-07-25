// serverGate — decide o bloco de AVISO do servidor de memória para injeção (onSessionStart / uso), no modelo
// OPT-IN: NUNCA provisiona. Só resolve o estado (resolveDaemon: configured | configured-unreachable | registry
// | registry-dead | none) e devolve { alert, source }: alert = string a injetar por contexto (ou null quando
// há servidor usável). Reusa buildServerAlert (mensagem acionável que manda abrir o memory_dashboard).
// FAIL-OPEN: qualquer erro → { alert:null } (não trava a sessão; a memória degrada em silêncio, nunca quebra).
import { resolveDaemon } from "./daemon.mjs";
import { buildServerAlert } from "./serverAlert.mjs";

export async function serverGate(opts = {}) {
    const _resolve = opts._resolveDaemon || resolveDaemon;
    let state;
    try { state = await _resolve(); } catch { return { alert: null, source: "error" }; }
    if (state && state.info) return { alert: null, source: state.source };                 // servidor usável
    if (state && state.source === "configured-unreachable") {
        return { alert: buildServerAlert("unreachable", state.configuredUrl), source: state.source };
    }
    // none | registry-dead | (qualquer outro sem info) → sem servidor e sem config utilizável.
    return { alert: buildServerAlert("unconfigured"), source: state ? state.source : "none" };
}
