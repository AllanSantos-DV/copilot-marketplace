// MemoryPort — recall/save escopados por project_id, via daemon native-java. Memória é OPCIONAL:
// daemon offline → { ok:false, offline:true } (degradado legítimo). Erro REAL da chamada → { ok:false,
// error } VISÍVEL (surfaced, não mascarado). Reusa o MESMO project_id da sessão (não recria escopo).

import { discover } from "./daemon.mjs";
import { tryResolveProjectId } from "./projectId.mjs";
import { MemoryClient } from "./client.mjs";

// Tipos que são SAÍDA DE AGENTE — o que a própria mesa produz. Eles NUNCA podem cair no escopo principal do
// projeto: é exatamente assim que a mesa passa a consumir o que ela mesma escreveu. Exigir `namespace` aqui é
// FAIL LOUD (Princípio 10): uma chamada errada QUEBRA na hora, em vez de gravar em silêncio no lugar errado e
// só aparecer semanas depois como "o plano falou de um assunto que eu não pedi".
export const AGENT_OUTPUT_TYPES = Object.freeze(["adr-registro", "adr-mesa-snapshot", "plan"]);

// Tipos LEGÍTIMOS de conhecimento (o que uma mesa pode reusar). É a allowlist da 2ª camada de leitura: como o
// servidor só sabe igualdade e pertence-a-lista, a exclusão de saída de agente é expressa pelo POSITIVO.
// Manter em sincronia com o que o produto grava.
export const RECALL_ALLOWED_TYPES = Object.freeze(["knowledge", "decision", "note", "bugfix"]);

/**
 * Mensagem ÚNICA para o estado do recall. Existe porque o mesmo defeito se repetia em 5 chamadores: todos
 * tratavam só `m.error`, então `{ok:false, offline:true}` (que NÃO tem `.error`) caía no mesmo ramo de "não achei
 * nada" — memória fora do ar virava contexto vazio com cara de caminho feliz. Corrigir em 5 lugares convida o
 * 6º a nascer errado; aqui a regra é uma só.
 * @returns {string|null} texto a logar, ou null quando não há nada a sinalizar (busca ok)
 */
export function recallIssue(res, tag = "memória") {
  if (!res || res.ok !== false) return null;
  if (res.offline) return `[${tag}] memória OFFLINE — seguindo SEM contexto de reúso (degradação sinalizada; isto NÃO é "nada encontrado")`;
  return `[${tag}] memória indisponível (${res.error || "motivo não informado"}) — seguindo sem contexto`;
}

/**
 * Escopo de consulta/gravação. Fonte ÚNICA da regra: se write e read montarem o escopo por caminhos diferentes,
 * eles divergem e o que foi gravado vira inalcançável — foi exatamente o que aconteceu quando o namespace entrou
 * só no write: os registros iam para `<project>#adr` e o recall seguia consultando `<project>` puro, então NADA
 * daquele arquivo voltava. Trocar envenenamento por amnésia não é conserto. Uma função, dois usos.
 */
export function buildScope(projectId, namespace = null) {
  if (!projectId) return null;
  const ns = namespace ? String(namespace).trim() : "";
  return ns ? `${projectId}#${ns}` : projectId;
}

/**
 * Monta o metadata de gravação. PURO de propósito: é aqui que mora a separação de escopo, e sem daemon vivo não
 * daria para testá-la através do port (o connect() exige o serviço no ar). Regra: `namespace` SUFIXA o project_id
 * — e como o recall é escopado ao project_id puro, o que vai para um namespace nunca volta na busca principal.
 * FAIL LOUD: saída de agente SEM namespace LANÇA. Aceitar essa chamada e gravar no escopo principal seria
 * re-envenenar o corpus em silêncio — o defeito voltaria pela porta que eu acabei de fechar.
 * @param {{ projectId?: string|null, type?: string, tags?: string[], namespace?: string|null }} a
 * @throws {Error} quando um tipo de saída de agente é gravado sem namespace
 */
export function buildSaveMetadata({ projectId = null, type = "note", tags = [], namespace = null } = {}) {
  const ns = namespace ? String(namespace).trim() : "";
  if (AGENT_OUTPUT_TYPES.includes(type) && !ns) {
    throw new Error(
      `memoryPort.save: type "${type}" é SAÍDA DE AGENTE e exige 'namespace' — gravar isso no escopo do projeto faz a ` +
      `mesa consumir o que ela mesma escreveu (o bug do plano que falava de outro assunto). Passe { namespace: "adr" }.`,
    );
  }
  const metadata = { type };
  const scope = buildScope(projectId, ns || null);
  if (scope) metadata.project_id = scope;
  if (Array.isArray(tags) && tags.length) metadata.tags = tags;
  // 2ª camada de identificação: mesmo que alguém consulte o escopo errado um dia, o documento SE DECLARA como
  // produção de agente. É metadado (viaja com o doc), não marcador no texto — não depende de chunker.
  if (AGENT_OUTPUT_TYPES.includes(type)) metadata.source_type = "agent_output";
  return metadata;
}

/**
 * @param {{ cwdProvider?: ()=>string, clientFactory?: (url:string)=>object, log?: (m:string)=>void,
 *           discoverFn?: ()=>Promise<{url:string}|null> }} [opts]
 *   `discoverFn` existe para TESTE DE CONTRATO: sem ele, nada abaixo de `connect()` é exercitável sem um daemon
 *   vivo — e foi justamente aí que um teste meu passou VERDE sem executar nenhuma asserção (caía no atalho de
 *   offline). Injetar a descoberta é o que permite provar o caminho ONLINE de verdade.
 * @returns {import("../../core/ports.mjs").MemoryPort}
 */
export function createMemoryPort({ cwdProvider = () => process.cwd(), clientFactory = () => null, log = () => {}, discoverFn = discover } = {}) {
  let cached = null; // { client, projectId }

  async function connect() {
    const info = await discoverFn();
    if (!info) { log("memória offline (sem daemon vivo)"); cached = null; return null; }
    // clientFactory pode devolver o client do PLUGIN (reuso); null/undefined → cai no vendado (default).
    const client = clientFactory(info.url) || new MemoryClient(info.url);
    cached = { client, projectId: tryResolveProjectId(cwdProvider()), url: info.url };
    log(`memória online (${info.url}) escopo=${cached.projectId || "?"}`);
    return cached;
  }

  return {
    projectId() { return tryResolveProjectId(cwdProvider()); },

    /**
     * Busca semântica no escopo do projeto. `namespace` consulta um escopo IRMÃO (ex.: o arquivo de ADRs em
     * `<project>#adr`), que é onde a mesa guarda a própria saída para não se reconsumir. Sem `namespace`, busca o
     * escopo principal — e por construção NÃO enxerga os namespaces, que é o ponto.
     *
     * FAIL-CLOSED: no escopo PRINCIPAL a allowlist de tipos legítimos é aplicada POR PADRÃO. Ler um `namespace`
     * desliga a allowlist (o arquivo é saída de agente por desenho — filtrá-lo o esvaziaria). A escotilha
     * `includeAgentOutput: true` existe para o caso raro, exige o booleano exato `true` e é LOGADA.
     * `tag` identifica o chamador NO LOG (não é credencial: string não é garantia, e a garantia aqui é o default).
     */
    async recall(query, { topK = 5, minScore = null, namespace = null, includeAgentOutput = false, tag = "?" } = {}) {
      const c = cached || await connect();
      if (!c) return { ok: false, offline: true, results: [] }; // daemon offline = degradado legítimo (não erro)
      try {
        const scope = buildScope(c.projectId, namespace);
        const metadata = scope ? { project_id: scope } : {};
        // 2ª CAMADA DE LEITURA — FAIL-CLOSED, e a chave da regra é o ESCOPO, não quem chama.
        //
        // Eu primeiro escrevi esta camada como OPT-IN (`excludeAgentOutput`), e ela ficou ligada em 1 de 7
        // chamadas. Guarda que precisa ser lembrada é guarda que não existe: o caller número 8 nasce inseguro, e
        // esse é o caso COMUM, não o excepcional. É a minha lição recorrente ("consertar UM caller não conserta a
        // CLASSE") cometida outra vez — agora a regra mora aqui, e a chamada nasce segura sem fazer nada.
        //
        // POR QUE A CHAVE É O ESCOPO E NÃO UM caller-id: a alternativa considerada era uma allowlist de
        // chamadores. Em .mjs não existe tipo em runtime — um caller-id é só uma string, e string se forja
        // (basta interpolar). Já o `namespace` é ESTRUTURAL: ele muda o escopo consultado. E a medição dos 7
        // pontos de chamada mostrou que os ÚNICOS dois que legitimamente querem saída de agente
        // (`modoAdr` e `modoDev` lendo o arquivo de decisões) são exatamente os dois que passam `namespace`.
        // Ou seja: quem lê um namespace já se isolou por construção — o arquivo de ADRs É saída de agente por
        // desenho, e filtrá-lo o esvaziaria (era o bug de amnésia que eu já causei uma vez). Quem lê o escopo
        // PRINCIPAL nunca quer saída de agente: é literalmente o auto-envenenamento.
        //
        // A allowlist é POSITIVA porque o servidor não sabe negar: `$ne`/`$not` são rejeitados, mas
        // `EXISTS … value IN (?,?)` funciona (medido: `type:"bugfix"` → 17 de 20). "NÃO seja saída de agente"
        // não é expressável; "SEJA um dos tipos legítimos" é, e dá o mesmo resultado.
        //
        // CUSTO MEDIDO ANTES DE INVERTER (não é estimativa): 5 consultas reais no corpus deste projeto, 150
        // chunks devolvidos sem filtro. A allowlist cortou **1** — e era exatamente o documento de saída de
        // agente legado plantado para o teste. Nenhum conhecimento legítimo foi perdido.
        // LIMITE HONESTO que sobra: documento gravado SEM `type` também fica de fora (o filtro exige a chave).
        // Por isso a escotilha existe — mas ela é explícita, ruidosa, e não é o default.
        const escopoPrincipal = !namespace;
        if (escopoPrincipal && includeAgentOutput !== true) metadata.type = RECALL_ALLOWED_TYPES;
        if (escopoPrincipal && includeAgentOutput === true) {
          // Escotilha ABERTA: nunca em silêncio. Sem isto, um `includeAgentOutput: true` colado por engano some
          // no meio do código e reabre o envenenamento sem deixar rastro.
          log(`[${tag}] recall com includeAgentOutput=true no ESCOPO PRINCIPAL — a 2ª camada está DESLIGADA nesta chamada (saída de agente pode voltar)`);
        }
        const r = await c.client.search(query, { topK, metadata: Object.keys(metadata).length ? metadata : undefined, ...(minScore != null ? { minScore } : {}) });
        return { ok: true, results: (r && r.results) || [], projectId: scope, filtered: escopoPrincipal && includeAgentOutput !== true };
      } catch (e) {
        const error = e?.message || String(e);
        log("recall ERRO (surfaced, não mascarado): " + error);
        return { ok: false, error, results: [] }; // erro REAL vai no retorno pro caller surfacear
      }
    },

    /**
     * Grava na memória. `namespace` SEPARA de fato o escopo: ele sufixa o project_id, e como o recall é escopado
     * por project_id (mecânica já em produção, é assim que projetos não se misturam), o que vai para um namespace
     * NUNCA volta na busca do escopo principal.
     * POR QUE ISSO E NÃO MARCADOR NO TEXTO: a defesa anterior contra a mesa reconsumir a própria saída dependia de
     * um marcador `[ADR-REGISTRO]` no texto + do registro "caber em um chunk". Isso é acoplamento ao chunker de um
     * servidor de terceiro: se ele picar o documento, os pedaços do meio voltam SEM o marcador e a garantia quebra
     * EM SILÊNCIO. Aqui a separação usa só `project_id`, que é a única mecânica de escopo comprovadamente aplicada
     * pelo daemon — não depende de tamanho de documento nem de como ele fragmenta.
     */
    async save(content, { type = "note", tags = [], namespace = null } = {}) {
      // VALIDAÇÃO FORA DO try: `buildSaveMetadata` LANÇA quando uma saída de agente vem sem namespace, e isso é
      // ERRO DE PROGRAMAÇÃO, não falha de infraestrutura. Dentro do try, o catch abaixo o converteria em
      // `{ok:false, error}` — o MESMO canal do daemon fora do ar — e o chamador trataria como degradação
      // aceitável, exatamente o fail-silent que o guard existe para impedir. O teste AO VIVO pegou isto; os
      // fakes não pegariam, porque o problema não é a regra, é ONDE ela roda.
      const metadata = buildSaveMetadata({ projectId: tryResolveProjectId(cwdProvider()), type, tags, namespace });
      const c = cached || await connect();
      if (!c) return { ok: false, offline: true };
      try {
        // o projectId real vem da conexão (pode diferir do resolvido acima se o cwd mudou) — reconstrói o escopo
        const scope = buildScope(c.projectId, namespace);
        if (scope) metadata.project_id = scope; else delete metadata.project_id;
        const r = await c.client.save(content, metadata);
        return { ok: true, id: r && r.id, scope: metadata.project_id || null };
      } catch (e) {
        const error = e?.message || String(e);
        log("save ERRO (surfaced, não mascarado): " + error);
        return { ok: false, error };
      }
    },
  };
}
