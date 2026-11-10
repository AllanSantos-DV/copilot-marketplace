// `gate.mjs`: contrato do plugin vendado (manifesto = plugin.json, `hooks` existente) e bump de versão no pre-push.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../docs/gate.mjs", import.meta.url));
const REMOTE = "https://github.com/AllanSantos-DV/copilot-marketplace.git";

let root;
const put = (rel, text) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const run = (cmd, args, input) => spawnSync(cmd, args, { cwd: root, input, encoding: "utf8", windowsHide: true });
const gate = (args, input) => run(process.execPath, [join(root, "docs", "gate.mjs"), ...args], input);
const git = (...args) => run("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
const head = () => git("rev-parse", "HEAD").stdout.trim();

/** Grava manifesto + plugin.json de um plugin, com a página e o marcador em dia. */
function plugin(name, { version = "1.0.0", description = "Faz X.", manifestDescription = description, hooks } = {}) {
  const pj = { name, version, description, ...(hooks ? { hooks } : {}) };
  put(`plugins/${name}/plugin.json`, JSON.stringify(pj));
  put(`docs/content/${name}.json`, "{}");
  put(".github/plugin/marketplace.json", JSON.stringify({ plugins: [{ name, version, description: manifestDescription }] }));
  assert.equal(gate(["mark", name]).status, 0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-contract-"));
  mkdirSync(join(root, "docs"));
  copyFileSync(GATE, join(root, "docs", "gate.mjs"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("check passa quando manifesto e plugin.json batem", () => {
  plugin("demo");
  assert.equal(gate(["check"]).status, 0);
});

test("check recusa description diferente entre manifesto e plugin.json", () => {
  plugin("demo", { manifestDescription: "Outra coisa." });
  const r = gate(["check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /demo: description do manifesto ≠ plugins\/demo\/plugin\.json/);
});

test("check aceita a divergência conhecida da lista e pede para tirá-la quando some", () => {
  plugin("copilot-mobile", { manifestDescription: "Texto do manifesto.", hooks: "hooks.json" });
  assert.equal(gate(["check"]).status, 0);
  plugin("copilot-mobile", { hooks: "hooks.json" });
  const r = gate(["check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tire a exceção de KNOWN_MANIFEST_DIVERGENCES/);
});

test("check recusa hooks apontando para arquivo que não existe", () => {
  plugin("demo", { hooks: "hooks.json" });
  const r = gate(["check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /demo: plugin\.json aponta hooks para hooks\.json, que não existe/);
});

test("check aceita hooks apontando para arquivo vendado", () => {
  plugin("demo", { hooks: "hooks.json" });
  put("plugins/demo/hooks.json", "{}");
  assert.equal(gate(["check"]).status, 0);
});

test("check pede para tirar a exceção de hooks quebrado quando o campo some", () => {
  plugin("action-bridge", { hooks: "hooks.json" });
  assert.equal(gate(["check"]).status, 0);
  plugin("action-bridge");
  const r = gate(["check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tire a exceção de KNOWN_DANGLING_HOOKS/);
});

/** Prepara um repo git com o plugin publicado e devolve o sha base. */
function publishedRepo() {
  git("init", "-q");
  plugin("demo");
  put("plugins/demo/run.mjs", "export const v = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: demo 1.0.0");
  return head();
}
const pushLine = (base, tip) => `refs/heads/main ${tip} refs/heads/main ${base}\n`;

test("prepush recusa runtime alterado sem subir a versão", () => {
  const base = publishedRepo();
  put("plugins/demo/run.mjs", "export const v = 2;\n");
  git("commit", "-q", "-am", "fix: demo");
  const r = gate(["prepush", REMOTE], pushLine(base, head()));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /demo: plugins\/demo\/ mudou sem subir a versão \(v1\.0\.0 → v1\.0\.0\)/);
});

test("prepush libera runtime alterado com versão nova", () => {
  const base = publishedRepo();
  put("plugins/demo/run.mjs", "export const v = 2;\n");
  plugin("demo", { version: "1.0.1" });
  git("add", "-A");
  git("commit", "-q", "-m", "fix: demo 1.0.1");
  const r = gate(["prepush", REMOTE], pushLine(base, head()));
  assert.equal(r.status, 0, r.stderr);
});

test("prepush recusa versão que desce", () => {
  const base = publishedRepo();
  plugin("demo", { version: "0.9.0" });
  git("add", "-A");
  git("commit", "-q", "-m", "chore: demo 0.9.0");
  const r = gate(["prepush", REMOTE], pushLine(base, head()));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /v1\.0\.0 → v0\.9\.0/);
});

test("prepush recusa manifesto divergente do plugin.json no commit enviado", () => {
  const base = publishedRepo();
  put(".github/plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "demo", version: "1.0.0", description: "Outra." }] }));
  git("commit", "-q", "-am", "docs: manifesto");
  const r = gate(["prepush", REMOTE], pushLine(base, head()));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /description do manifesto ≠/);
});
