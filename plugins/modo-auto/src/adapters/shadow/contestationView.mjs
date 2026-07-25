// contestationView.mjs — SERIALIZAÇÃO da contestação do modo-sombra p/ injeção na virada do turno (Fase 3).
// Puro e testável (DRY: extension.mjs usa, o smoke testa direto). Mostra a PROVENIÊNCIA legível pro dono:
// a BASE da leitura (plano lido? qual caminho? ou só conversa), e por finding o [alvo: plan|execution|premise]
// + [fontes: type:path, ...] + [citação parcial] quando a citação não fundamenta. Backward-compat: finding
// sem sources (v1) serializa sem bloco de fontes; target 'unknown' e citationComplete null/true não poluem.
export function formatContestation(flag) {
  if (!flag) return "";
  const fs = Array.isArray(flag.findings) ? flag.findings.filter((f) => f && f.hash) : [];
  const fmtTarget = (f) => (f.target && f.target !== "unknown" ? ` [alvo: ${f.target}]` : "");
  const fmtSources = (f) => (Array.isArray(f.sources) && f.sources.length ? ` [fontes: ${f.sources.map((s) => s.type + (s.path ? ":" + s.path : "")).join(", ")}]` : "");
  const fmtCitation = (f) => (f.citationComplete === false ? " [citação parcial]" : ""); // null (v1/indeterminado) NÃO marca
  const list = fs.length
    ? "\nContestações (resolva/rejeite/acate com sombra_resolver hash):\n" + fs.map((f) => `- [${f.hash}]${fmtTarget(f)} ${f.text}${fmtSources(f)}${fmtCitation(f)}`).join("\n")
    : ((flag.flags || []).length ? "\nRiscos: " + (flag.flags || []).join("; ") : "");
  const base = flag.sessionDirectionSource === "plan" && flag.planSource && flag.planSource.found
    ? `\nBase da leitura: PLANO (${flag.planSource.path || "plan.md"})`
    : "\nBase da leitura: CONVERSA (plano não lido)";
  return `[modo-sombra — contestação, drift ${flag.drift}]${base}\n${flag.reason}\nDireção sugerida: ${flag.direction}${list}\n(sugestivo — acate ou ignore; findings verificados pelas tools do sombra)`;
}
