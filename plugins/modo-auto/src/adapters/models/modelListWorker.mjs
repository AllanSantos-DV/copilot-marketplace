// WORKER de listagem de modelos — node LIMPO (fora do fork). Sobe o CopilotClient e chama listModels(),
// devolvendo os modelos disponíveis (id + enabled pela policy + reasoning efforts) num bloco marcado no
// stdout (o CLI polui a saída com avisos; os marcadores tornam o parse robusto). Não gera tokens.
import { sdkIndexUrl } from "../agents/workerLib.mjs";

(async () => {
  try {
    const { CopilotClient } = await import(sdkIndexUrl());
    const client = new CopilotClient({ workingDirectory: process.env.MODO_AUTO_WORKER_CWD || process.cwd() });
    await client.start();
    const models = await client.listModels();
    const out = (models || []).map((m) => ({ id: m.id, enabled: !m.policy || m.policy.state === "enabled", reasoning: m.supportedReasoningEfforts || null }));
    process.stdout.write("\n<<<MODELS>>>" + JSON.stringify(out) + "<<<END>>>\n");
    try { await client.stop?.(); } catch { /* ignore */ }
    process.exit(0);
  } catch (e) {
    process.stderr.write("modelListWorker erro: " + (e?.message || e));
    process.exit(1);
  }
})();
