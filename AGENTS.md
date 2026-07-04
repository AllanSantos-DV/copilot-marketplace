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
├─ plugins/<nome>/                    # runtime vendado de cada plugin (NÃO editar à mão)
│  ├─ plugin.json                     # metadados + marcadores (extensions / hooks)
│  ├─ hooks.json                      # (opcional) hooks de ciclo de vida
│  └─ <runtime: extension.mjs, boot.mjs, *.py, *.ps1, *.html, ...>
├─ docs/                              # vitrine (GitHub Pages, gerada)
│  ├─ build.mjs                       # gerador: marketplace.json -> index.html + tabela do README
│  ├─ index.html                      # GERADO (não editar à mão)
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
- O gerador lê `marketplace.json`, escreve `docs/index.html` (cards assados, bom p/ SEO/no-JS)
  e **sincroniza a tabela do README** entre `<!-- plugins:start -->` e `<!-- plugins:end -->`.
- Design: `docs/assets/styles.css` e `docs/assets/app.js` são escritos à mão — **edite estes**
  para mexer no visual; `index.html` é sempre regenerado.
- Publicação: GitHub Pages, branch `main`, pasta `/docs`. Ligar uma vez:
  `gh api -X POST repos/AllanSantos-DV/copilot-marketplace/pages -f 'source[branch]=main' -f 'source[path]=/docs'`.

## 7. Fluxos

### 7.1 Publicar/atualizar um plugin existente (sequência — nesta ordem)

1. **Vender:** copie o runtime já empacotado para `plugins/<nome>/` (da origem; não edite à mão).
2. **Versão:** suba `version` em `plugins/<nome>/plugin.json` (semver).
3. **Manifesto:** reflita `name/version/description` em `.github/plugin/marketplace.json`.
4. **Gerar:** `node docs/build.mjs` (atualiza `docs/index.html` + tabela do README).
5. **Commit** em `main` — a publicação. Ex.: `chore(<nome>): sync v<versão>`.

> Alguns plugins têm um `publish.ps1` **local** na origem que faz 1–4 e dá push. Ex.: `voice-chat`
> é publicado do repo `copilot-voice`; `action-bridge` é empacotado com esbuild do repo privado do
> Action; `copilot-mobile`/`copilot-remote` são vendados dos seus repos privados.

### 7.2 Adicionar um plugin NOVO

1. Crie `plugins/<nome>/` com o runtime + `plugin.json` (seção 4). Se for canvas, inclua
   `"extensions": ["."]`, um `hooks.json` e o `boot.mjs` que baixa o `canvas-sync`.
2. Acrescente a entrada no array `plugins` de `.github/plugin/marketplace.json`.
3. (Opcional) Adicione o `<nome>` em `const ORDER` de `docs/build.mjs` para posicioná-lo na vitrine.
4. `node docs/build.mjs`.
5. Commit `feat(<nome>): add <nome> v<versão>`.

### 7.3 Migrar/criar uma canvas extension do Copilot

- Estruture a extensão como plugin (seção 4.3): `plugin.json` com `extensions`, `hooks.json`
  (`SessionStart → node boot.mjs`) e o `boot.mjs` que garante o `canvas-sync`.
- Vende em `plugins/<nome>/`, registre no manifesto, gere a vitrine, commit. O `canvas-sync`
  cuida de espelhar para `~/.copilot/extensions/` na máquina do usuário.

## 8. Convenções de commit

- **Conventional Commits**, assunto em **uma linha** (`feat:`, `fix:`, `chore:`, `docs:`…),
  com escopo do plugin quando fizer sentido: `chore(voice-chat): sync v1.2.1`.
- Inclua o trailer:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.

## 9. Checklist antes do commit

- [ ] `plugin.json` com `version` bumpada e `description` curta em pt-BR.
- [ ] Entrada correspondente em `.github/plugin/marketplace.json` (mesma versão/descrição).
- [ ] `node docs/build.mjs` rodado (index.html + tabela do README atualizados).
- [ ] Nada editado à mão em `plugins/<nome>/` que devesse vir da origem.
- [ ] Commit em Conventional Commits, uma linha, com o trailer.
