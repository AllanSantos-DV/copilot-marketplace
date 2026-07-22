// Diretório de ESTADO/TELEMETRIA local do plugin (ledgers, recibos de gate, policies, stamps de
// scaffold, telemetria de recall, config do self-review, porta do painel). Fonte ÚNICA — antes o
// MESMO helper de 2 linhas estava DUPLICADO em 10 módulos. Preserva EXATAMENTE o contrato original:
// COPILOT_MEMORY_TELEMETRY_DIR (override, honrado pelos testes) OU ~/.copilot-memory. Puro: só devolve
// o caminho; quem escreve faz o mkdirSync no call-site (como já era).
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () => process.env.COPILOT_MEMORY_TELEMETRY_DIR || join(homedir(), ".copilot-memory");
