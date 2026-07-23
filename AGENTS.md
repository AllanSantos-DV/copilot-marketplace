# AGENTS.md — copilot-marketplace

Guia para um agente (ou humano) **publicar, migrar ou criar** um plugin/extensão do
**GitHub Copilot CLI** neste repositório. Leia isto inteiro antes de mexer.

---

## 1. O que é este repositório

Vitrine (marketplace) de plugins do Copilot CLI do Allan. Usuários registram uma vez:

```sh
copilot plugin marketplace add AllanSantos-DV/copilot-marketplace
copilot plugin install <plugin>@copilot-marketplace
copilot plugin update --all
```

- Repositório **público**: `AllanSantos-DV/copilot-marketplace`, branch padrão `main`.
- Vitrine (GitHub Pages): <https://allansantos-dv.github.io/copilot-marketplace/>.

## 2. Modelo de publicação — leia com atenção

- **O commit em `main` É a publicação.** Não há GitHub Actions, nem build no servidor, nem
  dependência de releases públicas.
- **Plugins são vendados** (os arquivos de runtime já empacotados) em `plugins/<nome>/`.
  **Nunca edite `plugins/<nome>/` à mão** — esses arquivos vêm do repositório de origem de
  cada plugin. Editar aqui é perder a mudança no próximo sync.
- O `copilot plugin update` detecta atualização **pela `version`** do `plugin.json`. Sem bump
  de versão, ninguém recebe a mudança.
- **Fonte de verdade da vitrine:** `.github/plugin/marketplace.json`. A página e a tabela do
  README saem dele.

## 3. Layout do repositório

```
.
├─ .github/plugin/marketplace.json   # manifesto central (o CLI lê; a vitrine também)
├─ .github/agents/publisher.agent.md  # coordena a publicação; DELEGA o design ao vitrine
├─ .github/agents/vitrine.agent.md     # especialista de design da página (frontend-design)
├─ plugins/<nome>/                    # runtime vendado de cada plugin (NÃO editar à mão)
│  ├─ plugin.json                     # metadados + marcadores (extensions / hooks)
│  ├─ hooks.json                      # (opcional) hooks de ciclo de vida
│  └─ <runtime: extension.mjs, boot.mjs, *.py, *.ps1, *.html, ...>
├─ docs/                              # vitrine (GitHub Pages, gerada)
│  ├─ build.mjs                       # gerador: manifesto + content -> index + páginas + README
│  ├─ index.html                      # GERADO (não editar à mão)
│  ├─ p/<nome>/index.html             # GERADO: a PÁGINA DEDICADA de cada plugin
│  ├─ content/<nome>.json             # conteúdo rico da página (você escreve; ver §6.1)
│  ├─ gate.mjs                        # gate de publicação (check / mark / prepush) — ver §6.2
│  ├─ .reviewed.json                  # marcador "revisado" por plugin (versão+hash) — GERADO por mark
│  ├─ githooks/{pre-push,dispatch.mjs} # fonte do hook global (instalado por install-gate.mjs)
│  ├─ install-gate.mjs                # instala o hook global e liga core.hooksPath (1x por máquina)
│  └─ assets/{styles.css,app.js}      # design escrito à mão (edite estes ao afinar visual)
├─ README.md                          # tabela entre <!-- plugins:start/end --> é GERADA
└─ AGENTS.md                          # este guia
```

## 4. Anatomia de um plugin

### 4.1 `plugin.json`

```jsonc
{
  "name": "meu-plugin",
  "version": "0.1.0",
  "description": "Uma frase clara do que faz, na voz do usuário.",
  "author": { "name": "Allan Santos", "url": "https://github.com/AllanSantos-DV" },
  "homepage": "https://github.com/AllanSantos-DV/<origem>",
  "repository": "https://github.com/AllanSantos-DV/<origem>",
  "license": "MIT",
  "keywords": ["ate", "6", "tags", "curtas"],
  "category": "productivity",
  "extensions": ["."],       // OPCIONAL: marca o plugin como canvas extension (ver 4.3)
  "hooks": "hooks.json"      // OPCIONAL: aponta o arquivo de hooks (ver 4.2)
}
```

Campos usados pela vitrine: `name, version, description, category, keywords, repository,
homepage`. Mantenha a `description` curta (cabe num card) e em pt-BR.

> **A `description` é SEMÂNTICA, não um changelog.** Ela descreve **o que aquela versão
> entrega** — o uso do plugin, na voz do usuário — e nada mais. Regras:
>
> - **Cada versão é um produto novo.** Descreva o **estado atual** do plugin, como se fosse
>   a primeira vez. Não é uma linha do tempo.
> - **Nunca vire changelog/timeline.** Não acumule `NOVO:`/`AGORA:`, não cite a versão
>   anterior, não liste "o que mudou". Se um recurso deixou de ser novidade, ele é só parte
>   do que o plugin faz — reescreva a frase inteira, não anexe.
> - **Mínima e concreta.** 1–3 frases que dão o entendimento do produto (os plugins desta
>   vitrine ficam em ~150–400 chars). Sem jargão interno, sem números de ADR, sem detalhes
>   de implementação que o usuário não precisa.
> - **Limite HARD: 1024 caracteres.** O schema do marketplace do Copilot rejeita acima disso
>   e, quando isso acontece, o `copilot plugin update` para de ler o marketplace **inteiro**
>   (todos os plugins deixam de atualizar). Por isso `docs/gate.mjs` recusa o push de uma
>   `description` estourada — falha cedo, apontando o plugin culpado.
>
> A mesma filosofia vale para o `tagline`/`lede` da página dedicada (`docs/content/<nome>.json`,
> escrita pelo `vitrine`).

### 4.2 `hooks.json` (opcional)

Hooks de ciclo de vida do Copilot CLI. Padrão usado aqui (rodar um bootstrap no início da
sessão):

```json
{
  "version": 1,
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "node boot.mjs", "timeout": 20 }
    ]
  }
}
```

### 4.3 Canvas extension (`extensions`) + `canvas-sync`

Um plugin que registra um **canvas** (painel de UI no app GUI) precisa do marcador
`"extensions": ["."]` no `plugin.json`. Detalhe importante do app:

- O app GUI só carrega canvases de `~/.copilot/extensions/`.
- Instalar pelo marketplace cai em `~/.copilot/installed-plugins/` → **não** roda como canvas.
- O plugin **`canvas-sync`** (infra desta vitrine) espelha, num hook de `SessionStart`, os
  plugins com marcador `extensions` de `installed-plugins/` para `extensions/`. É idempotente
  (stamp `.canvas-sync.json`) e nunca sobrescreve uma pasta sem stamp (cópia de dev fica intacta).
- Cada plugin canvas traz um `boot.mjs` (hook `SessionStart`) que **baixa o `canvas-sync`**
  desta vitrine se ele ainda não existir — o usuário só escolhe o plugin.
- Após instalar/atualizar, **reinicie o app uma vez** para o hook popular `extensions/`.

## 5. A fonte de verdade: `.github/plugin/marketplace.json`

```jsonc
{
  "name": "copilot-marketplace",
  "owner": { "name": "Allan Santos" },
  "metadata": { "description": "...", "version": "1.0.0" },
  "plugins": [
    {
      "name": "meu-plugin",
      "description": "...",
      "version": "0.1.0",
      "source": "./plugins/meu-plugin",            // vendado neste repo
      // OU, para referenciar outro repo:
      // "source": { "source": "github", "repo": "AllanSantos-DV/origem", "path": "plugin" },
      "author": { "name": "Allan Santos" },
      "homepage": "https://github.com/AllanSantos-DV/origem",
      "repository": "https://github.com/AllanSantos-DV/origem",
      "license": "MIT",
      "keywords": ["..."],
      "category": "productivity"
    }
  ]
}
```

Toda entrada precisa bater com o `plugin.json` vendado (nome, versão, descrição). A **ordem
editorial** na vitrine é definida em `docs/build.mjs` (`const ORDER`); plugins fora dessa lista
caem depois, na ordem do manifesto.

## 6. A vitrine (`docs/`)

- Gerada por `node docs/build.mjs` — Node puro, **sem dependências**, sem Actions.
- O gerador lê `marketplace.json` **+** `docs/content/<nome>.json`, escreve `docs/index.html`
  (cards assados que linkam para a página dedicada), uma **página dedicada** por plugin em
  `docs/p/<nome>/index.html` e **sincroniza a tabela do README** entre `<!-- plugins:start -->`
  e `<!-- plugins:end -->`.
- Design: `docs/assets/styles.css` e `docs/assets/app.js` são escritos à mão — **edite estes**
  para mexer no visual; os `.html` (`index.html` e `p/<nome>/index.html`) são sempre regenerados
  e **nunca** se editam à mão.
- Publicação: GitHub Pages, branch `main`, pasta `/docs`. Ligar uma vez:
  `gh api -X POST repos/AllanSantos-DV/copilot-marketplace/pages -f 'source[branch]=main' -f 'source[path]=/docs'`.

### 6.1 Páginas dedicadas e `docs/content/<nome>.json`

Cada plugin tem uma **página dedicada** (`/p/<nome>/`) com o que é, como usar, como instalar,
a estrutura e a navegação entre plugins. O conteúdo rico vem de `docs/content/<nome>.json`
(você escreve; **desenhe com a skill `frontend-design`**). Se o arquivo faltar, a página ainda
é gerada a partir dos metadados — mas o certo é sempre ter o content file.

O gerador **injeta sozinho**: hero (nome, versão, links, install), seção **Instalar**
(registrar + instalar + atualizar, com aviso de canvas quando aplicável), seção **Estrutura**
(árvore de `plugins/<nome>/`, derivada do disco), o aside de **meta**, a **TOC** e o **prev/next**.
Você cuida do resto. Esquema:

```jsonc
{
  "tagline": "Gancho de uma linha (vira o card e a meta description).",
  "lede": "Parágrafo de abertura do hero. Aceita `code` e **negrito**.",
  "highlights": [ { "title": "...", "body": "..." } ],   // 2–4 cartões
  "sections": [
    {
      "id": "o-que-e",                                    // sem acento -> âncora + TOC
      "title": "O que é",
      "blocks": [
        { "type": "p", "text": "com `code` e **negrito**" },
        { "type": "list", "items": ["..."] },
        { "type": "steps", "items": [ { "title": "...", "text": "..." } ] },
        { "type": "code", "lang": "sh", "code": "...", "copy": true },
        { "type": "cmd", "text": "copilot ..." },         // prompt copiável
        { "type": "note", "tone": "info", "text": "callout (info | warn)" }
      ]
    }
  ],
  "requirements": ["Windows 10/11", "Node 18+"],          // opcional -> aside
  "faq": [ { "q": "...", "a": "..." } ],                   // opcional
  "files": { "extension.mjs": "papel custom na Estrutura" } // opcional
}
```

> **Design:** estenda a identidade da vitrine (coral = comando, mint = versão/status; mono IBM
> Plex como voz de terminal). A **assinatura** da página dedicada é a árvore de arquivos
> (`.tree`). Novos componentes/refinos vão em `docs/assets/`, nunca no HTML gerado.

### 6.2 O gate de publicação (`docs/gate.mjs` + hook global)

Uma **trava técnica** garante que nenhum plugin seja publicado sem a página dedicada revisada.
Não é só regra de agente: é um **hook global de `pre-push`** que recusa o `git push` para este
repo quando um plugin mudou sem revisão.

- **Marcador de revisado:** `docs/.reviewed.json` mapeia cada plugin para `{ version, hash }`,
  onde `hash` cobre `plugins/<nome>/plugin.json` + `docs/content/<nome>.json`. Quem grava é o
  agente, via `node docs/gate.mjs mark <nome>` (ou `--all`). Se a página ou a versão mudam, o
  hash muda e o marcador precisa ser refeito.
- **Gate (`docs/gate.mjs`):** três modos —
  - `node docs/gate.mjs check` → valida a working tree (todo plugin com página + marcador em dia).
  - `node docs/gate.mjs mark <nome|--all>` → grava/atualiza o marcador.
  - `node docs/gate.mjs prepush <remoteUrl>` → usado pelo hook; lê a stdin do `pre-push`, e se o
    remote é este repo, verifica os plugins tocados no push contra o marcador (via `git show` no
    commit que está subindo). Bloqueia (exit≠0) se faltar revisão.
- **Hook global (uma vez por máquina):** `node docs/install-gate.mjs` copia
  `docs/githooks/{pre-push,dispatch.mjs}` para `~/.copilot/githooks/` e aponta
  `git config --global core.hooksPath` para lá. O `dispatch.mjs` roda em todos os repos, mas só
  age onde existe `docs/gate.mjs` (este repo/forks); em qualquer outro é **transparente**
  (fail-open e preserva o hook local). Status: `node docs/install-gate.mjs --status`;
  remover: `--uninstall`.
- **Quando o push é bloqueado:** a mensagem pede para acionar o `publisher` (publica e delega o
  design) ou o `vitrine` (só desenha). Depois de desenhar + `gate.mjs mark <nome>` + commit, o
  push libera. O commit deve incluir o `docs/.reviewed.json`.

> É global de propósito: o repo vive em worktrees/clones, então a trava mora na máquina e
> reconhece o repo pelo **remote**, não pela pasta.

## 7. Fluxos

### 7.1 Publicar/atualizar um plugin existente (sequência — nesta ordem)

1. **Vender:** copie o runtime já empacotado para `plugins/<nome>/` (da origem; não edite à mão).
2. **Versão:** suba `version` em `plugins/<nome>/plugin.json` (semver).
3. **Página (obrigatório):** escreva/atualize `docs/content/<nome>.json` aplicando a skill
   `frontend-design` — é a página dedicada do plugin, parte da publicação (ver §6.1). Com o
   agente `publisher`, este passo é **delegado ao agente `vitrine`** automaticamente (ver §7.4).
4. **Manifesto:** reflita `name/version/description` em `.github/plugin/marketplace.json`.
5. **Gerar:** `node docs/build.mjs` (atualiza `index.html`, `docs/p/<nome>/` + tabela do README).
6. **Marcar revisado:** `node docs/gate.mjs mark <nome>` (grava `docs/.reviewed.json`; é o que o
   gate exige para liberar o push — ver §6.2). Confira com `node docs/gate.mjs check`.
7. **Commit** em `main` — a publicação. Ex.: `chore(<nome>): sync v<versão>` (inclua o marcador).

> Alguns plugins têm um `publish.ps1` **local** na origem que faz 1–4 e dá push. Ex.: `voice-chat`
> é publicado do repo `copilot-voice`; `action-bridge` é empacotado com esbuild do repo privado do
> Action; `copilot-mobile`/`copilot-remote` são vendados dos seus repos privados.

### 7.2 Adicionar um plugin NOVO

1. Crie `plugins/<nome>/` com o runtime + `plugin.json` (seção 4). Se for canvas, inclua
   `"extensions": ["."]`, um `hooks.json` e o `boot.mjs` que baixa o `canvas-sync`.
2. Acrescente a entrada no array `plugins` de `.github/plugin/marketplace.json`.
3. Escreva `docs/content/<nome>.json` com a skill `frontend-design` — a página dedicada (§6.1).
4. (Opcional) Adicione o `<nome>` em `const ORDER` de `docs/build.mjs` para posicioná-lo na vitrine.
5. `node docs/build.mjs`.
6. Commit `feat(<nome>): add <nome> v<versão>`.

### 7.3 Migrar/criar uma canvas extension do Copilot

- Estruture a extensão como plugin (seção 4.3): `plugin.json` com `extensions`, `hooks.json`
  (`SessionStart → node boot.mjs`) e o `boot.mjs` que garante o `canvas-sync`.
- Vende em `plugins/<nome>/`, registre no manifesto, gere a vitrine, commit. O `canvas-sync`
  cuida de espelhar para `~/.copilot/extensions/` na máquina do usuário.

### 7.4 Os agentes `publisher` e `vitrine` (dois papéis, um handoff)

A publicação é dividida em **dois papéis**, cada um com seu agente — assim o design nunca é
esquecido e nunca se mistura com a mecânica de release:

- **`publisher`** (`.github/agents/publisher.agent.md`) — o **coordenador**. Faz vender, versão,
  manifesto, `node docs/build.mjs` e commit. No **passo do design (3)**, ele **delega ao
  `vitrine`** em vez de escrever a página sozinho.
- **`vitrine`** (`.github/agents/vitrine.agent.md`) — o **especialista de design**. Escreve/
  atualiza `docs/content/<nome>.json` aplicando a skill `frontend-design`. Não vende, não sobe
  versão, não commita. Pode ser usado **solo** (só (re)desenhar uma página) ou **delegado** pelo
  `publisher`.

Fluxo do handoff (é o que você escolheu: **sub-agente, uma sessão**):

```
você → publisher : "publica o voice-chat"
publisher        : vender + versão
publisher → vitrine (sub-agente) : "desenhe docs/content/voice-chat.json (frontend-design)"
vitrine → publisher              : content file pronto e válido
publisher        : manifesto + build + verificar + commit
```

O `publisher` delega pelo mecanismo que existir no runtime (ferramenta de sub-agente como
`delegate_child`/`runSubagent`; senão o `handoff` do frontmatter; e, em último caso, cumpre o
papel inline seguindo o `vitrine`). Detalhes na seção "Como delegar" do `publisher.agent.md`.

- Para publicar/atualizar um plugin, invoque o **`publisher`** — ele chama o `vitrine` sozinho.
- Para só redesenhar uma página, invoque o **`vitrine`** direto.
- Se o seu Copilot CLI carrega agentes só de `~/.copilot/agents/`, copie os dois para lá
  (`cp .github/agents/*.agent.md ~/.copilot/agents/`); a versão do repo é a fonte de verdade.
- Ambos dependem da skill `frontend-design` (`~/.copilot/skills/frontend-design`) — se faltar,
  instale-a antes.

## 8. Convenções de commit

- **Conventional Commits**, assunto em **uma linha** (`feat:`, `fix:`, `chore:`, `docs:`…),
  com escopo do plugin quando fizer sentido: `chore(voice-chat): sync v1.2.1`.
- Inclua o trailer:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.

## 9. Checklist antes do commit

- [ ] `plugin.json` com `version` bumpada e `description` curta em pt-BR.
- [ ] `docs/content/<nome>.json` criado/atualizado e desenhado com `frontend-design` (§6.1).
- [ ] Entrada correspondente em `.github/plugin/marketplace.json` (mesma versão/descrição).
- [ ] `node docs/build.mjs` rodado (index.html + `docs/p/<nome>/` + tabela do README atualizados).
- [ ] `node docs/gate.mjs mark <nome>` rodado e `docs/.reviewed.json` incluído no commit (§6.2).
- [ ] `node docs/gate.mjs check` diz "ok" (senão o push é bloqueado pelo gate).
- [ ] Nada editado à mão em `plugins/<nome>/` nem nos `.html` gerados (`index.html`, `p/<nome>/`).
- [ ] Commit em Conventional Commits, uma linha, com o trailer.
