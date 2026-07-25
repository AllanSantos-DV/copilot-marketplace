// GESTOR DA MESA VIVA (round-robin) — o coração do debate real. Abre N agentes VIVOS (base + dinâmicos),
// mantém o TRANSCRIPT compartilhado da mesa, e um ORQUESTRADOR CENTRAL passa a palavra em ordem fixa. No
// turno de cada agente, injeta o que foi dito DESDE O ÚLTIMO TURNO dele — então cada um VÊ e REAGE ao que
// os outros falaram (o contestador vê o entregável; o entregável vê a contestação). É o que faltava.
//
// Esta fase entrega: open() (sobe os agentes), runRound() (uma volta da roda), close(). As VOLTAS/threshold
// (mín. 2, cap) vêm na fase 3; o fecho (documentador com tudo) na fase 4. FAIL LOUD: se TODOS os agentes
// de uma volta falham → LANÇA; falhas parciais são sinalizadas (o agente entra no transcript como falho).

import { convergenceSignal } from "../embed/convergenceSignal.mjs";
import { extractJson } from "../util/extractJson.mjs";

// TOOL TEMPLATE do juiz de convergência (Princípio 11) — schema imposto pelo SDK na sessão viva (registerTools).
const CONVERGENCE_SCHEMA = {
  name: "submit_convergence",
  description: "A mesa convergiu numa direção sólida e suficiente para escrever o documento final?",
  parameters: {
    type: "object",
    properties: {
      converged: { type: "boolean", description: "true se convergiu o suficiente para finalizar" },
      missing: { type: "array", items: { type: "string" }, description: "o que ainda falta debater, se houver" },
    },
    required: ["converged"],
  },
};

/**
 * @param {(agent)=>object} makeWorker  fábrica de worker vivo (createLiveWorker) — injetável p/ teste
 * @param {{ order?:string[], log?:(m:string)=>void }} [opts]  order = ordem de fala (papéis base)
 */
export function createLiveTable(makeWorker, { order = [], log = () => {} } = {}) {
  if (typeof makeWorker !== "function") throw new Error("createLiveTable: makeWorker ausente");
  const parseJson = extractJson;
  /** @type {{role:string, worker:object}[]} */
  let seats = [];
  /** @type {{round:number, role:string, ok:boolean, text:string, error?:string}[]} */
  const transcript = [];
  const lastSpoke = new Map(); // role → índice no transcript APÓS seu último turno (persiste entre voltas)
  let round = 0;

  // Renderiza o que foi dito DESDE o índice `from` (o último turno do agente), atribuído por papel.
  function since(from) {
    const parts = transcript.slice(from).filter((t) => t.ok && t.text).map((t) => `### ${t.role} (volta ${t.round})\n${t.text}`);
    return parts.join("\n\n");
  }

  return {
    get transcript() { return transcript; },
    get roles() { return seats.map((s) => s.role); },
    get rounds() { return round; },

    // Snapshot p/ RELIGAR depois: {role, sessionId} de cada agente (persistir na memória do ADR).
    snapshot() { return seats.map((s) => ({ role: s.role, sessionId: s.worker.sessionId })); },

    /**
     * Abre a mesa: sobe um agente VIVO por papel (base + dinâmicos), na ORDEM de fala. Cada `agents[i]`
     * = { role, system, model?, ... } (o system já desenhado). FAIL LOUD se nenhum ficar ready.
     */
    async open(agents) {
      const list = Array.isArray(agents) ? agents.filter((a) => a && a.role && a.system) : [];
      if (!list.length) throw new Error("liveTable.open: nenhum agente (role+system) fornecido");
      // ordena pelos papéis base (order); os fora da ordem entram no fim, na ordem dada.
      const rank = (r) => { const i = order.indexOf(r); return i === -1 ? order.length + list.findIndex((a) => a.role === r) : i; };
      const sorted = [...list].sort((a, b) => rank(a.role) - rank(b.role));
      seats = sorted.map((a) => ({ role: a.role, worker: makeWorker(a) }));
      const readies = await Promise.allSettled(seats.map((s) => s.worker.ready()));
      const alive = seats.filter((_, i) => readies[i].status === "fulfilled");
      if (!alive.length) throw new Error("liveTable.open: nenhum agente ficou ready: " + readies.map((r) => r.reason?.message).filter(Boolean).join("; "));
      if (alive.length < seats.length) {
        const deadSeats = seats.filter((_, i) => readies[i].status !== "fulfilled");
        for (const d of deadSeats) { try { d.worker.close(); } catch { /* ignore */ } } // NÃO deixa processo órfão
        log(`[mesa-viva] AVISO — agentes que não subiram (encerrados, sinalizado): ${deadSeats.map((s) => s.role).join(", ")}`);
        seats = alive;
      }
      log(`[mesa-viva] mesa aberta: ${seats.map((s) => s.role).join(" → ")}`);
      return seats.map((s) => s.role);
    },

    /**
     * Uma VOLTA da roda: cada agente fala UMA vez, na ordem, vendo o que foi dito desde seu último turno.
     * @param {string} subject  o assunto/pergunta da mesa
     * @param {{ timeoutMs?:number, extra?:(role:string)=>string }} [opts]
     */
    async runRound(subject, { timeoutMs = 150000, extra = () => "" } = {}) {
      if (!seats.length) throw new Error("liveTable.runRound: mesa não aberta");
      round += 1;
      let failures = 0;
      for (const seat of seats) {
        const spokeBefore = lastSpoke.has(seat.role);
        const from = lastSpoke.get(seat.role) ?? 0; // desde o ÚLTIMO turno DESTE agente (persiste entre voltas)
        const heard = since(from);
        const header = !spokeBefore
          ? (heard ? `O QUE JÁ FOI DITO NA MESA (reaja, conteste, refine):\n${heard}\n\n` : "Você ABRE a deliberação no seu papel.\n")
          : `O QUE FOI DITO NA MESA DESDE SEU ÚLTIMO TURNO (reaja, concorde, conteste, refine):\n${heard || "(nada novo desde sua última fala)"}\n\n`;
        const prompt =
          `ASSUNTO DA MESA:\n${subject}\n\n` + header +
          (extra(seat.role) ? extra(seat.role) + "\n\n" : "") +
          `Sua vez (volta ${round}). Fale no seu papel — curto, direto, acionável. Se for contestar, seja específico.`;
        const r = await seat.worker.turn(prompt, timeoutMs);
        transcript.push({ round, role: seat.role, ok: !!r.ok, text: r.ok ? r.text : "", error: r.ok ? undefined : r.error });
        lastSpoke.set(seat.role, transcript.length);
        if (!r.ok) { failures++; log(`[mesa-viva] volta ${round}: ${seat.role} FALHOU (sinalizado): ${r.error}`); }
      }
      if (failures === seats.length) throw new Error(`liveTable: TODOS os agentes falharam na volta ${round}`);
      return { round, transcript, failures };
    },

    close() { for (const s of seats) { try { s.worker.close(); } catch { /* ignore */ } } },

    // Transcript COMPLETO renderizado (todas as voltas, todos os papéis) — o material que o documentador
    // recebe pra escrever o documento COM A DELIBERAÇÃO INTEIRA (não um viés único sobre textos soltos).
    render() {
      return transcript.filter((t) => t.ok && t.text).map((t) => `## ${t.role} — volta ${t.round}\n${t.text}`).join("\n\n");
    },

    /**
     * FECHO: (1) o facilitador (sessão viva, viu tudo) dá a SÍNTESE consolidada; (2) o `writeDoc` escreve o
     * documento final recebendo a DELIBERAÇÃO INTEIRA (render) + a síntese. FAIL LOUD: síntese/documento
     * que falham ou vêm vazios → LANÇAM (não entrega viés/meia-boca).
     * @param {string} subject
     * @param {{ writeDoc:(ctx:{subject,transcript,synthesis})=>Promise<string>, facilitatorRole?:string, timeoutMs?:number }} opts
     * @returns {Promise<{ synthesis:string, document:string, transcript:string }>}
     */
    async finalize(subject, { writeDoc, facilitatorRole = "facilitador", timeoutMs = 150000 } = {}) {
      if (typeof writeDoc !== "function") throw new Error("liveTable.finalize: writeDoc ausente");
      if (!seats.length) throw new Error("liveTable.finalize: mesa não aberta");
      let synthesis = "";
      const fac = seats.find((s) => s.role === facilitatorRole);
      if (fac) {
        const r = await fac.worker.turn(
          `SÍNTESE FINAL (meta): consolide a deliberação da mesa numa direção CLARA e acionável — você ` +
          `acompanhou todas as voltas. Integre os pareceres e resolva as divergências. Curto e direto.`, timeoutMs);
        if (!r.ok) throw new Error("liveTable.finalize: síntese do facilitador falhou: " + r.error);
        synthesis = r.text;
      }
      const rendered = this.render();
      const document = await writeDoc({ subject, transcript: rendered, synthesis }); // erro SOBE (fail loud)
      if (!document || !String(document).trim()) throw new Error("liveTable.finalize: documento final vazio");
      return { synthesis, document: String(document), transcript: rendered };
    },

    // Juiz de convergência PADRÃO: o facilitador (sessão viva, viu TUDO) dá um veredito ao fim da volta.
    // Não entra no transcript (é meta). TOOL TEMPLATE (Princípio 11): veredito via submit_convergence (schema
    // imposto pelo SDK na sessão viva via registerTools), não prosa parseada — determinístico entre modelos.
    _defaultJudge(judgeRole, timeoutMs) {
      return async () => {
        const seat = seats.find((s) => s.role === judgeRole);
        if (!seat) throw new Error(`liveTable: juiz de convergência '${judgeRole}' não está na mesa`);
        const r = await seat.worker.turn(
          `VEREDITO DE CONVERGÊNCIA (meta): com base em TODA a deliberação da mesa até aqui, ela CONVERGIU numa ` +
          `direção sólida e suficiente para escrever o documento final? CHAME a ferramenta submit_convergence. NÃO responda em texto.`,
          timeoutMs, CONVERGENCE_SCHEMA);
        if (!r.ok) throw new Error("liveTable: veredito de convergência falhou: " + r.error);
        const j = parseJson(r.text);
        // __nosubmit__ (raro, após reforço): degrada p/ "não convergiu" (o seguro — mais uma volta), não crash.
        if (!j || j.__nosubmit__ || typeof j.converged !== "boolean") { log(`[mesa-viva] juiz não submeteu {converged} → assume não-convergido (segue debatendo)`); return { converged: false, missing: ["veredito de convergência não estruturado"] }; }
        return { converged: j.converged, missing: Array.isArray(j.missing) ? j.missing : [] };
      };
    },

    /**
     * DEBATE completo: gira a roda até CONVERGIR (a partir de minRounds) ou bater o cap (maxRounds).
     * @param {string} subject
     * @param {{ minRounds?:number, maxRounds?:number, judge?:Function, judgeRole?:string, timeoutMs?:number, extra?:Function }} [opts]
     * @returns {Promise<{ rounds:number, transcript:object[], converged:boolean, missing:string[] }>}
     */
    async runDebate(subject, { minRounds = 2, maxRounds = 4, judge = null, judgeRole = "facilitador", timeoutMs = 150000, extra, embedder = null, stableAt = 0.35 } = {}) {
      if (!seats.length) throw new Error("liveTable.runDebate: mesa não aberta");
      const min = Math.max(1, minRounds), max = Math.max(min, maxRounds);
      const decide = judge || this._defaultJudge(judgeRole, timeoutMs);
      const roundText = (n) => transcript.filter((t) => t.round === n && t.ok && t.text).map((t) => t.text).join("\n");
      let converged = false, missing = [];
      while (round < max) {
        await this.runRound(subject, { timeoutMs, extra });
        if (round >= min) {
          const v = await decide(transcript, round); // heurístico (facilitador) — erro SOBE (fail loud)
          missing = v.missing || [];
          // HARNESS DETERMINÍSTICO (mini-LRM): a mesa "estabilizou" entre voltas? Reusa o embedder. Enquanto
          // as posições DIVERGEM, VETA a convergência mesmo que o facilitador diga sim (anti-fechar-cedo).
          const det = await convergenceSignal(embedder, roundText(round - 1), roundText(round), { stableAt });
          const ok = v.converged && (det == null || det.converged);
          if (det) log(`[mesa-viva] volta ${round}: facilitador=${v.converged}, determinístico=${det.converged} (dist ${det.distance.toFixed(3)}) → convergiu=${ok}`);
          if (ok) { converged = true; log(`[mesa-viva] convergiu na volta ${round}${det ? " (heurístico + determinístico)" : " (heurístico; embedder off — sinalizado)"}`); break; }
          if (v.converged && det && !det.converged) log(`[mesa-viva] volta ${round}: facilitador quis fechar, mas as posições ainda DIVERGEM (dist ${det.distance.toFixed(3)}) → segue debatendo`);
          else log(`[mesa-viva] volta ${round}: ainda não convergiu (falta: ${missing.join("; ") || "?"})`);
        }
      }
      if (!converged) log(`[mesa-viva] cap de ${max} voltas atingido sem convergência (segue p/ o fecho com o que há)`);
      return { rounds: round, transcript, converged, missing };
    },
  };
}
