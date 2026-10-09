# visual-explainer (cliente fino do motor vxk)

Explicações visuais **animadas, narradas e interativas** direto do agente. Este plugin é só a ponte
do Copilot CLI para o **motor vxk** — um servidor MCP independente de host, publicado no
[engine-registry](https://github.com/AllanSantos-DV/engine-registry) e instalado uma vez por máquina
em `~/.vxk` (o mesmo que Claude Code, Codex e qualquer cliente MCP usam).

- `boot.mjs` (SessionStart) — garante o motor vxk pelo engine-kit vendorizado (download com SHA-256 +
  assinatura Ed25519) e instala o agente `visual-explainer` em `~/.copilot/agents`.
- `.mcp.json` + `vxk-launch.mjs` — declaram o servidor MCP `vxk` (lê o ponteiro `~/.vxk/cli.json`).
- `visual-explainer.agent.md` — o desenhista: compõe a biblioteca pronta pelas tools `vxk_*`.
- `engine-kit/` — cópia verificada do cliente do engine-registry (só módulos nativos do Node).

Narração requer o motor de voz **vox-engine** (Windows). Fonte: repositório privado `visual-explainer`.
