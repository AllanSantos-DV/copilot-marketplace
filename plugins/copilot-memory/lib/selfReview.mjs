// Self-review gate — G0 DETECT-ONLY (mede, nunca bloqueia, nunca injeta).
//
// A revisão externa adversarial (que pegou furos graves no M4) vira um recurso do plugin. Mas o
// veredito da revisão externa do design (files/design-self-review-gate.md §10) e a validação AO VIVO
// do SDK impõem o teto honesto:
//   • ENFORCE é inviável: o onPreToolUse de extensão NÃO dispara p/ tools do host (provado no gate de
//     push) — logo NÃO dá pra bloquear o ask_user antes de perguntar. Command hook só pega "Bash".
//   • O único ponto de captura da saída do agente é session.on("assistant.message") — que é a RESPOSTA
//     FINAL (pós-emissão, doc do SDK). Então G0 = detect-only: observa, roda o gate barato e LOGA quando
//     ACENDERIA (com classe + score + margem), para medir precisão/recall/latência ANTES de qualquer
//     coisa intrusiva. Suggest (injetar crítica num turno seguinte via session.send) é fatia futura (G1).
//
// Gatilho semântico SEM regex e SEM embedder local: frases-protótipo dos "momentos que merecem revisão"
// são gravadas no servidor como documentos type:"review_trigger" (global), e o roteamento é um
// POST /api/v1/search da saída candidata contra esses protótipos — reusa o bge-m3 do servidor.
// IMPORTANTE: a busca é feita SEM minScore (nossa lição: minScore muda o modo de score do servidor p/
// não-normalizado; precisamos de cosseno 0..1 comparável). O corte é client-side.
//
// handleSearch NÃO devolve metadata (só {text,score,documentId,chunkIndex}) → mantemos um MAPA LOCAL
// documentId→trigger_class ao cadastrar os protótipos (design §10 #1).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { redact } from "./redact.mjs";

import { stateDir as dir } from "./paths.mjs";
export function selfReviewConfigPath() { return join(dir(), "selfreview.json"); }
export function selfReviewFile() { return join(dir(), "selfreview.jsonl"); }
export function triggerMapPath() { return join(dir(), "review-triggers.json"); }

// Modo por ARQUIVO (não por env — o app forka a extensão e injetar env é inviável). Default "off":
// observar a saída do agente é opt-in (privacidade — a resposta pode ter conteúdo sensível). Valores:
// "off" | "probe" (só loga o disparo cru) | "detect-only" (loga o disparo + o veredito do gate).
export function selfReviewMode() {
    try {
        const raw = readFileSync(selfReviewConfigPath(), "utf8");
        const m = JSON.parse(raw)?.mode;
        if (m === "probe" || m === "detect-only" || m === "off") return m;
    } catch { /* ausente/ilegível = off */ }
    return "off";
}

// Protótipos = DADOS (frases-exemplo), não regex. O casamento é semântico (embeddings). pt-BR primeiro
// (o usuário trabalha em pt-BR; a busca é multilíngue), com alguns em EN. Classes do design §3.
const PROTOTYPES = {
    decision: [
        "decidi usar X em vez de Y",
        "a abordagem vai ser a seguinte",
        "vou arquitetar assim",
        "optei por esta solução",
        "a decisão é seguir por este caminho",
        "escolhi esta biblioteca em vez da outra",
        "I decided to use this approach instead of the alternative",
    ],
    open_question: [
        "qual você prefere, a opção A ou a opção B?",
        "temos duas opções, qual seguimos?",
        "deixo essa decisão para você",
        "quer que eu siga por esse caminho?",
        "prefere que eu faça de um jeito ou de outro?",
        "which option do you want me to take, A or B?",
    ],
    high_impact: [
        "isto é irreversível",
        "isso afeta todos os projetos",
        "isso sobrescreve o que já existe",
        "não dá para desfazer depois",
        "vai apagar dados em produção",
        "essa mudança é destrutiva",
        "this is irreversible and affects everything",
    ],
    hedging: [
        "acho que deve funcionar",
        "provavelmente é isso",
        "não tenho certeza, mas",
        "talvez seja por aqui",
        "imagino que funcione assim",
        "I think this should probably work but I'm not sure",
    ],
};

function prototypesHash() {
    return createHash("sha256").update(JSON.stringify(PROTOTYPES)).digest("hex").slice(0, 16);
}

// Limiar PROVISÓRIO por classe só para computar um booleano "wouldFire" de conveniência. O que importa
// para calibração é o score+margem CRUS logados (design §10 #2: threshold por classe vem do dataset,
// não de um 0.6 chutado). Ajustável depois com os dados reais.
const PROVISIONAL_THRESHOLD = { decision: 0.55, open_question: 0.55, high_impact: 0.5, hedging: 0.58 };

// Orçamento anti-flood por sessão + dedup por hash do segmento (design §6).
const MAX_EVALS_PER_SESSION = 20;
const _budget = new Map();      // sessionId -> count
const _seen = new Set();        // hash de segmento já avaliado (por processo)
let _triggerMap = null;         // { hash, map: {documentId: trigger_class} } em memória (cache)

function hash(s) { return createHash("sha256").update(String(s)).digest("hex").slice(0, 24); }

// redact() pode devolver string OU { text, count }; normaliza para string (dataset limpo).
function redText(s) {
    const r = redact(String(s || ""));
    if (typeof r === "string") return r;
    return r && typeof r.text === "string" ? r.text : "";
}

// Segmenta o BLOCO DECISÓRIO: avalia só o final da resposta (últimos parágrafos), não a mensagem
// inteira — evita diluir o vetor num texto longo (design §10 #2). É posicional, não semântico.
export function segmentDecisional(content) {
    const text = String(content || "").trim();
    if (!text) return "";
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const tail = paras.slice(-2).join("\n\n");
    const seg = tail || text;
    return seg.length > 600 ? seg.slice(-600) : seg;
}

// Cadastra os protótipos como documentos globais type:"review_trigger" (idempotente por stamp) e
// devolve o mapa documentId→trigger_class. Best-effort: se o daemon estiver offline, devolve null.
export async function ensureTriggers({ client }) {
    if (_triggerMap && _triggerMap.hash === prototypesHash()) return _triggerMap.map;
    // Reusa o mapa persistido se o stamp de protótipos bate.
    try {
        if (existsSync(triggerMapPath())) {
            const saved = JSON.parse(readFileSync(triggerMapPath(), "utf8"));
            if (saved && saved.hash === prototypesHash() && saved.map && Object.keys(saved.map).length) {
                _triggerMap = saved;
                return saved.map;
            }
        }
    } catch { /* segue e recadastra */ }
    if (!client) return null;
    const map = {};
    for (const [cls, phrases] of Object.entries(PROTOTYPES)) {
        for (const phrase of phrases) {
            try {
                const res = await client.save(phrase, {
                    type: "review_trigger",
                    trigger_class: cls,
                    source: "copilot-selfreview",
                });
                const id = res?.id || res?.documentId || res?.data?.id;
                if (id) map[String(id)] = cls;
            } catch { /* best-effort por frase */ }
        }
    }
    if (!Object.keys(map).length) return null;
    _triggerMap = { hash: prototypesHash(), map };
    try { mkdirSync(dir(), { recursive: true }); writeFileSync(triggerMapPath(), JSON.stringify(_triggerMap), "utf8"); } catch { /* cache best-effort */ }
    return map;
}

// Roda o gate barato: busca o segmento contra os protótipos (SEM minScore) e projeta o topo por classe.
export async function evaluate(segment, { client, map = {}, timeoutMs = 2500 }) {
    const r = await client.search(segment, { topK: 5, metadata: { type: "review_trigger" }, timeoutMs });
    const results = Array.isArray(r?.results) ? r.results : [];
    const ranked = results
        .map((h) => ({ score: Number(h.score) || 0, cls: map[String(h.documentId)] || null }))
        .filter((h) => h.cls)
        .sort((a, b) => b.score - a.score);
    if (!ranked.length) return { top1Class: null, top1Score: 0, margin: 0, hits: 0 };
    const top1 = ranked[0];
    const top2 = ranked[1];
    return {
        top1Class: top1.cls,
        top1Score: Math.round(top1.score * 1000) / 1000,
        margin: Math.round((top1.score - (top2 ? top2.score : 0)) * 1000) / 1000,
        hits: ranked.length,
    };
}

function logRec(rec) {
    try {
        mkdirSync(dir(), { recursive: true });
        appendFileSync(selfReviewFile(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
    } catch { /* nunca interfere na sessão */ }
}

/**
 * Arma o observador de self-review na sessão do host. NÃO bloqueia, NÃO injeta. Idempotente por sessão.
 * @param {object} session  a sessão do joinSession (precisa de .on).
 * @param {{ sessionId?:string, connect:(wd:string)=>Promise<any>, workingDirectory?:string, log?:(m:string)=>void }} deps
 * @returns {(()=>void)|null} função de unsubscribe, ou null se off/indisponível.
 */
export function armSelfReview(session, { sessionId, connect, workingDirectory, log } = {}) {
    const mode = selfReviewMode();
    if (mode === "off") return null;
    if (!session || typeof session.on !== "function") { log?.("session.on indisponível — self-review não armado"); return null; }
    const sid = sessionId || "";
    let unsub = null;
    try {
        unsub = session.on("assistant.message", (ev) => {
            (async () => {
                try {
                    const content = ev?.data?.content ?? ev?.content ?? "";
                    const text = typeof content === "string" ? content : JSON.stringify(content || "");
                    if (!text.trim()) return;
                    // (1) SEMPRE loga o disparo cru — é a PROVA ao vivo de que session.on dispara no joinSession.
                    // Redige ANTES de cortar (revisão Low): cortar primeiro poderia deixar um fragmento de
                    // segredo que cruza a borda escapar do padrão do redact.
                    logRec({ kind: "fire", sessionId: sid, mode, len: text.length, sample: redText(text).slice(0, 200) });
                    if (mode === "probe") return;
                    // (2) detect-only: orçamento + dedup.
                    const seg = segmentDecisional(text);
                    if (!seg) return;
                    const h = hash(seg);
                    if (_seen.has(h)) return;
                    const used = _budget.get(sid) || 0;
                    if (used >= MAX_EVALS_PER_SESSION) return;
                    _budget.set(sid, used + 1);
                    _seen.add(h);
                    const c = await connect(workingDirectory);
                    if (!c || !c.ok || !c.client) { logRec({ kind: "eval", sessionId: sid, error: "daemon-offline" }); return; }
                    const map = await ensureTriggers({ client: c.client });
                    if (!map) { logRec({ kind: "eval", sessionId: sid, error: "no-triggers" }); return; }
                    const t0 = Date.now();
                    const ev2 = await evaluate(seg, { client: c.client, map });
                    const ms = Date.now() - t0;
                    const wouldFire = !!(ev2.top1Class && ev2.top1Score >= (PROVISIONAL_THRESHOLD[ev2.top1Class] ?? 0.6));
                    logRec({
                        kind: "eval", sessionId: sid, ms,
                        top1Class: ev2.top1Class, top1Score: ev2.top1Score, margin: ev2.margin, hits: ev2.hits,
                        wouldFire, segment: redText(seg).slice(0, 300),
                    });
                } catch (e) { logRec({ kind: "error", sessionId: sid, error: String(e?.message || e).slice(0, 160) }); }
            })();
        });
        log?.(`self-review armado (mode=${mode})`);
    } catch (e) { log?.("falha ao armar self-review: " + (e?.message || e)); return null; }
    return unsub;
}

// Leitura/telemetria do dataset (para calibrar precisão/recall + latência).
export function readSelfReview(limit = 500) {
    try {
        const raw = readFileSync(selfReviewFile(), "utf8").trim();
        if (!raw) return [];
        return raw.split("\n").slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

export function summarizeSelfReview() {
    const rows = readSelfReview(10000);
    let fires = 0, evals = 0, wouldFire = 0;
    const byClass = {};
    const lat = [];
    for (const r of rows) {
        if (r.kind === "fire") fires++;
        if (r.kind === "eval" && !r.error) {
            evals++;
            if (r.wouldFire) wouldFire++;
            if (r.top1Class) byClass[r.top1Class] = (byClass[r.top1Class] || 0) + 1;
            if (typeof r.ms === "number") lat.push(r.ms);
        }
    }
    lat.sort((a, b) => a - b);
    const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0);
    return { fires, evals, wouldFire, byClass, latencyMs: { p50: pct(50), p95: pct(95), max: lat[lat.length - 1] || 0 } };
}
