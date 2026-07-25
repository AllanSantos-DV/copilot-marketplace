// findings-tracker.mjs — CICLO DE VIDA + DEDUP determinístico dos achados do modo-sombra (reforma Fase 3).
// Resolve dois problemas do dono: (1) o sombra RE-EMITE o mesmo achado (loop) → dedup L1 (hash exato) + L2
// (semântico, re-frasado); (2) achados sem marcador/estado → máquina de estados rastreável por HASH estável.
//
// L1: SHA-256 do texto NORMALIZADO (lowercase + colapso de espaço) → id/marcador estável e hasheável.
// L2: dedup semântico via cosineDistance < `dupDistance` (0.15 = similaridade > 0.85). ATENÇÃO: cosineDistance
//     (driftSignal) é 1 - cos → 0 = idêntico. Duplicado = distância PEQUENA. (NÃO "coseno > 0.85" literal.)
// Estados: emitted → addressed → resolved | rejected | expired. Transições append-only, AUDITÁVEIS. Mapa ao padrão
// de mercado (lifecycle de comentário de code review, não LSP diagnostic que é stateless): emitted≈open/pending,
// addressed≈acknowledged/in-progress (INTERNO — silencia re-emissão + mantém ACTIVE p/ dedup; não é UI/badge, é
// estado de fluxo), resolved≈resolved, rejected≈won't-fix/dismissed, expired≈outdated/stale.
// Persistência: append-log JSONL com CHECKSUM por linha; reduce-on-boot IDEMPOTENTE e CRASH-SAFE (linha
// corrompida/parcial/torn = pulada, nunca derruba). FAIL LOUD em uso inválido (estado desconhecido, hash ausente).
import { createHash } from "node:crypto";
import { cosineDistance } from "../embed/driftSignal.mjs";
import { normalizeProvenanceTarget, normalizeProvenanceSources, computeCitationComplete } from "./provenanceSchema.mjs";

const STATES = new Set(["emitted", "addressed", "resolved", "rejected", "expired"]);
const ACTIVE = new Set(["emitted", "addressed"]); // findings "vivos" (contam pra dedup e re-emissão)
const TERMINAL = new Set(["resolved", "rejected", "expired"]);
export const DUP_DISTANCE = 0.15; // cosineDistance < 0.15  ⇔  similaridade de cosseno > 0.85
// THRESHOLDS DE PRODUÇÃO da precisão do sombra (torna "funciona" MENSURÁVEL, não achismo):
export const MIN_DECIDED = 5;        // amostra mínima (resolved+rejected) p/ a precisão ser SIGNIFICATIVA
export const TARGET_PRECISION = 0.5; // alvo; abaixo COM amostra = DEGRADADO (fail-loud) — o sombra está gerando ruído

export function normalizeFinding(text) { return String(text || "").toLowerCase().replace(/\s+/g, " ").trim(); }
export function hashFinding(text) { return "f-" + createHash("sha256").update(normalizeFinding(text)).digest("hex").slice(0, 16); }
function checksum(obj) { return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 8); }

/**
 * @param {{ append:(line:string)=>void, readAll:()=>string, embedder?:{embed:Function}|null, dupDistance?:number, log?:Function }} deps
 *  - append(line): persiste UMA linha (já com \n). readAll(): todo o log como string ("" se vazio). Injetáveis (teste in-memory; prod file-backed).
 *  - embedder: opcional. Ausente → só L1 (dedup semântico desligado, SINALIZADO).
 */
export function createFindingsTracker({ append, readAll, embedder = null, dupDistance = DUP_DISTANCE, log = () => {} } = {}) {
  if (typeof append !== "function" || typeof readAll !== "function") throw new Error("findings-tracker: append/readAll obrigatórios");
  const findings = new Map(); // hash -> { state, turn, ts, text, embed:number[]|null, seq }
  let seq = 0;

  // REDUCE-ON-BOOT: reconstrói o estado do log. Idempotente (deriva o estado da ÚLTIMA transição válida por
  // hash) e crash-safe (linha com JSON inválido ou checksum divergente é PULADA — não derruba).
  (function load() {
    const raw = readAll() || "";
    let skipped = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { skipped++; continue; }
      if (!ev || typeof ev !== "object" || !ev.hash || !ev.cs) { skipped++; continue; }
      const { cs, ...body } = ev;
      if (checksum(body) !== cs) { skipped++; continue; } // torn/corrompida
      if (typeof body.seq === "number" && body.seq >= seq) seq = body.seq + 1;
      if (body.event === "emit") {
        // só cria se ainda não existe (idempotente); re-emit de um hash já conhecido é ignorado
        if (!findings.has(body.hash)) {
          const v2 = body.v >= 2; // Fase 2: emit v2 carrega proveniência. v1 = INDETERMINADO (não infla retroativo).
          findings.set(body.hash, {
            state: "emitted", turn: body.turn, ts: body.ts, text: body.text || "",
            embed: Array.isArray(body.embed) ? body.embed : null, seq: body.seq,
            sources: v2 && Array.isArray(body.sources) ? body.sources : [],
            target: v2 && typeof body.target === "string" ? body.target : "unknown",
            citationComplete: v2 ? (body.citationComplete === true) : null, // C2: v1 → null (indeterminado), NUNCA true
          });
        }
      } else if (body.event === "transition") {
        const f = findings.get(body.hash);
        if (f && STATES.has(body.toState)) { f.state = body.toState; f.turn = body.turn; f.ts = body.ts; }
      }
    }
    if (skipped) log(`[findings] reduce-on-boot: ${skipped} linha(s) corrompida(s)/parcial(is) puladas (crash-safe)`);
  })();

  function persist(body) { const cs = checksum(body); append(JSON.stringify({ ...body, cs }) + "\n"); }

  // Duplicado de um finding ATIVO? L1 exato (hash) senão L2 semântico (distância < dupDistance). Devolve o hash
  // do finding existente que "casa", ou null. Só considera ATIVOS (emitted/addressed): terminados podem re-surgir.
  function findDuplicate(hash, embed) {
    const exact = findings.get(hash);
    if (exact && ACTIVE.has(exact.state)) return hash; // L1
    if (embed && embedder) {
      for (const [h, f] of findings) {
        if (!ACTIVE.has(f.state) || !f.embed) continue;
        let d; try { d = cosineDistance(embed, f.embed); } catch { continue; }
        if (d < dupDistance) return h; // L2
      }
    }
    return null;
  }

  return {
    /**
     * Emite um achado com PROVENIÊNCIA (Fase 2). Dedup: se for L1/L2 duplicado de um ATIVO, NÃO re-emite.
     * sources/target/citationComplete são OPCIONAIS (backward-compat: deliveryLedger chama emit(text,{turn})).
     * A FORMA é normalizada aqui (fonte única) com traço auditável; citationComplete é RECOMPUTADO das sources
     * normalizadas (não confia no claim do caller — C2/C3). Persiste como emit v:2.
     * @returns {Promise<{ hash:string, emitted:boolean, duplicate:boolean, ofHash?:string, method?:"L1"|"L2", target?:string, citationComplete?:boolean }>}
     */
    async emit(text, { turn = 0, sources = [], target = "unknown", citationComplete } = {}) {
      const t = String(text || "").trim();
      if (!t) throw new Error("findings.emit: texto vazio");
      const hash = hashFinding(t);
      const nTarget = normalizeProvenanceTarget(target, { log, context: "findings.emit" });
      const { sources: nSources, dropped } = normalizeProvenanceSources(sources, { log, context: "findings.emit" });
      const nCitation = computeCitationComplete(nSources, nTarget); // determinístico, por target (ignora o claim do caller)
      if (citationComplete === true && !nCitation) log("[findings] caller alegou citationComplete=true mas as sources normalizadas não fundamentam — corrigido p/ false");
      let embed = null;
      if (embedder?.embed) { try { const v = await embedder.embed(t); embed = v ? Array.from(v) : null; } catch (e) { log("[findings] embed falhou (dedup L2 off p/ este): " + (e?.message || e)); } }
      const dup = findDuplicate(hash, embed);
      if (dup) { const method = dup === hash ? "L1" : "L2"; log(`[findings] duplicado (${method}) de ${dup} — NÃO re-emitido`); return { hash: dup, emitted: false, duplicate: true, ofHash: dup, method }; }
      const ts = Date.now();
      findings.set(hash, { state: "emitted", turn, ts, text: t, embed, seq, sources: nSources, target: nTarget, citationComplete: nCitation });
      persist({ v: 2, seq: seq++, event: "emit", hash, toState: "emitted", turn, ts, text: t, embed, sources: nSources, target: nTarget, citationComplete: nCitation, ...(dropped ? { sourcesDropped: dropped } : {}) });
      return { hash, emitted: true, duplicate: false, target: nTarget, citationComplete: nCitation, ...(dropped ? { sourcesDropped: dropped } : {}) };
    },

    /**
     * Transiciona um finding. FAIL LOUD: hash desconhecido ou estado inválido LANÇA. Idempotente no log
     * (mesma transição re-append é reduzida ao mesmo estado). Não permite sair de estado TERMINAL (exceto re-emit natural).
     */
    transition(hash, toState, { turn = 0 } = {}) {
      if (!STATES.has(toState)) throw new Error(`findings.transition: estado inválido '${toState}'`);
      const f = findings.get(hash);
      if (!f) throw new Error(`findings.transition: hash desconhecido '${hash}'`);
      if (TERMINAL.has(f.state)) { log(`[findings] ${hash} já terminal (${f.state}) — transição p/ ${toState} ignorada`); return { hash, state: f.state, changed: false }; }
      const ts = Date.now();
      f.state = toState; f.turn = turn; f.ts = ts;
      persist({ v: 1, seq: seq++, event: "transition", hash, toState, turn, ts });
      return { hash, state: toState, changed: true };
    },

    /**
     * Expira findings ATIVOS parados. `isStale(finding)` decide (injetável — a Fase 6 usa "a sessão teve chance
     * de endereçar", não turno cru). Default: mais de `maxAgeTurns` turnos desde a emissão sem virar terminal.
     */
    expireStale(currentTurn, { maxAgeTurns = 3, isStale = null } = {}) {
      const expired = [];
      for (const [h, f] of findings) {
        if (!ACTIVE.has(f.state)) continue;
        const stale = isStale ? isStale(f, currentTurn) : (currentTurn - f.turn >= maxAgeTurns);
        if (stale) { this.transition(h, "expired", { turn: currentTurn }); expired.push(h); }
      }
      return expired;
    },

    stateOf(hash) { return findings.get(hash)?.state || null; },
    get(hash) { const f = findings.get(hash); return f ? { hash, ...f } : null; },
    active() { return [...findings.entries()].filter(([, f]) => ACTIVE.has(f.state)).map(([h, f]) => ({ hash: h, ...f })); },
    all() { return [...findings.entries()].map(([h, f]) => ({ hash: h, ...f })); },
    isDuplicateText(text) { return !!findDuplicate(hashFinding(text), null); }, // L1-only (sem embed) — barato
    // MÉTRICA HONESTA (escopo DIFERENTE do injectionPrecision de activity/injectionTracker.mjs — ver nota lá): a
    // precisão aqui vem das DECISÕES EXPLÍCITAS da sessão sobre cada achado VERIFICADO (resolved = útil, rejected =
    // falso-positivo). precision = resolved/(resolved+rejected). null quando nenhum foi decidido (honesto — não inventa).
    // FAIL-LOUD anti-lixo-silencioso: com AMOSTRA significativa (decided ≥ MIN_DECIDED) e precisão < TARGET, marca
    // `lowPrecision` p/ o caller DEGRADAR/AVISAR (o sombra está gerando ruído), em vez de seguir injetando findings
    // ruins calado. `significant=false` = ainda não dá p/ julgar (define o critério de sucesso: N≥MIN_DECIDED).
    metrics() {
      const by = { emitted: 0, addressed: 0, resolved: 0, rejected: 0, expired: 0 };
      for (const [, f] of findings) if (by[f.state] != null) by[f.state]++;
      const decided = by.resolved + by.rejected;
      const precision = decided ? by.resolved / decided : null;
      const significant = decided >= MIN_DECIDED;
      const lowPrecision = significant && precision < TARGET_PRECISION;
      return { ...by, total: findings.size, decided, precision, significant, lowPrecision, minDecided: MIN_DECIDED, target: TARGET_PRECISION };
    },
  };
}
