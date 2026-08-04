// Guia de INGESTÃO para o modo "servidor com curadoria local DESLIGADA" (native-java ≥2.33.0).
//
// O servidor roda com --ingestion=false / MCP_INGESTION_ENABLED=false quando não há GPU local: a
// ingestão cooperativa (ingest_conversation) e a curadoria LLM local SOMEM. Nesse modo quem cura o
// transcript CRU é o CONSUMIDOR (o agente desta sessão) — o servidor só recebe o documento JÁ
// TRATADO via POST /api/v1/documents (add_document) e segue chunkando/embedando.
//
// O plugin é CLIENTE PURO: não decide hierarquia, não recompõe recall, não reimplementa embedding.
// O que ele PODE fazer é ENSINAR o agente a tratar o transcript antes de salvar — via este guia
// (instruction file injetável) + uma tool determinística que normaliza a conversa. Quando o usuário
// liga a flag COPILOT_MEMORY_INGEST=1 E o servidor anuncia features.ingestion=false, o hook injeta
// a NOTA curta (ingestionCapabilityNote) e o agente carrega o guia completo via memory_ingest_guide.
import { cleanTranscript, renderTurns } from "./transcript.mjs";

// Fonte de verdade: o server nativo publica o estado em GET /health → features.ingestion.
export function serverIngestionOff(features) {
    return features && typeof features === "object" && features.ingestion === false;
}

// Toggle do consumidor: só quando o usuário LIGA a ingestão client-side é que o plugin ensina o
// agente a tratar o transcript. Sem a flag, o plugin não muda o comportamento atual (cliente puro).
export function consumerIngestionEnabled() {
    return process.env.COPILOT_MEMORY_INGEST === "1";
}

// Intervalo de consolidação (turnos user/assistant a cada N prompts) — COPILOT_MEMORY_INGEST_EVERY,
// default 5. A curadoria NÃO roda a cada stop: consolida vários turnos para remover o resíduo
// (tool calls/results) e só então gera o documento tratado.
export function ingestEveryTurns() {
    const v = Number(process.env.COPILOT_MEMORY_INGEST_EVERY || 5);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 5;
}

// NOTA curta para injeção no contexto (hook) quando a curadoria local está OFF e o consumidor ligou.
export function ingestionCapabilityNote(features) {
    if (!serverIngestionOff(features) || !consumerIngestionEnabled()) return null;
    return [
        "## 🧠 Ingestão: curadoria local DESLIGADA no servidor de memória",
        "O servidor (native-java) roda com a ingestão cooperativa desligada (features.ingestion=false) —",
        "ele NÃO cura o transcript cru. A cura é SUA (agente). Quando houver troca de turnos relevante,",
        "consolide a conversa e envie o documento JÁ TRATADO via `memory_save_document` (com documentId",
        "estável para re-escrita idempotente). Consulte `memory_ingest_guide` para o processo completo:",
        "limpar tool calls/results, agrupar a cada " + ingestEveryTurns() + " turnos e salvar por tipo (decision/note/knowledge).",
    ].join("\n");
}

// Instrução completa do processo de cura do transcript cru → documento tratado. É o "instruction file"
// que ensina o passo a passo mecânico + o template de saída. Usado pela tool memory_ingest_guide.
export const INGESTION_GUIDE = [
    "# Guia de ingestão (curadoria local desligada)",
    "",
    "## Por que este guia existe",
    "O servidor de memória está com a ingestão/curadoria local DESLIGADA (features.ingestion=false): ele",
    "não roda LLM para limpar o transcript cru. Quem limpa é você (o agente da sessão), ANTES de salvar.",
    "O servidor continua fazendo o que faz bem: chunking + embeddings + recall. Você só manda texto limpo.",
    "",
    "## O processo correto (não rode a cada stop — rode a cada troca significativa de turnos)",
    "1. **Acumule turnos**: entre um prompt do usuário e a sua resposta há MUITO resíduo de máquina",
    "   (tool calls, tool results, reasoning, hooks, usage). Não salve turno a turno.",
    "2. **Limpe a conversa**: mantenha APENAS `user` e `assistant` com texto humano. Descarte tudo o que",
    "   for tool.execution_*, hook.*, assistant.reasoning, *.usage, permission.* e eventos ephemeral.",
    "3. **Consolide**: junte vários turnos limpos num lote (a cada " + ingestEveryTurns() + " turnos é um bom ritmo).",
    "4. **Destile o conhecimento**: do lote, extraia o que é GENERALIZÁVEL e VERIFICADO — decisões de",
    "   arquitetura, convenções do projeto, fatos técnicos confirmados, anti-padrões do assistente",
    "   que o usuário criticou. Descarte tentativa-e-erro e detalhe efêmero.",
    "5. **Salve por tipo** com `memory_save_document` (não memory_save):",
    "   - `decision` — uma decisão de arquitetura/design tomada (com o porquê).",
    "   - `knowledge` — um fato/convenção técnica verificada do projeto.",
    "   - `note` — contexto valioso que não é decisão nem fato consolidado.",
    "   Use um `documentId` ESTÁVEL (ex.: 'dec-hooks-v2') para re-escrita idempotente: a versão nova",
    "   substitui a antiga no mesmo doc, sem duplicar.",
    "   Para vários documentos, use o modo batch: `memory_save_document {documents: [{content, documentId, type}, ...]}`.",
    "6. **Não envie segredos**: tokens, chaves, .env, connection strings NUNCA vão para a memória. Redija",
    "   antes de salvar (a lib redact.mjs faz isso; o servidor também tem guarda no health).",
    "",
    "## Template de saída de um documento tratado",
    "```",
    "# <título curto do que ficou aprendido>",
    "",
    "## Contexto",
    "<por que este documento existe; projeto e situação>",
    "",
    "## Decisão/Fato",
    "<o que ficou estabelecido, em 2-5 frases>",
    "",
    "## Porquê",
    "<o racional por trás, incluindo o que foi tentado e descartado>",
    "",
    "## Aplicar quando",
    "<gatilho de reuso: quando uma sessão futura deve lembrar disto>",
    "```",
    "",
    "## Exemplo de chamada",
    "`memory_save_document {content: \"<documento tratado no template>\", documentId: \"dec-rest-contract-007\", type: \"decision\"}`",
    "",
    "## Regras duras",
    "- Rode a consolidação a cada " + ingestEveryTurns() + " turnos (ou em marcos: testes passando, feature entregue), NUNCA a cada stop.",
    "- Sempre passe o template de saída — documento cru = conteúdo não curado = ruído no recall.",
    "- metadata fica por conta do plugin (project_id + type + source); você não envia metadata.",
].join("\n");

// Normaliza um bloco de eventos em texto de conversa limpo (user+assistant, sem ruído de tool).
// Função determinística e pura — reusa o cleanTranscript/renderTurns do transcript.mjs.
export function normalizeTranscript(events) {
    const turns = cleanTranscript(events);
    return { turns, text: renderTurns(turns), turnCount: turns.length };
}
