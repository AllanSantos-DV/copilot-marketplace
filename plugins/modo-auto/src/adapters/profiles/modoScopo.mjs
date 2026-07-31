// ADAPTER de PERFIL — "modo-scopo" (mesa de ANÁLISE DE ESCOPO). Antes de começar um trabalho num projeto
// grande, entende o CODE-BASE ATUAL pra não garimpar na mão: usa o ScopePort (grafo semântico se disponível,
// senão garimpo manual honesto), monta um MAPA e roda o ANALISTA sobre ele → o que existe, o que reusar,
// onde tocar, lacunas. Reusa memória do projeto quando houver. FAIL LOUD: escopo/analista falhou → LANÇA.
import { recallIssue } from "../memory/memoryPort.mjs";

export function createModoScopo({ log = () => {} } = {}) {
  return {
    id: "modo-scopo",
    roster: () => ["analista"],

    /**
     * @param {string} subject  o assunto/pedido a escopar
     * @param {{ scope?:object, factory?:object, memory?:object }} caps
     * @param {{ root?:string }} [opts]  root de um projeto externo (default: o aberto)
     */
    async analyze(subject, caps = {}, { root = null } = {}) {
      const s = String(subject || "").slice(0, 2000);
      if (!s) throw new Error("modo-scopo.analyze: assunto vazio");
      if (!caps.scope?.scope) throw new Error("modo-scopo.analyze: caps.scope ausente");
      if (!caps.factory?.run) throw new Error("modo-scopo.analyze: caps.factory ausente");

      const sc = await caps.scope.scope(s, { root });
      if (!sc.ok) throw new Error(`modo-scopo: análise de escopo falhou (${sc.strategy || "?"}): ${sc.error || sc.state || "?"}`);

      let mapa;
      if (sc.strategy === "graph") {
        const rel = [...(sc.seed || []), ...(sc.expanded || [])].slice(0, 20).map((n) => "- " + (n.id || n.name || JSON.stringify(n))).join("\n");
        mapa = `ESTRATÉGIA: grafo semântico (${sc.nodes} nós / ${sc.edges} arestas${sc.partial ? ", parcial" : ""}).\n` +
          `HUBS (símbolos mais centrais):\n${(sc.hubs || []).slice(0, 15).map((h) => "- " + (h.id || h.name)).join("\n")}\n\n` +
          `RELEVANTES ao assunto (bundle):\n${rel || "(busca não trouxe vizinhança; use os hubs)"}`;
      } else {
        mapa = `ESTRATÉGIA: garimpo manual (${sc.reason}; ${sc.fileCount} arquivos${sc.truncated ? ", truncado" : ""}).\n` +
          `DIRETÓRIOS (por volume):\n${(sc.topDirs || []).slice(0, 10).map((d) => `- ${d.dir} (${d.count})`).join("\n")}\n\n` +
          `ARQUIVOS RELEVANTES:\n${(sc.topFiles || []).slice(0, 15).map((f) => "- " + f).join("\n")}\n\n` +
          `MATCHES:\n${(sc.matches || []).slice(0, 20).map((m) => `- ${m.file}:${m.line} ${m.text}`).join("\n") || "(nenhum match direto)"}`;
      }

      let mem = "";
      if (caps.memory?.recall) {
        const m = await caps.memory.recall(s, { topK: 3 });
        if (m && m.ok) mem = (m.results || []).map((r) => "- " + String(r.text || "").slice(0, 160)).join("\n");
        else { const iss = recallIssue(m, "modo-scopo"); if (iss) log(iss); }
      }

      const r = await caps.factory.run("analista",
        `ASSUNTO:\n${s}\n\nMAPA DO CÓDIGO-BASE ATUAL:\n${mapa}\n\nMEMÓRIA DO PROJETO:\n${mem || "(nada relevante)"}\n\n` +
        `Produza o entendimento de escopo: o que JÁ EXISTE, o que REUSAR, ONDE tocar, LACUNAS/riscos.`,
        { subject: "analista", taskType: "research" });
      if (!r.ok || !r.text) throw new Error(`modo-scopo: analista falhou: ${r.error || "sem texto"}`);

      log(`[modo-scopo] escopo analisado via ${sc.strategy}${sc.reason ? " (" + sc.reason + ")" : ""}`);
      return { ok: true, strategy: sc.strategy, reason: sc.reason || null, analysis: r.text, map: { hubs: (sc.hubs || []).length, files: sc.fileCount || 0, nodes: sc.nodes || 0 } };
    },
  };
}
