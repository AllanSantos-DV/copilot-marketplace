// Gerador estático da vitrine (GitHub Pages) do copilot-marketplace.
//
// Lê a fonte de verdade `.github/plugin/marketplace.json` e assa:
//   - `docs/index.html`            — a vitrine (um card por plugin, linkando a página dedicada)
//   - `docs/p/<nome>/index.html`   — a PÁGINA DEDICADA de cada plugin (o que é, como usar,
//                                    como instalar, estrutura, meta, navegação prev/next)
// e sincroniza a tabela do README. Sem framework, sem dependências, sem GitHub Actions.
// Rode `node docs/build.mjs` como último passo do publish (o commit é a publicação).
//
// De onde vem o conteúdo de cada página:
//   - metadados canônicos   -> `.github/plugin/marketplace.json` (nome, versão, descrição, links)
//   - conteúdo rico          -> `docs/content/<nome>.json` (tagline, seções, destaques) — opcional
//   - estrutura ("toda a estrutura") -> derivada lendo `plugins/<nome>/`
//   - marcadores (canvas/hooks)      -> lidos do `plugins/<nome>/plugin.json` vendado
//
// O CSS (`assets/styles.css`) e o JS (`assets/app.js`) são escritos à mão e NÃO são
// gerados aqui — edite-os direto ao afinar o design; só os .html são regenerados.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MANIFEST = join(ROOT, ".github", "plugin", "marketplace.json");
const CONTENT_DIR = join(HERE, "content");
const PLUGINS_DIR = join(ROOT, "plugins");
const OUT_INDEX = join(HERE, "index.html");
const PAGES_DIR = join(HERE, "p");

// Ordem editorial da vitrine (o que abre a página e a ordem de navegação prev/next).
// Plugins fora da lista caem depois, na ordem do manifesto. É a ÚNICA curadoria de ordem
// feita aqui — todo o resto vem do manifesto + docs/content, então a vitrine nunca desatualiza.
const ORDER = ["voice-chat", "action-bridge", "copilot-mobile", "copilot-remote", "mcp-bridge", "canvas-sync"];

const SITE = "https://allansantos-dv.github.io/copilot-marketplace";
const REGISTER_CMD = "copilot plugin marketplace add AllanSantos-DV/copilot-marketplace";
const installCmd = (name) => `copilot plugin install ${name}@copilot-marketplace`;
const updateCmd = (name) => `copilot plugin update ${name}`;

// Papel curto de cada arquivo de runtime, para a seção "Estrutura" contar uma história em vez
// de só listar nomes. O content file pode sobrescrever via `files: { "arquivo": "papel" }`.
const FILE_ROLES = {
  "extension.mjs": "Extensão in-app: hooks e tools da sessão viva do agente.",
  "boot.mjs": "Bootstrap de SessionStart: baixa/garante o canvas-sync na máquina.",
  "bootstrap.mjs": "Provisiona o runtime pesado sob demanda (baixa a release buildada).",
  "hooks.json": "Hooks de ciclo de vida (SessionStart e afins).",
  "plugin.json": "Metadados do plugin + marcadores (extensions / hooks).",
  "sync.mjs": "Espelha canvas extensions instaladas para ~/.copilot/extensions.",
  "daemon.mjs": "Fala com o daemon apartado (fora da sessão).",
  "client.mjs": "Cliente de transporte (HTTP/SSE).",
  "access.mjs": "Controle de acesso e pareamento.",
  "drift.mjs": "Detecção pura de drift celular→PC (sem I/O, testada).",
  "panel.html": "Canvas: painel de UI carregado pelo app GUI.",
  "iframe.html": "Canvas: painel de UI carregado pelo app GUI.",
  "desktop.html": "Canvas: painel de pareamento no desktop.",
  "voice_worker.py": "Worker de voz local (STT / Whisper).",
  "tts.ps1": "Síntese de voz local no Windows (fala o resumo).",
  "requirements.txt": "Dependências Python do worker de voz.",
  "qrcode.min.js": "Gera o QR de pareamento no painel.",
  "README.md": "Documentação vinda do repositório de origem.",
};

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// Micro-markup inline seguro para os textos do content: escapa tudo e então reabilita
// só `code` (crase) e **negrito**. Nada de HTML cru vindo do JSON.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
}

const fmtSize = (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`);

// ---------- carga + enriquecimento ----------
function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Anda plugins/<nome>/ e devolve arquivos (relativos), com tamanho e papel. Um nível de
// subpasta é prefixado (os plugins são planos hoje, mas fica robusto).
function walkPlugin(name, roles) {
  const base = join(PLUGINS_DIR, name);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((e) => {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, rel);
          return;
        }
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {}
        out.push({ name: rel, size: fmtSize(size), role: roles?.[rel] ?? roles?.[e.name] ?? FILE_ROLES[e.name] ?? "" });
      });
  };
  walk(base, "");
  return out;
}

function load() {
  const raw = readJSON(MANIFEST) ?? {};
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  const rank = (p) => {
    const i = ORDER.indexOf(p.name);
    return i === -1 ? ORDER.length + plugins.indexOf(p) : i;
  };
  const sorted = [...plugins].sort((a, b) => rank(a) - rank(b));
  const enriched = sorted.map((p) => {
    const content = readJSON(join(CONTENT_DIR, `${p.name}.json`)) ?? {};
    const vended = readJSON(join(PLUGINS_DIR, p.name, "plugin.json")) ?? {};
    const markers = { extensions: Boolean(vended.extensions), hooks: Boolean(vended.hooks) };
    const files = walkPlugin(p.name, content.files);
    return { ...p, content, markers, files };
  });
  return { meta: raw.metadata ?? {}, plugins: enriched };
}

// ---------- peças reusáveis ----------
function promptLine(cmd, label) {
  const aria = label ? ` aria-label="${esc(label)}"` : ' aria-label="Copiar comando"';
  return `<div class="prompt prompt--sm" data-cmd="${esc(cmd)}">
        <span class="prompt__glyph" aria-hidden="true">⌁</span>
        <code class="prompt__cmd">${esc(cmd)}</code>
        <button class="copy" type="button" data-copy="${esc(cmd)}"${aria}>copiar</button>
      </div>`;
}

// Um link some quando homepage === repository (evita dois botões idênticos).
function links(p) {
  const out = [];
  if (p.repository) out.push(`<a class="lnk" href="${esc(p.repository)}" rel="noopener">código<span aria-hidden="true">↗</span></a>`);
  if (p.homepage && p.homepage !== p.repository)
    out.push(`<a class="lnk" href="${esc(p.homepage)}" rel="noopener">site<span aria-hidden="true">↗</span></a>`);
  return out.join("\n          ");
}

function tags(p) {
  return (p.keywords ?? [])
    .slice(0, 6)
    .map((k) => `<li>${esc(k)}</li>`)
    .join("");
}

// ---------- blocos do content (página dedicada) ----------
function codeBlock(b) {
  const copy = b.copy
    ? `<button class="copy copy--code" type="button" data-copy="${esc(b.code)}" aria-label="Copiar bloco de código">copiar</button>`
    : "";
  return `<div class="codeblock">${copy}<pre><code>${esc(b.code)}</code></pre></div>`;
}

function block(b) {
  switch (b?.type) {
    case "p":
      return `<p>${inline(b.text)}</p>`;
    case "list":
      return `<ul class="doc-list">${(b.items ?? []).map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
    case "steps":
      return `<ol class="doc-steps">${(b.items ?? [])
        .map((s) => `<li><h4>${inline(s.title)}</h4>${s.text ? `<p>${inline(s.text)}</p>` : ""}</li>`)
        .join("")}</ol>`;
    case "code":
      return codeBlock(b);
    case "cmd":
      return promptLine(b.text);
    case "note":
      return `<aside class="note note--${b.tone === "warn" ? "warn" : "info"}"><span class="note__mark" aria-hidden="true">${
        b.tone === "warn" ? "!" : "i"
      }</span><p>${inline(b.text)}</p></aside>`;
    default:
      return "";
  }
}

function sectionShell(id, title, inner) {
  return `        <section class="doc-section" id="${esc(id)}">
          <h2 class="doc-h2"><a class="doc-anchor" href="#${esc(id)}" aria-label="Link para ${esc(title)}">#</a>${inline(title)}</h2>
${inner}
        </section>`;
}

function contentSection(sec) {
  const inner = (sec.blocks ?? []).map((b) => `          ${block(b)}`).join("\n");
  return sectionShell(sec.id, sec.title, inner);
}

function installSection(p) {
  const canvas = p.markers.extensions
    ? block({
        type: "note",
        tone: "warn",
        text: "Este plugin registra um **canvas** (painel no app). Depois de instalar, **reinicie o app uma vez**: o `canvas-sync` espelha a extensão para `~/.copilot/extensions/` e o app a descobre no próximo boot.",
      })
    : "";
  const inner = [
    `          <p>Registre a vitrine uma vez (se ainda não fez):</p>`,
    `          ${promptLine(REGISTER_CMD, "Copiar comando de registro do marketplace")}`,
    `          <p>Instale o <code>${esc(p.name)}</code>:</p>`,
    `          ${promptLine(installCmd(p.name), `Copiar comando de instalação do ${p.name}`)}`,
    `          <p>Atualize quando quiser (ou todos com <code>--all</code>):</p>`,
    `          ${promptLine(updateCmd(p.name), `Copiar comando de atualização do ${p.name}`)}`,
    canvas ? `          ${canvas}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return sectionShell("instalar", "Instalar", inner);
}

function structureSection(p) {
  if (!p.files.length) return "";
  const rows = p.files
    .map(
      (f) => `            <li class="tree__row">
              <code class="tree__name">${esc(f.name)}</code>
              <span class="tree__role">${inline(f.role)}</span>
              <span class="tree__size">${esc(f.size)}</span>
            </li>`
    )
    .join("\n");
  const inner = `          <p>Runtime <strong>vendado</strong> em <code>plugins/${esc(p.name)}/</code> — vem do repositório de origem, então <strong>não se edita à mão</strong> aqui. É isto que o <code>copilot plugin install</code> entrega:</p>
          <div class="tree">
            <div class="tree__head"><span class="prompt__glyph" aria-hidden="true">⌁</span> plugins/${esc(p.name)}/</div>
            <ul class="tree__list">
${rows}
            </ul>
          </div>`;
  return sectionShell("estrutura", "Estrutura", inner);
}

function faqSection(faq) {
  const inner = faq
    .map(
      (item) => `          <details class="faq">
            <summary>${inline(item.q)}</summary>
            <p>${inline(item.a)}</p>
          </details>`
    )
    .join("\n");
  return sectionShell("faq", "Perguntas frequentes", inner);
}

// ---------- meta lateral ----------
function metaAside(p) {
  const sourceLabel =
    typeof p.source === "string"
      ? "vendado neste repo"
      : p.source?.source === "github"
        ? `github · ${p.source.repo}`
        : "vendado";
  const markerBits = [p.markers.extensions ? "canvas" : null, p.markers.hooks ? "hooks" : null].filter(Boolean);
  const row = (k, v) => `            <div class="meta__row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const rows = [
    row("versão", `<span class="chip">v${esc(p.version)}</span>`),
    row("licença", esc(p.license ?? "MIT")),
    row("categoria", esc(p.category ?? "plugin")),
    row("origem", esc(sourceLabel)),
    markerBits.length ? row("tipo", markerBits.map((m) => `<span class="pill">${esc(m)}</span>`).join(" ")) : "",
    (p.content.requirements ?? []).length
      ? row("requisitos", `<ul class="meta__reqs">${p.content.requirements.map((r) => `<li>${inline(r)}</li>`).join("")}</ul>`)
      : "",
    row("tags", `<ul class="tags tags--meta">${tags(p)}</ul>`),
  ]
    .filter(Boolean)
    .join("\n");
  return `          <dl class="meta">
${rows}
          </dl>`;
}

// ---------- página dedicada ----------
function pluginPage(p, prev, next) {
  const c = p.content;
  const lede = c.lede ?? c.tagline ?? p.description;
  const parts = [];
  for (const sec of c.sections ?? []) parts.push({ id: sec.id, title: sec.title, html: contentSection(sec) });
  parts.push({ id: "instalar", title: "Instalar", html: installSection(p) });
  const structure = structureSection(p);
  if (structure) parts.push({ id: "estrutura", title: "Estrutura", html: structure });
  if ((c.faq ?? []).length) parts.push({ id: "faq", title: "Perguntas frequentes", html: faqSection(c.faq) });

  const toc = parts.map((pt) => `            <li><a href="#${esc(pt.id)}">${esc(pt.title)}</a></li>`).join("\n");
  const body = parts.map((pt) => pt.html).join("\n\n");

  const highlights = (c.highlights ?? []).length
    ? `      <ul class="hl" aria-label="Destaques">
${c.highlights
        .map(
          (h) => `        <li class="hl__item">
          <h3 class="hl__title">${inline(h.title)}</h3>
          <p class="hl__body">${inline(h.body)}</p>
        </li>`
        )
        .join("\n")}
      </ul>`
    : "";

  const prevLink = prev
    ? `<a class="pager__link pager__link--prev" href="../${esc(prev.name)}/"><span class="pager__dir">← anterior</span><span class="pager__name">${esc(prev.name)}</span></a>`
    : `<span></span>`;
  const nextLink = next
    ? `<a class="pager__link pager__link--next" href="../${esc(next.name)}/"><span class="pager__dir">próximo →</span><span class="pager__name">${esc(next.name)}</span></a>`
    : `<span></span>`;

  const metaDesc = c.tagline ?? p.description;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(p.name)} — copilot-marketplace</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#14121C" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(p.name)} — copilot-marketplace" />
  <meta property="og:description" content="${esc(metaDesc)}" />
  <meta property="og:url" content="${SITE}/p/${esc(p.name)}/" />
  <link rel="canonical" href="${SITE}/p/${esc(p.name)}/" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="../../assets/styles.css" />
</head>
<body class="doc">
  <a class="skip" href="#conteudo">Pular para o conteúdo</a>
  <header class="topbar">
    <a class="brand" href="../../"><span class="brand__glyph" aria-hidden="true">⌁</span> copilot-marketplace</a>
    <nav class="topnav" aria-label="Seções">
      <a href="../../#registry">registry</a>
      <a href="../../#publicar">publicar</a>
      <a href="https://github.com/AllanSantos-DV/copilot-marketplace" rel="noopener">github<span aria-hidden="true">↗</span></a>
    </nav>
  </header>

  <main id="conteudo">
    <nav class="crumbs" aria-label="Trilha">
      <a href="../../#registry">registry</a>
      <span class="crumbs__sep" aria-hidden="true">/</span>
      <span aria-current="page">${esc(p.name)}</span>
    </nav>

    <header class="doc-hero">
      <p class="eyebrow">${esc(p.category ?? "plugin")}</p>
      <div class="doc-hero__top">
        <h1 class="doc-hero__name">${esc(p.name)}</h1>
        <span class="chip" title="versão publicada">v${esc(p.version)}</span>
      </div>
      <p class="doc-hero__lede">${inline(lede)}</p>
      <div class="doc-hero__cta">
        ${promptLine(installCmd(p.name), `Copiar comando de instalação do ${p.name}`)}
      </div>
      <div class="doc-hero__links">
        ${links(p)}
      </div>
${highlights}
    </header>

    <div class="doc-grid">
      <article class="doc-body" id="doc-body">
${body}
      </article>

      <aside class="doc-rail" aria-label="Nesta página">
        <nav class="toc" aria-label="Índice">
          <p class="toc__label">nesta página</p>
          <ul class="toc__list">
${toc}
          </ul>
        </nav>
${metaAside(p)}
      </aside>
    </div>

    <nav class="pager" aria-label="Outros plugins">
      ${prevLink}
      <a class="pager__all" href="../../#registry">todos os plugins</a>
      ${nextLink}
    </nav>
  </main>

  <footer class="foot">
    <p class="foot__made">Feito por <a href="https://github.com/AllanSantos-DV" rel="noopener">Allan Santos</a> · MIT · página gerada de <code>marketplace.json</code> + <code>docs/content/${esc(p.name)}.json</code></p>
    <p class="foot__cmd"><span aria-hidden="true">⌁</span> <code>${esc(installCmd(p.name))}</code></p>
  </footer>

  <script src="../../assets/app.js" defer></script>
</body>
</html>
`;
}

// ---------- index (vitrine) ----------
function card(p) {
  const cmd = installCmd(p.name);
  const href = `p/${esc(p.name)}/`;
  return `      <article class="card" id="p-${esc(p.name)}">
        <header class="card__head">
          <h3 class="card__name"><a href="${href}">${esc(p.name)}</a></h3>
          <span class="chip" title="versão publicada">v${esc(p.version)}</span>
        </header>
        <p class="card__cat">${esc(p.category ?? "plugin")}</p>
        <p class="card__desc">${esc(p.content.tagline ?? p.description)}</p>
        <ul class="tags" aria-label="palavras-chave">${tags(p)}</ul>
        <div class="prompt prompt--sm" data-cmd="${esc(cmd)}">
          <span class="prompt__glyph" aria-hidden="true">⌁</span>
          <code class="prompt__cmd">${esc(cmd)}</code>
          <button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copiar comando de instalação do ${esc(p.name)}">copiar</button>
        </div>
        <footer class="card__links">
          <a class="lnk lnk--page" href="${href}">página dedicada<span aria-hidden="true">→</span></a>
          ${links(p)}
        </footer>
      </article>`;
}

const STEPS = [
  ["vender", "Coloque o runtime já empacotado em <code>plugins/&lt;nome&gt;/</code> (nunca edite esses arquivos à mão)."],
  ["versão", "Suba o <code>version</code> no <code>plugins/&lt;nome&gt;/plugin.json</code> — é ele que o <code>copilot plugin update</code> compara."],
  ["conteúdo", "Escreva/atualize a página em <code>docs/content/&lt;nome&gt;.json</code> aplicando a skill <code>frontend-design</code> — é a página dedicada do plugin."],
  ["manifesto", "Reflita nome, versão e descrição em <code>.github/plugin/marketplace.json</code> (a fonte de verdade da vitrine)."],
  ["gerar", "Rode <code>node docs/build.mjs</code> para reassar a vitrine e todas as páginas."],
  ["commit", "Faça o commit em <code>main</code> — <strong>o commit é a publicação</strong>. Sem Actions, sem release."],
];

function pipeline() {
  return STEPS.map(
    ([label, body], i) => `        <li class="step">
          <span class="step__n">${String(i + 1).padStart(2, "0")}</span>
          <div class="step__body">
            <h3 class="step__label">${label}</h3>
            <p>${body}</p>
          </div>
        </li>`
  ).join("\n");
}

function renderIndex({ plugins }) {
  const count = plugins.length;
  const cards = plugins.map(card).join("\n");
  const desc = `Vitrine dos ${count} plugins do Allan para o GitHub Copilot CLI: voz, controle remoto, memória de reuniões, ponte mobile e infra de canvas. 100% local, pt-BR. Cada plugin tem sua página dedicada.`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>copilot-marketplace — plugins do Copilot CLI, do jeito Allan</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#14121C" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="copilot-marketplace" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${SITE}/" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="assets/styles.css" />
</head>
<body>
  <a class="skip" href="#registry">Pular para os plugins</a>
  <header class="topbar">
    <a class="brand" href="#top"><span class="brand__glyph" aria-hidden="true">⌁</span> copilot-marketplace</a>
    <nav class="topnav" aria-label="Seções">
      <a href="#registry">registry</a>
      <a href="#publicar">publicar</a>
      <a href="https://github.com/AllanSantos-DV/copilot-marketplace" rel="noopener">github<span aria-hidden="true">↗</span></a>
    </nav>
  </header>

  <main id="top">
    <section class="hero">
      <p class="eyebrow">marketplace · github copilot cli</p>
      <h1 class="hero__title">Plugins de terminal,<br /><em>do jeito Allan.</em></h1>
      <p class="hero__lede">${count} extensões que vivem onde você já trabalha: no prompt. Voz, controle remoto, memória de reuniões e mais — <strong>100% local</strong>, pt-BR, MIT. Registre a vitrine uma vez e abra a <strong>página dedicada</strong> de cada plugin.</p>
      <div class="prompt prompt--hero" data-cmd="${esc(REGISTER_CMD)}">
        <span class="prompt__glyph" aria-hidden="true">⌁</span>
        <code class="prompt__cmd" id="hero-cmd">${esc(REGISTER_CMD)}</code>
        <button class="copy" type="button" data-copy="${esc(REGISTER_CMD)}" aria-label="Copiar comando de registro do marketplace">copiar</button>
      </div>
      <ul class="stats" aria-label="Resumo">
        <li><b>${count}</b><span>plugins</span></li>
        <li><b>pt-BR</b><span>de origem</span></li>
        <li><b>MIT</b><span>licença</span></li>
        <li><b>100%</b><span>local</span></li>
      </ul>
    </section>

    <section id="registry" class="registry" aria-labelledby="registry-h">
      <div class="section-head">
        <h2 id="registry-h" class="section-head__title"><span class="section-head__mark" aria-hidden="true">//</span> registry</h2>
        <p class="section-head__note">Cada card abre uma página dedicada — o que é, como usar, instalar e a estrutura.</p>
      </div>
      <div class="grid">
${cards}
      </div>
    </section>

    <section id="publicar" class="publish" aria-labelledby="publish-h">
      <div class="section-head">
        <h2 id="publish-h" class="section-head__title"><span class="section-head__mark" aria-hidden="true">//</span> como publicar</h2>
        <p class="section-head__note">Seis passos, em ordem. O último é o único que "publica".</p>
      </div>
      <ol class="pipeline">
${pipeline()}
      </ol>
    </section>
  </main>

  <footer class="foot">
    <p class="foot__made">Feito por <a href="https://github.com/AllanSantos-DV" rel="noopener">Allan Santos</a> · MIT · vitrine gerada de <code>marketplace.json</code></p>
    <p class="foot__cmd"><span aria-hidden="true">⌁</span> <code>copilot plugin update --all</code></p>
  </footer>

  <script src="assets/app.js" defer></script>
</body>
</html>
`;
}

// ---------- README (tabela sincronizada) ----------
function readmeRow(p) {
  const desc = String(p.description ?? "").replaceAll("|", "\\|");
  return `| [\`${p.name}\`](./plugins/${p.name}) · [página](${SITE}/p/${p.name}/) | ${desc} | ${p.version} |`;
}

function syncReadme({ plugins }) {
  const path = join(ROOT, "README.md");
  const START = "<!-- plugins:start -->";
  const END = "<!-- plugins:end -->";
  let txt;
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const s = txt.indexOf(START);
  const e = txt.indexOf(END);
  if (s === -1 || e === -1 || e < s) return false;
  const header = "| Plugin | Descrição | Versão |\n| ------ | --------- | ------ |";
  const rows = plugins.map(readmeRow).join("\n");
  const table = `\n${header}\n${rows}\n`;
  writeFileSync(path, txt.slice(0, s + START.length) + table + txt.slice(e), "utf8");
  return true;
}

// ---------- escrita ----------
const data = load();
writeFileSync(OUT_INDEX, renderIndex(data), "utf8");

const list = data.plugins;
let pages = 0;
list.forEach((p, i) => {
  const dir = join(PAGES_DIR, p.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), pluginPage(p, list[i - 1], list[i + 1]), "utf8");
  pages += 1;
});

const readme = syncReadme(data);
console.log(
  `vitrine gerada: ${OUT_INDEX} · ${pages} página(s) dedicada(s) em docs/p/${readme ? " · README sincronizado" : ""}`
);
