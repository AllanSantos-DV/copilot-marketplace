// `docs/build.mjs` emite `docs/catalog.json` a partir do manifesto, e o gate recusa catálogo velho.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));

let root;
const put = (rel, text) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const node = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true });
const catalog = () => JSON.parse(readFileSync(join(root, "docs", "catalog.json"), "utf8"));

before(() => {
  root = mkdtempSync(join(tmpdir(), "catalog-"));
  mkdirSync(join(root, "docs"));
  for (const f of ["build.mjs", "gate.mjs"]) copyFileSync(join(DOCS, f), join(root, "docs", f));
  const entry = { name: "demo", version: "1.2.0", description: "Faz X.", category: "productivity", keywords: ["a", "b"], repository: "https://example.com/demo" };
  put(".github/plugin/marketplace.json", JSON.stringify({ plugins: [entry] }));
  put("plugins/demo/plugin.json", JSON.stringify({ name: "demo", version: "1.2.0", description: "Faz X.", category: "productivity", repository: "https://example.com/demo", extensions: ["."] }));
  put("docs/content/demo.json", JSON.stringify({ requirements: ["Windows 10/11"] }));
  put("README.md", "<!-- plugins:start -->\n<!-- plugins:end -->\n");
  const r = node("docs/build.mjs");
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("build grava docs/catalog.json com os dados do manifesto", () => {
  const c = catalog();
  assert.match(c.register, /^copilot plugin marketplace add /);
  assert.equal(c.plugins.length, 1);
  assert.deepEqual(c.plugins[0], {
    name: "demo",
    version: "1.2.0",
    description: "Faz X.",
    kind: "plugin",
    category: "productivity",
    keywords: ["a", "b"],
    canvas: true,
    requirements: ["Windows 10/11"],
    page: `${c.site}p/demo/`,
    repository: "https://example.com/demo",
    install: "copilot plugin install demo@copilot-marketplace",
    update: "copilot plugin update demo",
  });
});

test("build é determinístico: rodar de novo gera o mesmo catálogo", () => {
  const first = readFileSync(join(root, "docs", "catalog.json"), "utf8");
  assert.equal(node("docs/build.mjs").status, 0);
  assert.equal(readFileSync(join(root, "docs", "catalog.json"), "utf8"), first);
});

test("gate recusa catálogo com versão velha", () => {
  assert.equal(node("docs/gate.mjs", "mark", "demo").status, 0);
  assert.equal(node("docs/gate.mjs", "check").status, 0);
  const c = catalog();
  c.plugins[0].version = "1.1.0";
  writeFileSync(join(root, "docs", "catalog.json"), JSON.stringify(c));
  const r = node("docs/gate.mjs", "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/catalog\.json não mostra v1\.2\.0/);
});
