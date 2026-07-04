// boot.mjs — bootstrap ENDURECIDO (SEM REDE) do mcp-bridge.
//
// Roda o sync.mjs VENDADO localmente neste plugin para espelhar o plugin em
// ~/.copilot/extensions/ — necessário para o CLI carregar a extensão quando ela é
// instalada como plugin (installed-plugins/ não é carregado direto).
//
// Diferença de segurança em relação ao bootstrap compartilhado do canvas-sync: este
// NÃO baixa nem executa código remoto (nada de raw.githubusercontent / auto-update).
// Requisito para ambientes enterprise (onde a ponte MCP é usada). O sync.mjs vendado é
// self-contained (só builtins node:, sem rede) e idempotente. Nunca lança: um hook não
// pode quebrar a sessão.
try {
  const mod = await import(new URL("./sync.mjs", import.meta.url).href);
  if (typeof mod.runAsHook === "function") {
    mod.runAsHook();
  } else if (typeof mod.syncCanvases === "function" && typeof mod.resolveCopilotHome === "function") {
    mod.syncCanvases(mod.resolveCopilotHome(), {});
  }
} catch {
  // best-effort: um hook de SessionStart nunca pode derrubar a sessão.
}
