# modo-auto

**Uma MESA de agentes que assume o modo autônomo do GitHub Copilot** — em vez de o agente da sessão
responder sozinho (com viés de bajulação) ou parar no meio de um plano, o `modo-auto` intercepta os
`ask_user` e revisa os `Stop`, rodando um time de agentes (negócio, técnico, documentação, pesquisador,
revisor, advogado-do-diabo…) fundamentado em **plano vivo + memória do projeto + pesquisa ativa**.

Núcleo **hexagonal** (core agnóstico + ports & adapters). Perfis plugáveis. **FAIL LOUD** por princípio:
erro sobe com contexto — nunca uma resposta plausível-falsa nem um default silencioso.

> Extensão (canvas) do **Copilot CLI/app**. Projeto pessoal de [Allan Santos](https://github.com/AllanSantos-DV).

---

## O problema

O modo autônomo nativo é fraco: quando o modelo da sessão faz uma pergunta, a resposta automática é
genérica (“o usuário não está disponível, siga a ação recomendada”) — sem análise da pergunta, sem
contexto, sem contestação. E o agente trata todo prompt do usuário como ordem de máxima prioridade,
então **bajula** em vez de questionar (público-alvo? dor real? já existe solução? a arquitetura casa?).
Resultado: planos que derrapam e só quebram lá na fase 6.

O `modo-auto` troca isso por uma **mesa de decisão**: analisa a pergunta, valida contra o que já existe,
delibera com um time e devolve uma resposta consolidada — ou barra o Stop até o plano fechar.

## Os 3 interruptores conscientes (todos OFF por padrão — nada liga sozinho)

| Interruptor | Tool | O que faz |
|---|---|---|
| **MODO-AUTO** | `modo_auto on` | A mesa responde os `ask_user` (validando se já estão no ADR) e barra o `Stop` até o plano fechar. Independente dos outros. |
| **MODO PROFUNDO** | `modo_deep on` | Troca o revisor único por um **painel de famílias de modelo diferentes** em paralelo (consenso). Custa muito mais token; vale quando a decisão pesa. |
| **MODO-SOMBRA** | `modo_sombra on` | Um **2º cérebro contesta em background** (anti-bajulação): lê a conversa, questiona público/dor/reúso/arquitetura e, se a base derrapar, solta um aviso sugestivo. Deep-research ON por padrão → custo elevado. |

Veja tudo pelo painel visual: **`modo_painel`** (canvas lateral com status ao vivo + liga/desliga).

## Catálogo de ferramentas

- **`modo_adr`** — vira um briefing em **PLANO vivo em fases**, fundamentado no que já existe.
- **`modo_dev`** — constrói cada fase por **TDD** (tester → dev → gates → QA → veredito), corrigindo até zerar.
- **`modo_scopo`** — entende um projeto grande via **grafo semântico** (reúsa o plugin copilot-memory) ou garimpo manual.
- **`fatiar` / `modo_pipeline`** — paraleliza fases independentes em **worktrees git isolados** (merge resolver).
- **`deep_gate`** — avalia um material por **painel multi-família** (corroborado × isolado).
- **`sombra_preadr`** — handoff do modo-sombra: compara o plano com o dossiê de contestação e devolve veredito + pré-ADR.
- **`modo_guia` / `modo_painel`** — explicação coesa / painel visual.

## Instalação (dev local)

O `modo-auto` é uma **canvas extension**. O app carrega canvases de `~/.copilot/extensions/`.

```powershell
# dev: aponte o app para esta pasta (ou copie para ~/.copilot/extensions/modo-auto) e reinicie o app 1×
npm install         # instala @huggingface/transformers (embedder do drift, baixado sob demanda)
```

Ao instalar via release/marketplace, o hook `SessionStart` (`boot.mjs`) baixa o **canvas-sync**, que
espelha o plugin para `~/.copilot/extensions/`. **Reinicie o app uma vez** após instalar/atualizar.

## Reúso do ecossistema (dependência OPCIONAL)

Se o plugin **copilot-memory** estiver instalado, o `modo-auto` usa o **graphClient** e o **MemoryClient**
dele (single source of truth: grafo semântico + memória do projeto). Sem ele, cai nos clients vendados —
**sem dependência dura**. O servidor de memória fica agnóstico.

## Desenvolvimento

```powershell
node test/smoke.mjs            # smoke do núcleo (roteamento core→perfil + FAIL LOUD)
node test/<area>-smoke.mjs     # smokes por área (pipeline, panel, rekey, architect, shadow, …)
```

Arquitetura viva em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Guia para agentes em
[`AGENTS.md`](AGENTS.md).

## Princípios

1. **Reúso primeiro** — antes de construir, verifique o que já existe (memória, plugin, libs, soluções já desenhadas).
2. **Hexagonal** — o core fala só com ports; SDK/memória/fábrica/gates são adapters.
3. **FAIL LOUD** — erro sobe com contexto ou vira `{ok:false,error}` visível; jamais fake nem default silencioso.
4. **Custo consciente** — os modos caros (profundo, sombra) são opt-in e avisam o custo.

## Licença

[MIT](LICENSE) © Allan Santos
