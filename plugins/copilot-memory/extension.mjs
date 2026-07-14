// copilot-memory — extensão do GitHub Copilot CLI/app que dá memória por PROJETO ao agente,
// consumindo o daemon do servidor de memória (native-java).
//
// PRINCÍPIO (decidido com o dono): o plugin é CLIENTE PURO. Ele descobre o daemon, deriva o
// project_id do projeto aberto (mesma escada do servidor) e CONSOME o recall. Toda a
// inteligência de escopo/hierarquia (project_id no topo; skills/tools/metadata abaixo; só
// skills globais em home) e a composição do recall são do SERVIDOR — o plugin nunca decide isso.
//
// Exporta { tools (15), canvases (painel), hooks (onSessionStart/onUserPromptSubmitted) }: memória
// escopada (status/search/recent/get/save), recall passivo two-tier, ciclo de skill (guide/save/promote/
// invalidate/list), o destilador (distill), o painel visual (memory_dashboard) e a migração de escopo
// aprovada (memory_migrate_scope).
// NB: o import de joinSession é DINÂMICO (dentro do guard no fim) — assim importar { tools, hooks }
// num harness de smoke não exige resolver @github/copilot-sdk/extension (que só existe no host).
import { discover } from "./lib/daemon.mjs";
import { tryResolveProjectId, isFragileScope, resolveFallbackProjectId, fallbackStrength } from "./lib/projectId.mjs";
import { configMetadata, projectConfigPath } from "./lib/projectConfig.mjs";
import { shouldOfferScaffold, markAsked, scaffoldGuidance } from "./lib/scaffold.mjs";
import { existsSync as existsSyncSafe } from "node:fs";
import { MemoryClient } from "./lib/client.mjs";
import { composeRecall, recallOptsFromEnv } from "./lib/recall.mjs";
import { validateSkill, buildSkillDocument, TYPE_CANDIDATE, TYPE_ACTIVE } from "./lib/skill.mjs";
import { SKILL_GUIDE } from "./lib/skillGuide.mjs";
import { recordRecall, recordFetch } from "./lib/consumption.mjs";
import { buildDigest } from "./lib/digest.mjs";
import { redact } from "./lib/redact.mjs";
import { recordDistillation, sessionDistilled, fingerprint, findFingerprint } from "./lib/ledger.mjs";
import { ensureServer, autoProvisionEnabled, resolveJava } from "./lib/provision.mjs";
import { previewMigration, migrateScope } from "./lib/migrate.mjs";
import { MemoryDashboard, DASHBOARD_CANVAS_ID, DASHBOARD_INSTANCE_ID, DASHBOARD_TITLE } from "./lib/dashboard.mjs";
import { readPersistedCwd, persistCwd } from "./lib/sessionCwd.mjs";

// Provisionamento em background disparado no máximo 1× por processo (não repete a cada hook).
let provisionKicked = false;

// Sessão do host (capturada no joinSession) — dá às tools acesso ao histórico via getEvents()
// (host/produção) ou getMessages() (smoke via createSession). No harness de smoke, __setHostSession
// injeta a sessão de teste.
let hostSession = null;
export function __setHostSession(s) { hostSession = s; }

// Painel visual (canvas) do host — instanciado no joinSession (guard); null em smoke/testes.
let dashboard = null;

// workingDirectory autoritativo. Os hooks recebem input.workingDirectory (BaseHookInput), mas a
// ToolInvocation do SDK NÃO expõe cwd. A extensão roda como processo filho forkado e normalmente
// herda o cwd da sessão — mas para blindar contra um host que forke com cwd diferente (o que faria
// as TOOLS resolverem o project_id ERRADO em silêncio, enquanto os hooks acertariam), capturamos o
// workingDirectory dos hooks e as tools preferem esse valor. No boot semeamos com o último cwd
// PERSISTIDO desta sessão — assim, após um reload da extensão, o painel/tools já resolvem o escopo
// certo sem esperar o 1º hook (evita mostrar ~/.copilot/raiz git por alguns segundos). Só cai para
// process.cwd() se não houver nada persistido.
const SELF_SESSION_ID = process.env.SESSION_ID || "";
let sessionCwd = readPersistedCwd(SELF_SESSION_ID);
function rememberCwd(wd) {
    if (wd && typeof wd === "string" && wd.trim()) {
        sessionCwd = wd.trim();
        persistCwd(SELF_SESSION_ID, sessionCwd);
    }
}
function toolCwd() {
    return sessionCwd || process.cwd();
}

// Descobre o daemon vivo e monta o cliente + project_id do diretório de trabalho dado.
// Cliente-puro: se o daemon estiver offline, retorna { ok:false } — nunca sobe nada, nunca lança.
async function connect(workingDirectory) {
    const info = await discover();
    if (!info) return { ok: false, reason: "daemon offline (sem daemon.json vivo em ~/.mcp-memory/run)" };
    return {
        ok: true,
        url: info.url,
        version: info.version ?? null,
        client: new MemoryClient(info.url),
        projectId: tryResolveProjectId(workingDirectory),
        workdir: workingDirectory,
    };
}

// Metadata escopada para escritas/buscas. Paridade REST com o mergeMetadata do servidor: aplica
// metadata.defaults + branch do .memory/project.json, garante o project_id, e deixa o metadata do
// CHAMADOR (extra) com PRIORIDADE (aplicado por último). Nunca lança.
function scopedMeta(c, extra = {}) {
    const base = {};
    try { Object.assign(base, configMetadata(c.workdir)); } catch { /* best-effort */ }
    if (c.projectId) base.project_id = c.projectId;   // o resolver já honra o declared; garante consistência
    Object.assign(base, extra);                       // chamador vence
    return base;
}

// Recall passivo ligado por padrão; COPILOT_MEMORY_DISABLE=1 desliga sem desinstalar.
function recallEnabled() {
    return process.env.COPILOT_MEMORY_DISABLE !== "1";
}

// Trunca texto para exibição concisa nos resultados das tools.
function clamp(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Query usada na abertura da sessão (não há prompt ainda): traz o estado do projeto.
const OPEN_QUERY =
    "visão geral, decisões de arquitetura, convenções e pendências recentes do projeto";

// Gera o recall para um dado workingDirectory + query. Nunca lança. Devolve o objeto de recall
// completo ({text,count,projectId,source,pointerIds}) ou null (daemon offline) — o objeto deixa
// os hooks LOGAR o consumo (quais ponteiros foram injetados). Um teto GLOBAL (overallDeadlineMs)
// garante que o hook nunca bloqueie a sessão, mesmo se as pernas de fallback rodarem em série.
async function recallBlock(workingDirectory, query, extraOpts = {}) {
    const c = await connect(workingDirectory);
    if (!c.ok) return null;
    const opts = { ...recallOptsFromEnv(), ...extraOpts };
    const deadlineMs = opts.overallDeadlineMs || 4500;
    let timer;
    const deadline = new Promise((res) => { timer = setTimeout(() => res(null), deadlineMs); });
    try {
        return await Promise.race([composeRecall(c.client, workingDirectory, query, opts), deadline]);
    } finally {
        clearTimeout(timer); // não deixa timer pendente segurando o event loop quando o recall vence
    }
}

export const tools = [
        {
            name: "memory_init_project",
            description:
                "Cria o .memory/project.json na raiz do workspace para dar um project_id ESTÁVEL e portável à memória " +
                "(em vez do caminho da pasta, que não casa entre máquinas). Analise a estrutura do projeto antes e passe " +
                "um name e um project_id canônico (ex.: 'owner/projeto'). Use skip:true para registrar que NÃO se deve " +
                "sugerir isto de novo neste workspace (ex.: pasta avulsa). Não sobrescreve um arquivo existente.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nome do projeto (curto)" },
                    projectId: { type: "string", description: "project_id canônico e estável (ex.: 'owner/projeto')" },
                    client: { type: "string", description: "Cliente (opcional)" },
                    team: { type: "string", description: "Time (opcional)" },
                    skip: { type: "boolean", description: "Se true, NÃO cria — só marca para não sugerir de novo neste workspace" },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const wd = toolCwd();
                if (args && args.skip) {
                    markAsked(wd, "declined");
                    return "Ok — não vou sugerir criar o .memory/project.json neste workspace de novo. (A memória segue com escopo pelo caminho, degradando.)";
                }
                const path = projectConfigPath(wd);
                if (existsSyncSafe(path)) return `Já existe ${path} — não sobrescrevi. Edite-o à mão se precisar ajustar.`;
                const name = String((args && args.name) || "").trim();
                const projectId = String((args && args.projectId) || "").trim();
                if (!name || !projectId) return "Faltou name e/ou projectId. Analise a estrutura do projeto e proponha um project_id canônico estável (ex.: 'owner/projeto').";
                const cfg = {
                    version: "1",
                    project: { name, ...(args.client ? { client: String(args.client) } : {}), ...(args.team ? { team: String(args.team) } : {}) },
                    metadata: { defaults: { project_id: projectId }, branches: { "feat/*": { type: "feature" }, "fix/*": { type: "bugfix" }, "main": { type: "production" } } },
                    user: { identifyBy: "git-email" },
                };
                try {
                    const { mkdirSync, writeFileSync } = await import("node:fs");
                    const { dirname } = await import("node:path");
                    mkdirSync(dirname(path), { recursive: true });
                    writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
                    markAsked(wd, "asked"); // resolvido, não sugere mais
                } catch (e) {
                    return "Erro ao criar o arquivo: " + (e?.message || e);
                }
                // Detecção de escopo OBSOLETO: há memória carimbada com o id anterior (o fallback,
                // sem a declaração)? Se sim, SINALIZA — nunca migra sozinho (migração exige aprovação
                // explícita via memory_migrate_scope). Best-effort: nunca derruba a criação do arquivo.
                let migrateHint = "";
                try {
                    const from = resolveFallbackProjectId(wd);
                    if (from && from !== projectId) {
                        const c = await connect(wd);
                        if (c.ok) {
                            const pv = await previewMigration(c.client, from, projectId, { limit: 200 });
                            if (pv.count > 0) {
                                const shared = /^git-/.test(fallbackStrength(wd));
                                migrateHint =
                                    `\n\n⚠️ Há ${pv.count}${pv.capped ? "+" : ""} documento(s) sob o escopo antigo "${from}". ` +
                                    `Para movê-los ao novo, rode memory_migrate_scope (previsualiza; confirm:true aplica).` +
                                    (shared ? ` Atenção: o escopo antigo é COMPARTILHADO (git) — migrar pode deixar a memória órfã para quem não tem o .memory/project.json.` : "");
                            }
                        }
                    }
                } catch { /* sinalização best-effort */ }
                return `✅ Criado ${path} com project_id="${projectId}". A partir de agora a memória deste projeto é escopada de forma estável (independe do caminho da pasta).` + migrateHint;
            },
        },

        {
            name: "memory_migrate_scope",
            description:
                "Migra (reatribui) documentos de um project_id ANTIGO para o NOVO via PATCH metadata-only — " +
                "sem re-chunkar/re-embedar. SEM confirm=true apenas PREVISUALIZA (conta + amostra) e NÃO altera nada. " +
                "Padrões: fromProjectId = o escopo que o projeto teria sem o .memory/project.json; toProjectId = o " +
                "project_id atual. Nunca move lições globais (só docs carimbados exatamente com fromProjectId). " +
                "Avisa quando o escopo antigo é compartilhado (git), pois migrar pode deixar a memória órfã.",
            parameters: {
                type: "object",
                properties: {
                    fromProjectId: { type: "string", description: "Escopo antigo (padrão: o id de fallback sem o .memory/project.json)" },
                    toProjectId: { type: "string", description: "Escopo novo (padrão: o project_id atual resolvido)" },
                    confirm: { type: "boolean", description: "true APLICA a migração; ausente/false só previsualiza" },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const wd = toolCwd();
                const c = await connect(wd);
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                const to = String((args && args.toProjectId) || c.projectId || "").trim();
                const fallback = resolveFallbackProjectId(wd);
                const from = String((args && args.fromProjectId) || fallback || "").trim();
                if (!from || !to) return "Não consegui determinar os escopos. Passe fromProjectId e toProjectId explicitamente.";
                if (from === to) return `Escopos iguais ("${from}") — nada a migrar.`;

                const pv = await previewMigration(c.client, from, to, { limit: 200 });
                if (pv.error) return "Erro ao previsualizar: " + pv.error;
                if (pv.count === 0) return `Nenhum documento sob o escopo antigo "${from}". Nada a migrar.`;

                // Alerta de órfão só quando o "from" é de fato o escopo git-compartilhado deste workspace.
                const shared = from === fallback && /^git-/.test(fallbackStrength(wd));

                if (!(args && args.confirm)) {
                    const sample = pv.sample
                        .map((s, i) => `  ${i + 1}. [${s.id}] ${s.name || s.type || ""}${s.text ? " · " + s.text : ""}`)
                        .join("\n");
                    return (
                        `Prévia da migração (nada foi alterado):\n` +
                        `  de:   ${from}\n` +
                        `  para: ${to}\n` +
                        `  docs: ${pv.count}${pv.capped ? "+" : ""}\n` +
                        (sample ? sample + "\n" : "") +
                        (shared ? `\n⚠️ O escopo antigo é COMPARTILHADO (git). Migrar pode deixar a memória órfã para quem não tem o .memory/project.json.\n` : "") +
                        `\nRevise. Para APLICAR, rode de novo com confirm:true.`
                    );
                }

                const res = await migrateScope(c.client, from, to, {});
                if (!res.ok && res.reason) return `❌ Migração falhou: ${res.reason} (migrados até aqui: ${res.migrated}).`;
                let msg = `✅ Migração concluída: ${res.migrated} documento(s) movido(s) de "${from}" para "${to}".`;
                if (res.failed) msg += ` ${res.failed} falharam (${res.errors.slice(0, 3).map((e) => e.id).join(", ")}${res.errors.length > 3 ? "…" : ""}).`;
                return msg;
            },
        },

        {
            name: "memory_setup",
            description:
                "Provisiona o servidor de memória quando ele ainda não existe na máquina: se não houver daemon " +
                "vivo, baixa a release pública (verificada por sha256), sobe o servidor e aguarda ele anunciar. " +
                "Se já existir, apenas reusa. É o passo de bootstrap inicial — depois o próprio servidor cuida de " +
                "singleton e updates. Pode demorar na 1ª vez (download + warmup). Requer Java 21 no PATH.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => {
                const r = await ensureServer({ waitMs: 120000 });
                if (r.ok && r.reused) return `🧠 Memória já estava ONLINE (v${r.version || "?"}). Nada a fazer.`;
                if (r.ok && r.installed) return `✅ Servidor de memória instalado e ONLINE (v${r.version || "?"}). O recall do projeto já está disponível.`;
                if (r.pending) return `⏳ ${r.reason}. Tente memory_status em alguns segundos.`;
                return `❌ Não foi possível provisionar: ${r.reason}\nAlternativa: instale o mcp-memory-server manualmente (release em AllanSantos-DV/mcp-memory-server-releases).`;
            },
        },

        {
            name: "memory_status",
            description:
                "Mostra o estado da memória do projeto: se o daemon do servidor de memória está vivo, " +
                "a URL/porta e versão, e o project_id derivado do projeto aberto. Não altera nada.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async (_args, _invocation) => {
                const cwd = toolCwd();
                const c = await connect(cwd);
                if (!c.ok) {
                    const java = resolveJava();
                    const canProvision = autoProvisionEnabled();
                    return (
                        `🧠 Memória: OFFLINE — ${c.reason}.\n` +
                        (canProvision
                            ? `Posso instalar/subir o servidor automaticamente: rode memory_setup. (Java detectado: ${java}.)`
                            : `Auto-provisionamento desligado (COPILOT_MEMORY_AUTOPROVISION=0).`)
                    );
                }
                let status = "ok";
                try {
                    const h = await c.client.health();
                    status = (h && h.status) || "ok";
                } catch {
                    status = "sem resposta ao /health";
                }
                return [
                    `🧠 Memória: ONLINE (${status})`,
                    `daemon: ${c.url}${c.version ? ` (v${c.version})` : ""}`,
                    `projeto aberto: ${cwd}`,
                    `project_id: ${c.projectId ?? "(não resolvido — sem git remote/caminho)"}`,
                ].join("\n");
            },
        },

        {
            name: "memory_dashboard",
            description:
                "Abre o painel visual da memória no canvas lateral: saúde do daemon, escopo do projeto (com a " +
                "escada de resolução do project_id), documentos recentes, skills e telemetria de recall. Só leitura.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => {
                if (!hostSession || !dashboard) return "Painel indisponível nesta sessão (host não conectado).";
                try {
                    await dashboard.ensureServer();
                    await hostSession.rpc.canvas.open({ canvasId: DASHBOARD_CANVAS_ID, instanceId: DASHBOARD_INSTANCE_ID });
                    return "🧠 Painel de memória aberto no canvas lateral.";
                } catch (e) {
                    return "Não consegui abrir o painel: " + (e?.message || e);
                }
            },
        },

        {
            name: "memory_search",
            description:
                "Busca semântica na memória DO PROJETO aberto (escopada por project_id — nunca traz " +
                "memória de outros produtos). Use para recuperar decisões, conhecimento ou notas específicas " +
                "além do que já entrou automaticamente no contexto.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "O que buscar" },
                    topK: { type: "integer", description: "Máximo de resultados (padrão 5)" },
                },
                required: ["query"],
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                if (!c.projectId) return "Sem project_id resolvido para o projeto aberto — busca escopada indisponível (evita vazar memória de outros produtos).";
                let r;
                try {
                    r = await c.client.search(String(args.query || ""), { topK: args.topK || 5, metadata: { project_id: c.projectId } });
                } catch (e) {
                    return "Erro na busca: " + (e?.message || e);
                }
                const hits = (r && r.results) || [];
                if (!hits.length) return `Nada encontrado na memória do projeto (${c.projectId}).`;
                return hits.map((h, i) => `${i + 1}. (${(Number(h.score) || 0).toFixed(2)}) [${h.documentId}]\n   ${clamp(h.text, 240)}`).join("\n");
            },
        },

        {
            name: "memory_recent",
            description: "Lista os documentos mais recentes da memória DO PROJETO aberto (escopado por project_id).",
            parameters: {
                type: "object",
                properties: { limit: { type: "integer", description: "Máximo de itens (padrão 10)" } },
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                if (!c.projectId) return "Sem project_id resolvido — indisponível.";
                let r;
                try {
                    r = await c.client.recent({ limit: args.limit || 10, metadata: { project_id: c.projectId } });
                } catch (e) {
                    return "Erro: " + (e?.message || e);
                }
                const docs = (r && r.data) || [];
                if (!docs.length) return `Sem documentos recentes no projeto (${c.projectId}).`;
                return docs.map((d, i) => `${i + 1}. [${d.id}] ${clamp(d.content, 160)}`).join("\n");
            },
        },

        {
            name: "memory_get",
            description: "Recupera o conteúdo completo de um documento da memória pelo seu id (drill-down de um item mostrado na busca/recall).",
            parameters: {
                type: "object",
                properties: { documentId: { type: "string", description: "Id do documento" } },
                required: ["documentId"],
                additionalProperties: false,
            },
            handler: async (args, invocation) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                let d;
                try {
                    d = await c.client.getDocument(String(args.documentId || ""));
                } catch (e) {
                    return "Documento não encontrado ou erro: " + (e?.message || e);
                }
                if (!d) return "Documento não encontrado.";
                // P0: registra o FETCH (para correlacionar com o ponteiro injetado no recall).
                recordFetch({ sessionId: invocation?.sessionId, projectId: c.projectId, id: String(args.documentId || "") });
                const meta = d.metadata ? JSON.stringify(d.metadata) : "{}";
                return `[${d.id}]\nmetadata: ${meta}\n\n${d.content || ""}`;
            },
        },

        {
            name: "memory_save",
            description:
                "Salva uma decisão/nota/conhecimento na memória DO PROJETO aberto, carimbando o escopo (project_id). " +
                "Isolado ao projeto — não afeta outros produtos. Para procedimentos reusáveis (skills), use memory_save_skill; " +
                "para destilar aprendizados da sessão em skills, use memory_distill.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "O conteúdo a salvar" },
                    type: { type: "string", description: "Categoria: knowledge (padrão), decision, note, bugfix" },
                    tags: { type: "array", items: { type: "string" }, description: "Tags para busca futura" },
                },
                required: ["content"],
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                if (!c.projectId) return "Sem project_id resolvido — não salvo (evita gravar sem escopo, o que vazaria entre produtos).";
                const content = String(args.content || "").trim();
                if (!content) return "Conteúdo vazio — nada salvo.";
                // scopedMeta aplica os defaults/branch do .memory/project.json (paridade REST); o
                // type/source/tags do chamador vencem.
                const extra = { type: args.type || "knowledge", source: "copilot" };
                if (Array.isArray(args.tags) && args.tags.length) extra.tags = args.tags;
                const metadata = scopedMeta(c, extra);
                let res;
                try {
                    res = await c.client.save(content, metadata);
                } catch (e) {
                    return "Erro ao salvar: " + (e?.message || e);
                }
                const id = (res && (res.id || res.documentId)) || "?";
                return `Salvo na memória do projeto (${c.projectId}) · id=${id} · type=${metadata.type}`;
            },
        },

        {
            name: "memory_distill",
            description:
                "DESTILADOR de aprendizado: leia a sessão atual e proponha skills reusáveis. Chame de forma DELIBERADA " +
                "após um marco confirmado (teste passou, build verde, o usuário confirmou que funcionou, checkpoint aprovado) — " +
                "NÃO chame no fim de toda sessão nem por reflexo. Ele monta um digest evidence-first da sessão (execuções de " +
                "ferramenta com sucesso = sinal verificável), redige segredos, checa o que já foi destilado, e devolve uma TAREFA " +
                "de reflexão com rubrica: extraia só o que é generalizável E verificado, cada skill citando a evidência (id de tool " +
                "com success=true ou confirmação do usuário). Depois use memory_save_skill (nasce candidate).",
            parameters: {
                type: "object",
                properties: {
                    reason: { type: "string", description: "O marco que justifica destilar agora (ex.: 'testes passaram', 'usuário confirmou')" },
                },
                additionalProperties: false,
            },
            handler: async (args, invocation) => {
                // A session do joinSession (HOST/produção) expõe getEvents(); a de createSession (usada
                // nos smokes) expõe getMessages(). Ambos retornam SessionEvent[] no MESMO formato. O
                // distill roda no host, então preferimos getEvents(); getMessages fica de fallback para
                // robustez cross-runtime. (Descoberto por dogfooding: o .d.ts anuncia só getMessages,
                // mas o runtime do host tem getEvents — como o askUserBridge do copilot-mobile já usa.)
                const readHistory =
                    (hostSession && typeof hostSession.getEvents === "function") ? () => hostSession.getEvents()
                    : (hostSession && typeof hostSession.getMessages === "function") ? () => hostSession.getMessages()
                    : null;
                if (!readHistory) {
                    return "Destilação indisponível: a session do host não expõe getEvents/getMessages (plugin não carregado pelo host?).";
                }
                let msgs;
                try {
                    msgs = await readHistory();
                } catch (e) {
                    return "Não foi possível ler a sessão: " + (e?.message || e);
                }
                const sid = invocation?.sessionId || null;
                if (sid && sessionDistilled(sid)) {
                    return "Esta sessão já foi destilada antes (ledger). Só destile de novo se houve um NOVO aprendizado verificado desde então; caso contrário, evite duplicar.";
                }
                const { text, evidence, stats } = buildDigest(msgs, { maxChars: 7000 });
                const red = redact(text);
                const toolOracles = evidence.filter((e) => e.kind === "tool" && e.success).map((e) => e.id);
                const userSignals = evidence.filter((e) => e.kind === "user").map((e) => e.id);
                if (!toolOracles.length && !userSignals.length) {
                    return (
                        "Nada VERIFICÁVEL para destilar: a sessão não tem execução de ferramenta bem-sucedida nem confirmação " +
                        "explícita do usuário. Sem oráculo (sinal machine-checkable), destilar seria só reafirmar o que o agente " +
                        "achou que funcionou. Não crie skill agora."
                    );
                }
                return [
                    "# Tarefa de reflexão — destilar aprendizado(s) desta sessão",
                    `_${red.count} trecho(s) sensível(is) redigido(s) · ${stats.toolOk} tool ok / ${stats.toolFail} falhas · ${stats.userMsgs} msgs do usuário._`,
                    "",
                    "## Regras (duras)",
                    "1. Só proponha o que é **generalizável** (serve além desta sessão) E **verificado** por um sinal concreto abaixo.",
                    "2. CADA skill DEVE citar a evidência: id(s) de `[TOOL …]` com success=true, ou `[USER …]` de confirmação. Sem citação verificável → NÃO proponha.",
                    "3. Descarte: tentativa-e-erro, detalhe efêmero, específico-demais, não confirmado.",
                    "4. Formato: siga `memory_skill_guide` (name/description PT com 'quando NÃO usar'; body EN What/When/Do/Don't). A description é o gatilho do recall.",
                    "5. Se nada aqui for realmente reusável+verificado, responda que **não há skill a criar** — resposta vazia é válida e preferível a lixo.",
                    "6. Ao salvar, chame `memory_save_skill` com o campo `evidence` (os ids citados). Nasce candidate; a promoção é humana.",
                    "",
                    `Oráculos disponíveis (tool success): ${toolOracles.slice(0, 20).join(", ") || "(nenhum)"}`,
                    `Sinais do usuário: ${userSignals.slice(0, 20).join(", ") || "(nenhum)"}`,
                    "",
                    "## Digest evidence-first (redigido)",
                    red.text || "(vazio)",
                ].join("\n");
            },
        },

        {
            name: "memory_skill_guide",
            description:
                "Retorna o GUIA de autoria de skill de memória (o quê / porquê / fazer / não fazer): formato " +
                "name+description PT + corpo EN (## What / ## When to use / ## Do / ## Don't), regras da description " +
                "(específica, com 'não use quando'), atomicidade, pitfalls e um exemplo real. " +
                "Chame ANTES de memory_save_skill quando for destilar um aprendizado em skill.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => SKILL_GUIDE,
        },

        {
            name: "memory_save_skill",
            description:
                "Salva uma SKILL de conhecimento (procedimento reusável) na memória do projeto aberto. " +
                "name+description em PT (casam com a busca em PT); body em EN com seções ## What / ## When to use / ## Do / ## Don't. " +
                "Em dúvida sobre o formato, chame memory_skill_guide antes. " +
                "Nasce como CANDIDATE (não entra em recall automático até ser promovida). NÃO sobrescreve skill similar existente. " +
                "Skills globais estão desabilitadas no MVP (apenas projeto).",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nome curto em PT (≤64)" },
                    description: { type: "string", description: "PT (≤1024): o que faz E quando usar (e quando NÃO usar)" },
                    body: { type: "string", description: "Corpo em EN. Seções: ## What / ## When to use / ## Do / ## Don't" },
                    tags: { type: "array", items: { type: "string" }, description: "Tags de recuperação" },
                    evidence: { type: "array", items: { type: "string" }, description: "Ids de evidência (de memory_distill: ids de [TOOL success=true]/[USER confirmação]) que provam que a skill é verificada. Recomendado ao destilar." },
                },
                required: ["name", "description", "body"],
                additionalProperties: false,
            },
            handler: async (args, invocation) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                if (!c.projectId) return "Sem project_id resolvido — skill não salva (evita escopo errado/vazamento).";
                const v = validateSkill(args);
                if (!v.ok) return "Skill inválida:\n- " + v.errors.join("\n- ");
                // Duplicação temporal (ledger): a mesma lição já foi destilada antes?
                const fp = fingerprint(c.projectId, args.name, args.description);
                const prior = findFingerprint(fp);
                // Dedup PRÉVIO — guardrail: NÃO sobrescreve, só avisa. Busca SEM minScore: passar
                // minScore faz o servidor entrar num modo de score NÃO-normalizado (BM25/híbrido,
                // escala ~0..N) em vez do cosine 0..1 — validado ao vivo (sem minScore=0.63; com
                // minScore=17.9/85.9 pra mesma dupla). Aplicamos o corte no CLIENTE sobre o cosine:
                // só >=0.90 é duplicata REAL. Assim skills do mesmo domínio (ex.: várias sobre o SDK
                // do Copilot) não se bloqueiam entre si por vocabulário compartilhado.
                try {
                    const sim = await c.client.search(`${args.name}\n${args.description}`, { topK: 3, metadata: { project_id: c.projectId } });
                    const dupe = (sim.results || []).find((r) => Number(r.score) >= 0.90);
                    if (dupe) {
                        return `⚠️ Já existe skill muito similar (cosine ${(Number(dupe.score) || 0).toFixed(2)}) [${dupe.documentId}]. NÃO sobrescrevi. Revise com memory_get; para substituir, invalide a antiga (memory_invalidate_skill) e recrie.`;
                    }
                } catch { /* dedup best-effort */ }
                if (prior) {
                    return `⚠️ Lição equivalente já destilada ${prior.occurrences}× antes (ledger, fp=${fp}). Recorrência é sinal de que é generalizável, mas NÃO duplique: promova/revise a skill existente em vez de criar outra. Se for genuinamente nova, ajuste name/description.`;
                }
                const evidence = Array.isArray(args.evidence) && args.evidence.length ? args.evidence : ["agent_capture"];
                const { content, metadata } = buildSkillDocument({ ...args, projectId: c.projectId, sessionId: invocation?.sessionId, evidence });
                let res;
                try {
                    res = await c.client.save(content, metadata);
                } catch (e) {
                    return "Erro ao salvar skill: " + (e?.message || e);
                }
                const id = (res && (res.id || res.documentId)) || "?";
                // registra no ledger de destilação (duplicação temporal)
                recordDistillation({ sessionId: invocation?.sessionId, projectId: c.projectId, name: args.name, description: args.description, memoryId: id });
                const hasRealEvidence = Array.isArray(args.evidence) && args.evidence.length;
                const warn = v.warnings.length ? "\nAvisos: " + v.warnings.join("; ") : "";
                const evNote = hasRealEvidence ? "" : "\n⚠️ Sem evidência citada — se veio de destilação, cite os ids de tool success/confirmação (o gate de qualidade depende disso).";
                return `Skill salva como CANDIDATE · id=${id} · project_id=${c.projectId}${warn}${evNote}\nEla NÃO entra em recall automático até ser validada com memory_promote_skill.`;
            },
        },

        {
            name: "memory_promote_skill",
            description:
                "Promove uma skill CANDIDATE a ATIVA — só então ela passa a entrar no recall automático. " +
                "Use apenas após validar que a skill está correta e é reusável (é o gate de qualidade: nada auto-injetável sem confirmação).",
            parameters: {
                type: "object",
                properties: { documentId: { type: "string", description: "Id da skill candidate" } },
                required: ["documentId"],
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                let doc;
                try {
                    doc = await c.client.getDocument(String(args.documentId || ""));
                } catch (e) {
                    return "Skill não encontrada: " + (e?.message || e);
                }
                if (!doc) return "Skill não encontrada.";
                const md = doc.metadata || {};
                if (md.type !== TYPE_CANDIDATE) return `Documento [${args.documentId}] não é uma skill candidate (type=${md.type}). Nada a promover.`;
                const upserts = { type: TYPE_ACTIVE, status: "active", confidence: "medium", promoted_at: new Date().toISOString() };
                // Lifecycle (ADR-016, servidor ≥2.19.0): PATCH metadata-only — NÃO re-chunka/re-embeda.
                try {
                    await c.client.patchMetadata(String(args.documentId || ""), upserts);
                } catch (e) {
                    return `Erro ao promover [${args.documentId}]: ${e?.message || e}. A promoção usa PATCH /documents/{id} (metadata-only, ADR-016) — requer o servidor native-java 2.19.0+. Atualize o servidor.`;
                }
                return `Skill [${args.documentId}] PROMOVIDA → ativa (metadata-only, sem re-chunkar). Agora entra no recall automático (bloco skill do projeto).`;
            },
        },

        {
            name: "memory_invalidate_skill",
            description:
                "Invalida uma skill (ou documento) pelo id — o CAMINHO DE SAÍDA para conhecimento errado ou desatualizado, " +
                "para não contaminar recalls futuros. A skill SAI do recall mas os bytes são PRESERVADOS (auditável/reversível, " +
                "lifecycle ADR-016). Recusa invalidar conteúdo curado por humano (source diferente do auto-capture).",
            parameters: {
                type: "object",
                properties: {
                    documentId: { type: "string", description: "Id do documento/skill" },
                    reason: { type: "string", description: "Por que está invalidando" },
                },
                required: ["documentId"],
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                // Guardrail: auto-capture nunca remove conteúdo humano/curado.
                try {
                    const doc = await c.client.getDocument(String(args.documentId || ""));
                    const src = doc && doc.metadata ? doc.metadata.source : null;
                    if (src && src !== "copilot-autoskill" && src !== "copilot") {
                        return `Recusado: [${args.documentId}] tem source="${src}" (curado por humano/outra fonte). Auto-capture não remove conteúdo humano.`;
                    }
                } catch { /* se não achar, o feedback abaixo retorna erro claro */ }
                // Lifecycle (ADR-016, servidor ≥2.19.0): verdict=wrong → sai do recall (hard-filter),
                // PRESERVANDO os bytes (auditável/reversível). Provado ao vivo: some do search e do
                // compose, GET continua retornando o content. Sem fallback destrutivo (DELETE apagaria
                // os bytes, violando o invariante ADR-007/008).
                try {
                    await c.client.feedback(String(args.documentId || ""), "wrong", { reason: args.reason || "invalidada pelo agente" });
                } catch (e) {
                    return `Erro ao invalidar [${args.documentId}]: ${e?.message || e}. A invalidação usa POST /documents/{id}/feedback (lifecycle, ADR-016) — requer o servidor native-java 2.19.0+ (e o feedback habilitado). Atualize o servidor.`;
                }
                return `Invalidada [${args.documentId}] (lifecycle: verdict=wrong → sai do recall, bytes preservados)${args.reason ? " · motivo: " + args.reason : ""}.`;
            },
        },

        {
            name: "memory_list_skills",
            description: "Lista as skills (candidate e ativas) da memória do projeto aberto — para revisar, promover, invalidar ou evitar duplicar.",
            parameters: {
                type: "object",
                properties: { limit: { type: "integer", description: "Máximo de itens (padrão 20)" } },
                additionalProperties: false,
            },
            handler: async (args) => {
                const c = await connect(toolCwd());
                if (!c.ok) return `🧠 Memória offline: ${c.reason}`;
                if (!c.projectId) return "Sem project_id resolvido.";
                const out = [];
                for (const t of [TYPE_ACTIVE, TYPE_CANDIDATE]) {
                    try {
                        const r = await c.client.list({ limit: args.limit || 20, metadata: { project_id: c.projectId, type: t } });
                        for (const d of (r && r.data) || []) {
                            const nm = (d.metadata && d.metadata.name) || "(sem nome)";
                            const st = (d.metadata && d.metadata.status) || (t === TYPE_ACTIVE ? "active" : "candidate");
                            out.push(`- [${d.id}] ${nm} · ${st}`);
                        }
                    } catch { /* ignora tipo sem resultados */ }
                }
                if (!out.length) return `Sem skills no projeto (${c.projectId}).`;
                return `Skills do projeto (${c.projectId}):\n` + out.join("\n");
            },
        },
];

export const hooks = {
        // Abertura da sessão: injeta o estado/decisões do projeto aberto como contexto inicial.
        onSessionStart: async (input) => {
            rememberCwd(input.workingDirectory);
            // Bootstrap oportunista: se não há daemon e auto-provisionamento está ligado, dispara UMA vez
            // em BACKGROUND (fire-and-forget). Não bloqueia o hook nem o recall desta sessão — quando o
            // servidor subir, os próximos prompts já terão memória. Consentimento: documentado no README.
            if (!provisionKicked && autoProvisionEnabled()) {
                provisionKicked = true;
                (async () => { try { const info = await discover(); if (!info) await ensureServer(); } catch { /* fail-open */ } })();
            }
            if (!recallEnabled()) return;
            // Nudge asked-once de scaffold: se o escopo é FRÁGIL (path/nome) e eu ainda não perguntei
            // neste workspace, injeto UMA vez a guia p/ criar o .memory/project.json e marco "asked"
            // (nas próximas, silêncio — X de zero). Não força; a criação é decisão do agente/usuário.
            let scaffoldBlock = null;
            try {
                const wd = input.workingDirectory;
                if (shouldOfferScaffold(wd, isFragileScope(wd))) {
                    scaffoldBlock = scaffoldGuidance(wd);
                    markAsked(wd, "asked");
                }
            } catch { /* best-effort, nunca derruba a sessão */ }
            try {
                const r = await recallBlock(input.workingDirectory, OPEN_QUERY, { minScore: 0.5 });
                if (r && r.text) {
                    recordRecall({ sessionId: input.sessionId, projectId: r.projectId, source: r.source, pointerIds: r.pointerIds, count: r.count });
                    return { additionalContext: scaffoldBlock ? `${scaffoldBlock}\n\n${r.text}` : r.text };
                }
            } catch { /* hook nunca derruba a sessão */ }
            if (scaffoldBlock) return { additionalContext: scaffoldBlock };
        },

        // A cada prompt: recall relevante ao que o usuário pediu (RAG por turno).
        onUserPromptSubmitted: async (input) => {
            rememberCwd(input.workingDirectory);
            if (!recallEnabled()) return;
            const q = String(input.prompt || "").trim();
            if (q.length < 4) return; // ignora prompts triviais
            try {
                const r = await recallBlock(input.workingDirectory, q);
                if (r && r.text) {
                    recordRecall({ sessionId: input.sessionId, projectId: r.projectId, source: r.source, pointerIds: r.pointerIds, count: r.count });
                    return { additionalContext: r.text };
                }
            } catch { /* hook nunca derruba a sessão */ }
        },
};

// Entry do host: só junta à sessão quando NÃO está em modo smoke/teste (evita joinSession no import,
// permitindo importar { tools, hooks } num harness isolado).
if (!process.env.COPILOT_MEMORY_SMOKE) {
    const { joinSession, createCanvas } = await import("@github/copilot-sdk/extension");
    // Painel visual (canvas): o server é SDK-free (lib/dashboard.mjs) e testável; o provisioner injeta
    // ensureServer sem acoplar o SDK ao módulo. createCanvas só existe aqui, no host.
    dashboard = new MemoryDashboard({
        cwdProvider: () => toolCwd(),
        provisioner: async () => ensureServer({ waitMs: 120000 }),
    });
    const memoryCanvas = createCanvas({
        id: DASHBOARD_CANVAS_ID,
        displayName: "Memory",
        description: "Painel da memória do projeto: saúde do daemon, escopo, documentos, skills e telemetria de recall.",
        open: async () => {
            await dashboard.ensureServer();
            return { title: DASHBOARD_TITLE, url: dashboard.url };
        },
    });
    const session = await joinSession({ tools, canvases: [memoryCanvas], hooks });
    hostSession = session;
    session.log?.("copilot-memory ativo — discovery + auto-provisionamento + recall two-tier + painel + tools de memória, skill e destilação.");
}
