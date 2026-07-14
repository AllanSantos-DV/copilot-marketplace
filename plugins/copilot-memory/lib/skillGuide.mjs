// Guia de autoria de skill de MEMÓRIA (M4 S2). Fundamentado no skill-creator
// (princípios de qualidade) mas ADAPTADO ao nosso artefato: uma skill aqui é UM DOCUMENTO
// de memória (type:"skill"), não uma pasta SKILL.md. Por isso NÃO há directory structure,
// references/, FEEDBACK.md, frontmatter YAML nem regra de 500 linhas — nada disso se aplica.
//
// O agente lê este guia (via tool memory_skill_guide) ANTES de chamar memory_save_skill.
// É a fonte de "o quê / porquê / fazer / não fazer" de uma boa skill de conhecimento.

export const SKILL_GUIDE = `# Guia de autoria de skill de memória

Você vai destilar um aprendizado desta sessão numa **skill** reusável, guardada na memória do
projeto (\`type:"skill"\`). Uma skill = **um** aprendizado atômico, reaproveitável em sessões futuras.
Ela nasce como **candidata** (fora do recall automático) e só passa a ser reinjetada depois de
**promovida** (validada). Siga este formato — a validação estrutural cobra ele.

## O artefato (o que você manda em memory_save_skill)
- **name** — PT, ≤64 chars. Curto e específico. Casa com prompts do usuário em PT.
- **description** — PT, ≤1024 chars (mire ~300). Diz **o que faz E quando usar**, e **inclui um
  "não use quando"**. É o campo mais importante: é por ele que o recall decide reativar a skill.
- **body** — SEMPRE em **inglês**, denso e imperativo, com estas seções fixas:
  - \`## What\` — o que a skill ensina/faz, em uma frase.
  - \`## When to use\` — gatilhos/condições; e **quando NÃO usar**.
  - \`## Do\` — os passos validados / a prática recomendada (atômicos, verificáveis).
  - \`## Don't\` — anti-padrões e **por que** não fazer assim.
  - \`## Example\` — opcional, mínimo e real.

### Por que PT no topo e EN no corpo (não é estética)
O servidor **só indexa o \`content\`** (o metadata NÃO entra no vetor). O plugin monta o content como
**PT (name+description) + corpo EN**. Assim o gatilho em PT fica no índice (casa com o usuário) e o
corpo EN é o payload que o modelo aplica. O recall é **em dois níveis**: a skill volta como
**ponteiro** (name+description+id); o corpo completo é carregado sob demanda com \`memory_get(id)\`.
Logo, **name+description precisam se bastar** para o agente decidir se abre a skill.

## Regras da description (o campo decisivo)
1. **Específica** — "resolver id" é vago; "derivar project_id estável entre worktrees do mesmo repo"
   é específico.
2. **Verbos de ação** — "use ao escopar…", "aplique quando…": diz ao recall QUANDO reativar.
3. **"Não use quando" explícito** — evita disparo errado (o maior causador de poluição).
4. **Palavras-chave no início** — os termos mais relevantes primeiro.
5. **~300 chars é o ponto ótimo** — passou de ~400, provavelmente a skill é ampla demais: **divida**.
6. **A description É o gatilho do fetch (crucial no recall two-tier).** No recall a skill volta como
   PONTEIRO (só name+description); o corpo só carrega se o agente decidir buscar (memory_get). Logo o
   "quando usar" precisa estar VISÍVEL na description — se o gatilho mora só no corpo não-buscado, a
   skill nunca é aberta. Otimize a description para RECUPERAÇÃO (carregue o contexto de disparo), não
   como resumo bonito.

## Regras do body
- **Imperativo, para o agente** — "When X, do Y", não "Y é uma boa ideia".
- **Atômica, um domínio** — se aparecem assuntos não relacionados, são duas skills.
- **\`Do\` = passos validados** desta sessão; **\`Don't\` = o que quebrou / a armadilha, com o porquê.**
- **Sem enrolação** — nada de contexto humano/história; instrução mecânica.

## Pitfalls
| | Padrão | Consequência | Correção |
|---|--------|--------------|----------|
| ❌ | description vaga | recall não sabe quando reativar | keywords + "quando usar/NÃO usar" |
| ❌ | sem "não use quando" | dispara em contexto errado (poluição) | sempre inclua o anti-gatilho |
| ❌ | escopo amplo demais | conhecimento diluído, conflita | divida em skills focadas |
| ❌ | body em PT / prosa humana | corpo pior p/ o modelo; mistura idioma | corpo em EN, imperativo |
| ❌ | sem \`## Don't\` | repete o erro que você acabou de corrigir | registre o anti-padrão + porquê |
| ✅ | atômica + description honesta + Do/Don't | reusa certo, não polui | — |

## O que NÃO fazer (diferente do skill-creator de arquivo)
Isto **não** é uma pasta SKILL.md. **Não** crie \`references/\`, \`FEEDBACK.md\`, \`.skillconfig.json\`,
frontmatter YAML, nem se preocupe com "500 linhas". O artefato é curto e vive na memória.

## Só vire skill se…
- **Reusável** além desta sessão (senão é fato/decisão do projeto → \`memory_save\`, não skill).
- **Validado** — deu certo/foi confirmado (não destile tentativa-erro nem detalhe efêmero).
- Se não bater os dois, **não crie** — qualidade > quantidade.

## Ciclo
1. \`memory_save_skill\` → nasce **candidata** (não entra em recall automático).
2. Revise; se correta e reusável → \`memory_promote_skill(id)\` (aí sim entra no recall).
3. Errou/desatualizou → \`memory_invalidate_skill(id, reason)\` (caminho de saída; não polui o futuro).
Antes de criar, cheque \`memory_list_skills\` para não duplicar.

## Exemplo (real, desta linha de trabalho)
name (PT): \`Resolver project_id estável em worktrees do Copilot\`
description (PT): \`Deriva um project_id que casa entre sessões/worktrees do mesmo repositório. Use ao
escopar memória por projeto num cliente que roda em git worktrees (um path por sessão). Não use para
skills globais nem quando não há repositório git.\`
body (EN):
\`\`\`
## What
Derive a stable project_id from a working directory so every session/worktree of the same repo
resolves to the same memory scope.

## When to use
When a client reads/writes project-scoped memory and the host creates one git worktree per session
(the working-directory path differs on every session). Not for global skills.

## Do
1. \`git remote get-url origin\`, normalized to host/owner/repo (lowercase; strip scheme, creds, .git).
2. If there is no origin, use \`git rev-parse --git-common-dir\` → its parent = the shared repo base.
3. Only then fall back to absolute path, then folder name.

## Don't
- Don't use the worktree's own path/name as the id — it changes per session, so recall never matches.
- Don't invent a scheme that diverges from the server's when an origin exists (writes/reads must line up).
\`\`\`
`;
