import { assertSafeProjectId } from "./projectId.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOOLSET DE MEMÓRIA READ-ONLY para o worker. Molde: `research/researchTools.mjs` (factory, cap no closure,
// handler que NUNCA lança para o SDK e sempre devolve JSON string).
//
// O DESENHO, em uma frase: o `project_id` vem CRAVADO do pai. O agente não resolve escopo, não olha `cwd`, e não
// recebe "projeto" como parâmetro que ele possa errar ou forjar — o escopo simplesmente não faz parte da
// superfície que o modelo enxerga. Isso elimina a classe inteira de bug de escopo cruzado: não é uma regra a ser
// respeitada, é um argumento que não existe.
//
// READ-ONLY ESTRUTURAL: este módulo não importa nada que escreva. Só há `memory_search`. Não existe
// `memory_save` para o modelo chamar — e um teste faz grep negativo aqui para que continue assim.
//
// ADAPTADOR, NÃO DEPENDÊNCIA: sem daemon/plugin, `createMemoryTools` devolve `[]` e o worker roda igual, sem
// tool nenhuma. O produto nunca exige memória para funcionar.

const DEFAULT_MAX_CHAMADAS = 6;const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const MAX_TRECHO = 600;

/**
 * @param {{ recall: (q:string, o:object)=>Promise<object>, projectId: string, maxChamadas?: number,
 *           log?: (m:string)=>void }} a
 *   `recall` é a função JÁ ESCOPADA do pai (o port dele, com o escopo dele). `projectId` viaja só para
 *   aparecer na descrição/telemetria — o handler não o usa para montar escopo nenhum, porque quem monta é o pai.
 * @returns {{ tools: object[], state: { usadas: number, max: number, docs: string[] } }}
 */
export function createMemoryTools({ recall, projectId, maxChamadas = DEFAULT_MAX_CHAMADAS, log = () => {} } = {}) {
  if (typeof recall !== "function") return { tools: [], state: { usadas: 0, max: 0, docs: [] } };

  // Cap no CLOSURE (não em variável de módulo): cada worker tem o seu, e um spawn não herda o contador do outro.
  // Existe porque tool de busca no meio do raciocínio convida o modelo a buscar em loop — e cada busca custa.
  const state = { usadas: 0, max: maxChamadas, docs: [] };

  const tools = [{
    name: "memory_search",
    description:
      `Busca semântica na memória do projeto (${projectId}). SOMENTE LEITURA — não existe forma de gravar. ` +
      `Use quando precisar de contexto que não está no prompt: decisões anteriores, como algo já foi feito, ` +
      `armadilhas conhecidas. Devolve JSON {ok, results:[{doc_id, text, score}]}. CITE o doc_id ao usar. ` +
      `Máximo de ${maxChamadas} buscas — pense antes de repetir.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "o que buscar, em linguagem natural (curto e específico)" },
        topK: { type: "number", description: `quantos trechos (1..${MAX_TOP_K}, padrão ${DEFAULT_TOP_K})` },
      },
      required: ["query"],
    },
    handler: async (a) => {
      try {
        const q = a && typeof a.query === "string" ? a.query.trim() : "";
        if (!q) return JSON.stringify({ ok: false, error: "query vazia" });
        // FAIL-CLOSED POR BUSCA, não só no boot. A ausência de escopo já impede a tool de existir — mas se ela
        // existe, cada chamada confere de novo. Sem isto, um escopo que se torne inválido entre a criação da
        // tool e a chamada cairia no ramo genérico e apareceria como "offline", disfarçando erro de ESCOPO de
        // serviço-fora-do-ar. São coisas diferentes: uma é infra, a outra é configuração errada.
        if (!projectId) {
          const erro = "escopo de projeto ausente — a busca NÃO foi feita (isto não é 'daemon offline': é escopo não resolvido)";
          log(`[memoria] busca RECUSADA: ${erro}`);
          return JSON.stringify({ ok: false, error: erro, escopoAusente: true });
        }
        if (state.usadas >= state.max) {
          // Recusa EXPLICADA, não silêncio: o modelo precisa saber que parou por orçamento e não por ausência
          // de resultado — senão ele conclui "não há nada na memória", que é uma conclusão falsa.
          return JSON.stringify({ ok: false, error: `limite de ${state.max} buscas atingido nesta tarefa`, limite: true });
        }
        state.usadas++;
        // Escopo NÃO vai como argumento: `recall` já é a função escopada do pai.
        const topK = Math.min(MAX_TOP_K, Math.max(1, Number(a.topK) || DEFAULT_TOP_K));
        const r = await recall(q, { topK });
        if (!r || r.ok !== true) {
          // Degradação DISTINGUÍVEL, com TRÊS estados e não dois: "não tenho memória aqui" ≠ "o escopo não
          // resolveu" ≠ "busquei e não achei". Antes, escopo não resolvido caía no mesmo ramo do daemon fora do
          // ar (`semConexao` devolve `offline:true` quando não há client) e o modelo — e o log — não tinham
          // como distinguir infra quebrada de configuração errada.
          if (r && r.error && /escopo não resolvido/.test(r.error)) {
            log(`[memoria] busca RECUSADA por ESCOPO: ${r.error}`);
            return JSON.stringify({ ok: false, error: r.error, escopoAusente: true });
          }
          const motivo = r && r.offline ? "memória indisponível (daemon fora do ar)" : (r && r.error) || "memória indisponível";
          log(`[memoria] busca falhou: ${motivo}`);
          return JSON.stringify({ ok: false, error: motivo, indisponivel: true });
        }
        const results = (r.results || []).map((x) => ({
          doc_id: x.doc_id || null,
          text: String(x.text || "").slice(0, MAX_TRECHO),
          score: typeof x.score === "number" ? x.score : null,
        }));
        for (const x of results) if (x.doc_id && !state.docs.includes(x.doc_id)) state.docs.push(x.doc_id);
        log(`[memoria] worker buscou "${q.slice(0, 60)}" em ${projectId} → ${results.length} trecho(s) [${state.usadas}/${state.max}]`);
        return JSON.stringify({ ok: true, results, projeto: projectId, restam: state.max - state.usadas });
      } catch (e) {
        // O molde manda NUNCA lançar para o SDK: uma exceção aqui viraria erro opaco de tool no meio do turno.
        return JSON.stringify({ ok: false, error: "handler_error", detail: String((e && e.message) || e) });
      }
    },
  }];

  return { tools, state };
}

/** Nomes das tools de memória — para o manifesto e para os testes de isolamento saberem o que procurar. */
export const MEMORY_TOOL_NAMES = Object.freeze(["memory_search"]);

/**
 * ASSINATURA DO ESCOPO. O escopo viaja do pai para o filho por um canal (stdin/env) que qualquer código que
 * spawne o binário do worker consegue escrever. Validar FORMA não resolve — `outro/projeto` tem forma perfeita.
 * O que resolve é PROVENIÊNCIA: só quem tem o segredo do processo pai consegue produzir uma assinatura válida.
 *
 * O que isto fecha, com honestidade sobre o limite: um chamador INTERNO (outro perfil, outro agente, um teste
 * que spawna o worker direto) não consegue mais injetar um escopo — era o caso real, e é o que quase aconteceu
 * duas vezes nesta sessão. O que NÃO fecha: um processo que controle o ambiente inteiro pode gerar o próprio
 * par segredo+assinatura. Essa não é a fronteira de confiança aqui — quem controla o processo já controla tudo.
 * O segredo vive só em memória, muda a cada boot do pai, e nunca é persistido.
 */
const SEGREDO = randomBytes(32).toString("hex");

export function assinarEscopo(escopo, segredo = SEGREDO) {
  return createHmac("sha256", segredo).update(String(escopo)).digest("hex").slice(0, 32);
}

/**
 * Confere a assinatura no FILHO. Sem assinatura válida, o escopo é RECUSADO — e recusar significa rodar sem
 * memória, com o fato registrado, nunca buscar no escopo não-verificado.
 * @returns {{ ok:true, escopo:string } | { ok:false, motivo:string }}
 */
export function verificarEscopo(escopo, assinatura, segredo) {
  if (!escopo) return { ok: false, motivo: "sem escopo" };
  if (!segredo) return { ok: false, motivo: "sem segredo do processo pai — o escopo não pôde ser verificado" };
  if (!assinatura) return { ok: false, motivo: "escopo veio SEM assinatura (injeção por fora da factory?)" };
  const esperada = assinarEscopo(escopo, segredo);
  // Comparação de tempo constante: o custo é zero e evita transformar a verificação num oráculo.
  const a = Buffer.from(assinatura, "utf8"), b = Buffer.from(esperada, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, motivo: "assinatura do escopo INVÁLIDA — o escopo não veio da factory deste processo" };
  return { ok: true, escopo: String(escopo) };
}

/** Segredo do processo pai, para ser repassado ao filho pelo mesmo canal do spawn. */
export function segredoDoProcesso() { return SEGREDO; }

/**
 * Escopo de memória para CRAVAR no worker, a partir das caps do perfil. Mora aqui (e não em cada perfil) porque
 * é a mesma pergunta em todos: "qual projeto este agente pode ler?". NUNCA lança — ausência de memória não pode
 * derrubar a mesa; devolve `null` e o worker roda sem tool.
 */
export function escopoParaWorker(caps) {
  try { return (caps && caps.memory && caps.memory.projectId && caps.memory.projectId()) || null; }
  catch { return null; }
}

/**
 * PORTA GUARDADA na injeção do escopo. Antes, um `memoryScope` explícito era repassado como string, sem
 * checagem: qualquer chamador — inclusive um erro de digitação ou um valor derivado de dado externo — abriria o
 * acervo de outro projeto. `assertSafeProjectId` barra forma-de-caminho e vazio, mas não barra um escopo
 * VÁLIDO-porém-errado; e não existe como o código saber qual é o "certo".
 *
 * O que dá para exigir, e é o que se exige aqui: que o valor tenha a FORMA de um id de projeto (declarado
 * `owner/projeto` ou git-remote `host/owner/repo`) e não seja um literal genérico. Um escopo que não passa
 * nisso é erro de programação, e erro de programação QUEBRA ALTO — não vira busca silenciosa no lugar errado.
 * @throws {Error} quando o escopo injetado não tem forma de project_id
 */
export function validarEscopoInjetado(escopo) {
  const s = assertSafeProjectId(escopo); // vazio / cara-de-caminho morrem aqui
  // Forma mínima de um id de projeto: dois ou mais segmentos separados por "/", sem espaço.
  if (!/^[^\s/]+(\/[^\s/]+)+$/.test(s)) {
    throw new Error(
      `memoryScope inválido: "${s}" não tem forma de project_id (esperado "owner/projeto" ou "host/owner/repo"). ` +
      `Injetar um escopo malformado faria o agente buscar no lugar errado em silêncio — por isso isto quebra alto.`,
    );
  }
  return s;
}
