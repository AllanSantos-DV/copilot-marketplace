# visual-explainer (cliente fino do motor vxk)

Explicações visuais **animadas, narradas e interativas** direto do agente. Este plugin é só a ponte
do Copilot CLI para o **motor vxk** — um servidor MCP independente de host, publicado no
[engine-registry](https://github.com/AllanSantos-DV/engine-registry) e instalado uma vez por máquina
em `~/.vxk` (o mesmo que Claude Code, Codex e qualquer cliente MCP usam).

- `boot.mjs` (SessionStart) — garante o motor vxk pelo engine-kit vendorizado (download com SHA-256 +
  assinatura Ed25519) e instala o agente `visual-explainer` em `~/.copilot/agents`.
- `.mcp.json` + `vxk-launch.mjs` — declaram o servidor MCP `vxk` (lê o ponteiro `~/.vxk/cli.json`).
- `instalar-motor.mjs` — para quem **não usa o Copilot**: `node instalar-motor.mjs` instala (ou atualiza) o motor em `~/.vxk` pelo mesmo caminho verificado e mostra como declarar o MCP no Claude Code e no Codex (`~/.codex/config.toml`), apontando para o `vxk-launch.mjs`. Nesta máquina o cadastro de MCP passa pelo mcp-gateway.
- `visual-explainer.agent.md` — o desenhista: compõe a biblioteca pronta pelas tools `vxk_*`.
- `engine-kit/` — cópia verificada do cliente do engine-registry (só módulos nativos do Node).

Narração requer o motor de voz **vox-engine** (Windows). Fonte: repositório privado `visual-explainer`.
