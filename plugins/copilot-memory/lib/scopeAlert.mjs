// Aviso CRAVADO e ACIONÁVEL quando o resolver ESTRITO não produz project_id (sem marcador declarado
// e sem git remote). O plugin ativo = o usuário QUER usar a memória; logo ele precisa de VISIBILIDADE
// de que ela está DESATIVADA — e essa visibilidade chega EXATAMENTE na hora em que se tenta usar
// (salvar/buscar). Em vez de uma recusa passiva, os guards retornam este texto, que instrui o AGENTE a
// AVISAR O USUÁRIO e a LIGAR a memória aplicando uma identificação estável (fail-loud, sem auto-criar).
import { resolve as pathResolve, basename } from "node:path";
import { SCOPE_HELP } from "./projectId.mjs";

// Sugere um SLUG a partir do nome da pasta (só uma proposta editável para o project_id — NUNCA vira
// escopo sozinho). Normaliza p/ minúsculo com hífens. Retorna null quando não há nome útil (raiz de
// disco, vazio) ou input inválido. Nunca lança.
export function inferSuggestedId(workspacePath) {
    try {
        if (typeof workspacePath !== "string" || !workspacePath.trim()) return null;
        const name = basename(pathResolve(workspacePath.trim()));
        if (!name || !name.trim()) return null;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return slug || null;
    } catch {
        return null;
    }
}

// Fallback estático — usado só se a montagem dinâmica lançar. NÃO regride à recusa passiva: ainda diz
// que a memória está DESATIVADA, manda avisar o usuário e nomeia memory_init_project.
export const NO_SCOPE_FALLBACK =
    "🧠 MEMÓRIA DO PROJETO DESATIVADA — não há um project_id estável (sem .memory/project.json e sem git remote). " +
    "AVISE O USUÁRIO de que nada será salvo nem injetado até identificar o projeto, e proponha ligar a memória: " +
    "num repositório git, garanta um `git remote origin` (o id sai dele); senão, crie o marcador com " +
    "`memory_init_project` (proponha um project_id canônico ou peça ao usuário) e repita a operação. " + SCOPE_HELP;

// Monta o aviso cravado para um workspace. SEMPRE retorna string não-vazia; nunca lança (cai no
// fallback). Traz o id sugerido quando inferível.
export function buildScopeAlert(workspacePath) {
    try {
        const suggested = inferSuggestedId(workspacePath);
        const sugLine = suggested
            ? `Sugestão de project_id (edite se quiser): \`owner/${suggested}\` (ou apenas \`${suggested}\`). `
            : "";
        return (
            "🧠 MEMÓRIA DO PROJETO DESATIVADA — este projeto ainda não tem um identificador estável " +
            "(não há `.memory/project.json` na raiz nem um `git remote origin`). Enquanto isso, a memória " +
            "**não salva nem injeta recall** aqui (fail-loud proposital: nunca gravamos escopo-lixo pelo caminho da pasta).\n\n" +
            "AVISE O USUÁRIO agora: a memória do projeto está desligada e só liga com uma identificação. Para LIGAR:\n" +
            "1. Se este for um repositório git, garanta um `git remote origin` — o `project_id` é inferido dele automaticamente (portável entre máquinas).\n" +
            "2. Senão, crie o marcador: analise a estrutura, proponha um `project_id` canônico e chame " +
            "`memory_init_project({ name, projectId })` — ou peça o id ao usuário. " + sugLine + "Depois, repita a operação.\n\n" +
            SCOPE_HELP
        );
    } catch {
        return NO_SCOPE_FALLBACK;
    }
}
