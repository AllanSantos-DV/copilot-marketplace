// REGISTRO DE ATIVIDADE dos workers da mesa — observabilidade pro painel. In-memory (por sessão, no
// processo da extensão): guarda os últimos N workers (rodando + concluídos) num ring buffer, pro painel
// mostrar QUANTOS estão rodando agora e O QUE cada papel produziu ("o que dizem entre si"). Puro/testável.
//
// Não é caminho crítico: é enriquecimento. `end` com id desconhecido (já podado) é no-op legítimo, não erro.

export function createActivityRegistry({ cap = 50, now = () => Date.now(), onEnd = null, log = () => {} } = {}) {
  let seq = 0;
  const entries = new Map(); // id → entry
  const order = [];          // ids na ordem de chegada (ring buffer)
  const groups = new Map();  // groupId → { id, kind, topic, startedAt, seq }

  // Poda os mais antigos JÁ CONCLUÍDOS além do cap. NUNCA remove um que ainda está rodando.
  function prune() {
    while (order.length > cap) {
      const idx = order.findIndex((id) => entries.get(id)?.status !== "running");
      if (idx === -1) break; // todos rodando → não poda
      const [rm] = order.splice(idx, 1);
      entries.delete(rm);
    }
    // Poda grupos órfãos (sem nenhum worker vivo no buffer).
    for (const gid of [...groups.keys()]) {
      if (![...entries.values()].some((e) => e.group === gid)) groups.delete(gid);
    }
  }

  return {
    // Registra o INÍCIO de um worker. `group` (id) + `topic` amarram-no a uma DELIBERAÇÃO (thread da mesa).
    // `traceId` correlaciona a RUN inteira (span-per-turn, estilo OTel); default = group (uma deliberação já é uma run).
    start({ role, taskType = null, model = null, stage = null, group = null, topic = null, traceId = null } = {}) {
      const id = ++seq;
      if (group && !groups.has(group)) groups.set(group, { id: group, kind: stage || "?", topic: topic || "", startedAt: now(), seq: id });
      entries.set(id, { id, traceId: traceId || group || null, role: role || "?", taskType: taskType || null, model: model || null, stage: stage || null, group: group || null, status: "running", startedAt: now(), endedAt: null, durationMs: null, endReason: null, snippet: "", usage: null, spanVersion: 2 });
      order.push(id);
      prune();
      return id;
    },

    // Registra o FIM. ok=false → status "fail" e snippet = erro. Guarda um trecho do que o papel "disse".
    // `endReason` (idle|hung|hardcap|error…) é o MOTIVO do desfecho — insumo determinístico p/ o gapDetector/
    // selfImprove enxergarem TRAVAMENTOS (era o objetivo da telemetria). `usage` (tokens/nanoAiu do worker) é o
    // custo REAL da run — null SINALIZADO se a medição faltou (fail-loud; nunca 0 fake). Emite o span COMPLETO no
    // hook `onEnd`. O hook é ENRIQUECIMENTO: se lançar, é SINALIZADO (log) e NÃO derruba a observabilidade (nem o run).
    end(id, { ok = true, text = "", error = null, endReason = null, usage = null } = {}) {
      const e = entries.get(id);
      if (!e || e.status !== "running") return; // já concluído/podado → no-op (não mascara: é race legítima)
      e.status = ok ? "done" : "fail";
      e.endedAt = now();
      e.durationMs = e.endedAt - e.startedAt;
      e.endReason = endReason || (ok ? "idle" : "error");
      e.snippet = String(ok ? text : (error || "")).replace(/\s+/g, " ").trim().slice(0, 200);
      if (usage && typeof usage === "object") e.usage = usage; // custo medido; ausente → fica null (fail-loud visível)
      if (onEnd) { try { onEnd({ ...e }); } catch (err) { log(`[telemetria] onEnd falhou (sinalizado, não derruba): ${err?.message || err}`); } }
    },

    // Fotografia p/ o painel: quantos rodando + lista plana (recent, retrocompat) + DELIBERAÇÕES agrupadas
    // (groups) — cada grupo é um "thread" da mesa: tópico + os workers (pareceres) na ordem de chegada.
    snapshot() {
      const t = now();
      const withLive = (e) => ({ ...e, durationMs: e.status === "running" ? (t - e.startedAt) : e.durationMs });
      const list = order.map((id) => entries.get(id)).filter(Boolean);
      const running = list.filter((e) => e.status === "running").length;
      const recent = [...list].reverse().map(withLive);

      // Grupos: mais recentes primeiro; workers do grupo em ORDEM de chegada (a "conversa").
      const grouped = [...groups.values()].sort((a, b) => b.seq - a.seq).map((g) => {
        const ws = list.filter((e) => e.group === g.id).map(withLive);
        const gRunning = ws.filter((w) => w.status === "running").length;
        const status = gRunning ? "running" : (ws.some((w) => w.status === "fail") ? "fail" : "done");
        return { id: g.id, kind: g.kind, topic: g.topic, startedAt: g.startedAt, running: gRunning, status, workers: ws };
      });

      return { running, total: list.length, recent, groups: grouped };
    },

    clear() { entries.clear(); order.length = 0; groups.clear(); seq = 0; },
  };
}
