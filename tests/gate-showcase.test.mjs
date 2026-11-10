// `gate.mjs check` recusa vitrine velha: card do index.html e tabela do README precisam bater com o manifesto.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../docs/gate.mjs", import.meta.url));
const DESC = "Faz X | com pipe";

let root;
const put = (rel, text) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const gate = (...args) => spawnSync(process.execPath, [join(root, "docs", "gate.mjs"), ...args], { encoding: "utf8", windowsHide: true });

const card = (version) => `<article class="card" id="p-demo"><span class="chip">v${version}</span></article>`;
const readme = (version, desc = DESC) =>
  `<!-- plugins:start -->\n| Plugin | Descrição | Versão |\n| --- | --- | --- |\n| [\`demo\`](./plugins/demo) · [página](x) | ${desc.replaceAll("|", "\\|")} | ${version} |\n<!-- plugins:end -->\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-showcase-"));
  mkdirSync(join(root, "docs"));
  copyFileSync(GATE, join(root, "docs", "gate.mjs"));
  put(".github/plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "demo", version: "1.0.0", description: DESC }] }));
  put("plugins/demo/plugin.json", JSON.stringify({ name: "demo", version: "1.0.0", description: DESC }));
  put("docs/content/demo.json", "{}");
  put("docs/p/demo/index.html", "<span>v1.0.0</span>");
  put("docs/index.html", card("1.0.0"));
  put("README.md", readme("1.0.0"));
  assert.equal(gate("mark", "demo").status, 0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("check passa quando card e README batem com o manifesto", () => {
  assert.equal(gate("check").status, 0);
});

test("check recusa o card do index.html em versão velha", () => {
  put("docs/index.html", card("0.9.0"));
  const r = gate("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/index\.html não mostra v1\.0\.0/);
});

test("check recusa a tabela do README em versão velha", () => {
  put("README.md", readme("0.9.0"));
  const r = gate("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /README sem v1\.0\.0/);
});

test("check recusa a tabela do README com description velha", () => {
  put("README.md", readme("1.0.0", "texto antigo"));
  const r = gate("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /README com description velha/);
});

test("check recusa o plugin que não tem card no index.html", () => {
  put("docs/index.html", "<article class=\"card\" id=\"p-outro\">v1.0.0</article>");
  const r = gate("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/index\.html não mostra v1\.0\.0/);
});

test("check recusa página que só mostra outra versão com o mesmo prefixo", () => {
  put("docs/p/demo/index.html", "<span>v1.0.05</span>");
  const r = gate("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/p\/demo\/ desatualizada/);
});

test("prepush recusa vitrine velha no commit enviado", () => {
  const git = (...args) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: demo 1.0.0");
  const base = git("rev-parse", "HEAD").stdout.trim();
  put("plugins/demo/plugin.json", JSON.stringify({ name: "demo", version: "1.0.1", description: DESC }));
  put(".github/plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "demo", version: "1.0.1", description: DESC }] }));
  assert.equal(gate("mark", "demo").status, 0);
  git("add", "-A");
  git("commit", "-q", "-m", "chore: demo 1.0.1 sem build");
  const tip = git("rev-parse", "HEAD").stdout.trim();
  const r = spawnSync(process.execPath, [join(root, "docs", "gate.mjs"), "prepush", "https://github.com/AllanSantos-DV/copilot-marketplace.git"], {
    input: `refs/heads/main ${tip} refs/heads/main ${base}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /demo: docs\/p\/demo\/ desatualizada/);
});
