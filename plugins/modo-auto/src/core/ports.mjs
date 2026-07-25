// PORTS — contratos do NÚCLEO (hexagonal). O core fala só com estes ports; as implementações
// concretas são ADAPTERS (SDK, memória, fábrica, gates) e o comportamento é um adapter de PERFIL.
// Em JS os ports são contratos documentados (JSDoc) + um validador de forma em runtime.

/**
 * @typedef {Object} InterceptPort  De onde vêm os gatilhos e por onde se responde/injeta.
 * @property {(handlers: { onQuestion: Function, onStop: Function }) => Promise<void>|void} bind
 *           Liga os callbacks do core aos eventos reais (ask_user via onUserInputRequest; parada
 *           via session.idle). Chamado quando o modo LIGA.
 * @property {() => Promise<void>|void} unbind  Desliga a interceptação (modo DESLIGA).
 * @property {(prompt: string) => Promise<unknown>} inject  Injeta um novo turno na sessão (session.send).
 * @property {() => string|undefined} planDir  Diretório da sessão (session.workspacePath) p/ o plano.
 */

/**
 * @typedef {Object} ProfilePort  O "tipo de mesa" (adapter de perfil). Decide o comportamento.
 * @property {string} id  Ex.: "modo-autonomo".
 * @property {(request: {question:string, choices?:string[], allowFreeform?:boolean}, caps: object)
 *            => Promise<{answer:string, wasFreeform:boolean}>} onQuestion  Responde um ask_user.
 * @property {(caps: object) => Promise<{done:boolean, continuation:string|null}>} onStop
 *           Revisa uma parada: se !done, `continuation` é o prompt injetado pra seguir.
 */

/** @typedef {Object} PlanPort   { read(): Promise<string>, reframe?(raw): Promise<string> } */
/**
 * @typedef {Object} MemoryPort  Recall/save escopados por project_id (daemon native-java OU client do
 *   plugin copilot-memory, injetado via clientFactory — assinaturas idênticas: search/save).
 * @property {() => string|undefined} projectId  project_id resolvido do cwd.
 * @property {(query:string, opts?:{topK?:number}) => Promise<{ok:boolean, offline?:boolean, error?:string,
 *   results:Array, projectId?:string}>} recall  offline→{ok:false,offline:true}; erro REAL→{ok:false,error} (surfaced).
 * @property {(content:string, opts?:{type?:string, tags?:string[]}) => Promise<{ok:boolean, offline?:boolean,
 *   error?:string, id?:string}>} save
 */
/**
 * @typedef {Object} AgentFactoryPort  Cria/reusa PAPÉIS e roda cada um como sub-agente headless.
 * @property {(id:string) => object|null} get  Papel do catálogo/registro (síncrono) ou null.
 * @property {(id:string, subject?:string) => object} create  Shell dinâmico por template (uso direto/gate).
 * @property {(id:string, subject?:string) => Promise<object>} design  Papel DESENHADO pelo agente arquiteto
 *   (async; FAIL LOUD — sem fallback de template). Caminho dos papéis dinâmicos da mesa.
 * @property {(roleId:string, prompt:string, opts?:object) => Promise<{ok:boolean, role:string, title:string,
 *   text:string, error?:string}>} run  Roda 1 papel (worker limpo). `opts.system` sobrescreve; sem papel e
 *   sem system → LANÇA.
 * @property {(roleIds:string[], prompt:string, opts?:object) => Promise<object[]>} runMany  Roda N em paralelo.
 * @property {() => string[]} catalog  IDs no catálogo.
 */
/** @typedef {Object} GatePort  { run(kind, payload): Promise<{ok:boolean, reason?:string}> } */

// NOTA (fronteira hexagonal): o NÚCLEO só fala com Intercept/Profile/Plan/Memory/AgentFactory/Gate.
// Os adapters mais novos — ScopePort, review (remediation/rotation/deepPanel), shadow, embed, models
// (router), pipeline/escalation — são contratos ADAPTER↔ADAPTER usados pelos PERFIS e pela orquestração,
// NÃO ports do core; por isso vivem só nos seus módulos (com JSDoc local) e não incham este contrato.

/**
 * Valida (em runtime) que um objeto implementa os métodos de um port. Falha cedo e claro.
 * @param {object} obj @param {string} name @param {string[]} methods
 */
export function ensurePort(obj, name, methods) {
  if (!obj || typeof obj !== "object") throw new Error(`port "${name}" ausente`);
  for (const m of methods) {
    if (typeof obj[m] !== "function") throw new Error(`port "${name}" nao implementa "${m}()"`);
  }
  return obj;
}
