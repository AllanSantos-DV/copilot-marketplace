// canvas-meta.mjs — identidade do canvas do painel. Módulo deliberadamente MÍNIMO (zero deps) para que
// o cliente fino (extension.mjs) possa referenciar ID/título sem puxar o núcleo pesado do daemon
// (dashboard.mjs re-exporta os mesmos símbolos daqui para não quebrar quem já importava de lá).
export const CANVAS_ID = "session-unloader-panel";
export const CANVAS_INSTANCE = "session-unloader-panel";
export const CANVAS_TITLE = "🧹 Session Unloader";
