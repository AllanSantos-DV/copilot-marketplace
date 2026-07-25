// index.mjs — fachada do adapter de pesquisa. O worker do pesquisador (Fase 2) importa daqui.
export { createResearchTools, RESEARCH_TOOL_NAMES, toolsForRole } from "./researchTools.mjs";
export { safeUrl, cleanQuery, cleanOutput } from "./guards.mjs";
export { searchViaDdg } from "./providers/ddgSearch.mjs";
export { searchViaBrave } from "./providers/braveSearch.mjs";
export { readViaJina } from "./providers/jinaReader.mjs";
export { loadResearchConfig, resolveSearchProvider, CONFIG_PATH } from "./config.mjs";
