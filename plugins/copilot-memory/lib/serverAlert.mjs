// Aviso CRAVADO e ACIONÁVEL sobre o SERVIDOR de memória (espelha lib/scopeAlert.mjs). Injetado por
// CONTEXTO nos hooks (panel-independent: o painel pode estar fechado) — o canvas NÃO abre sozinho, então o
// texto INSTRUI o agente a ABRIR o painel (chamar a tool memory_dashboard) e a avisar o usuário. Consentimento
// OPT-IN: nada é baixado sem autorização explícita. Funções puras, nunca lançam (caem no fallback).

// Fallback estático — usado só se a montagem lançar. Nunca vazio; sempre nomeia memory_dashboard.
export const SERVER_ALERT_FALLBACK =
    "🧠 MEMÓRIA DO PROJETO INDISPONÍVEL — nenhum servidor de memória ativo. AVISE O USUÁRIO e ABRA o painel " +
    "chamando a tool `memory_dashboard`: lá ele pode APONTAR um servidor existente OU AUTORIZAR provisionar um " +
    "local. Nada é baixado sem a autorização dele (opt-in).";

// Monta o aviso para o estado do servidor. `reason`: "unreachable" (URL configurada fora do ar) | qualquer
// outro / ausente = "unconfigured" (sem servidor e sem config). `url` só é usado em "unreachable".
// SEMPRE retorna string não-vazia; nunca lança.
export function buildServerAlert(reason, url) {
    try {
        if (reason === "unreachable") {
            const u = url && String(url).trim() ? String(url).trim() : "(configurado)";
            return (
                "🧠 SERVIDOR DE MEMÓRIA INALCANÇÁVEL — o servidor configurado `" + u + "` não respondeu ao " +
                "health-check. A memória está TEMPORARIAMENTE indisponível (degraded): nada será salvo nem " +
                "injetado até reconectar, e NENHUM servidor local é baixado no lugar (respeitando a sua " +
                "configuração — não trocamos o seu servidor em silêncio). AVISE O USUÁRIO e ABRA o painel " +
                "(chame a tool `memory_dashboard`) para revisar/testar a URL ou apontar outro servidor."
            );
        }
        // "unconfigured" (padrão): sem servidor e sem configuração.
        return (
            "🧠 MEMÓRIA DESATIVADA — nenhum servidor de memória está configurado nem rodando nesta máquina. " +
            "Enquanto isso, a memória **não salva nem injeta recall**. AVISE O USUÁRIO agora e ABRA o painel " +
            "para ele decidir: chame a tool `memory_dashboard` e, na seção \"Servidor de memória\", ele pode " +
            "APONTAR um servidor existente (informe a URL) OU AUTORIZAR provisionar um local (baixar o servidor). " +
            "Nada é baixado sem a autorização explícita dele — o download é opt-in."
        );
    } catch {
        return SERVER_ALERT_FALLBACK;
    }
}
