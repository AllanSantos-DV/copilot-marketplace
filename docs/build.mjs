// Gerador estático da vitrine (GitHub Pages) do copilot-marketplace.
//
// Lê a fonte de verdade `.github/plugin/marketplace.json` e assa `docs/index.html`
// com um card por plugin — sem framework, sem dependências, sem GitHub Actions.
// Rode `node docs/build.mjs` como último passo do publish (o commit é a publicação).
//
// O CSS (`assets/styles.css`) e o JS (`assets/app.js`) são escritos à mão e NÃO são
// gerados aqui — edite-os direto ao afinar o design; só o index.html é regenerado.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MANIFEST = join(ROOT, ".github", "plugin", "marketplace.json");
const OUT = join(HERE, "index.html");

// Ordem editorial da vitrine (o que abre a página). Plugins fora da lista caem
// depois, na ordem do manifesto. É a ÚNICA curadoria feita aqui — todo o resto
// (nome, versão, descrição, tags, links) vem do manifesto, então a vitrine nunca
// desatualiza: cada plugin publica o próprio conteúdo ao subir sua versão.
const ORDER = ["voice-chat", "action-bridge", "copilot-mobile", "copilot-remote", "canvas-sync"];

const REGISTER_CMD = "copilot plugin marketplace add AllanSantos-DV/copilot-marketplace";
const installCmd = (name) => `copilot plugin install ${name}@copilot-marketplace`;

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function load() {
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  const rank = (p) => {
    const i = ORDER.indexOf(p.name);
    return i === -1 ? ORDER.length + plugins.indexOf(p) : i;
  };
  return { meta: raw.metadata ?? {}, plugins: [...plugins].sort((a, b) => rank(a) - rank(b)) };
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

function card(p) {
  const cmd = installCmd(p.name);
  return `      <article class="card" id="p-${esc(p.name)}">
        <header class="card__head">
          <h3 class="card__name">${esc(p.name)}</h3>
          <span class="chip" title="versão publicada">v${esc(p.version)}</span>
        </header>
        <p class="card__cat">${esc(p.category ?? "plugin")}</p>
        <p class="card__desc">${esc(p.description)}</p>
        <ul class="tags" aria-label="palavras-chave">${tags(p)}</ul>
        <div class="prompt prompt--sm" data-cmd="${esc(cmd)}">
          <span class="prompt__glyph" aria-hidden="true">⌁</span>
          <code class="prompt__cmd">${esc(cmd)}</code>
          <button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copiar comando de instalação do ${esc(p.name)}">copiar</button>
        </div>
        <footer class="card__links">
          ${links(p)}
        </footer>
      </article>`;
}

const STEPS = [
  ["vender", "Coloque o runtime já empacotado em <code>plugins/&lt;nome&gt;/</code> (nunca edite esses arquivos à mão)."],
  ["versão", "Suba o <code>version</code> no <code>plugins/&lt;nome&gt;/plugin.json</code> — é ele que o <code>copilot plugin update</code> compara."],
  ["manifesto", "Reflita nome, versão e descrição em <code>.github/plugin/marketplace.json</code> (a fonte de verdade da vitrine)."],
  ["gerar", "Rode <code>node docs/build.mjs</code> para reassar a vitrine a partir do manifesto."],
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

function render({ plugins }) {
  const count = plugins.length;
  const cards = plugins.map(card).join("\n");
  const desc = `Vitrine dos ${count} plugins do Allan para o GitHub Copilot CLI: voz, controle remoto, memória de reuniões, ponte mobile e infra de canvas. 100% local, pt-BR.`;
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
  <meta property="og:url" content="https://allansantos-dv.github.io/copilot-marketplace/" />
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
      <p class="hero__lede">${count} extensões que vivem onde você já trabalha: no prompt. Voz, controle remoto, memória de reuniões e mais — <strong>100% local</strong>, pt-BR, MIT. Registre a vitrine uma vez e instale o que quiser.</p>
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
        <p class="section-head__note">Cada card sai direto do manifesto — versão sempre atual.</p>
      </div>
      <div class="grid">
${cards}
      </div>
    </section>

    <section id="publicar" class="publish" aria-labelledby="publish-h">
      <div class="section-head">
        <h2 id="publish-h" class="section-head__title"><span class="section-head__mark" aria-hidden="true">//</span> como publicar</h2>
        <p class="section-head__note">Cinco passos, em ordem. O último é o único que "publica".</p>
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

// Mantém a tabela do README em sincronia com o manifesto (mesma fonte de verdade),
// substituindo só o miolo entre os marcadores <!-- plugins:start/end -->.
function readmeRow(p) {
  const desc = String(p.description ?? "").replaceAll("|", "\\|");
  return `| [\`${p.name}\`](./plugins/${p.name}) | ${desc} | ${p.version} |`;
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

const data = load();
writeFileSync(OUT, render(data), "utf8");
const readme = syncReadme(data);
console.log(`vitrine gerada: ${OUT} (${data.plugins.length} plugins)${readme ? " · README sincronizado" : ""}`);
