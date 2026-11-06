// Git hooks globais (docs/githooks): comportamento preservado e nenhum processo node nos caminhos comuns.
// Um `node` falso no PATH conta cada início de processo node que um hook provocaria.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = fileURLToPath(new URL("../docs/githooks/", import.meta.url)).replace(/[\\/]$/, "");

let tmp, bin, nodeLog, work, remote, targetRemote, env;

const sh = (cwd, cmd, args, extra = {}) =>
  spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: "utf8", windowsHide: true });
const git = (cwd, ...args) => sh(cwd, "git", args);
const nodeCalls = () => (existsSync(nodeLog) ? readFileSync(nodeLog, "utf8").split("\n").filter(Boolean) : []);
const resetNodeLog = () => rmSync(nodeLog, { force: true });

function commitFile(path, content, message) {
  mkdirSync(join(work, path, ".."), { recursive: true });
  writeFileSync(join(work, path), content);
  git(work, "add", "-A");
  return git(work, "commit", "-m", message);
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "githooks-"));
  bin = join(tmp, "bin");
  nodeLog = join(tmp, "node-calls.log");
  mkdirSync(bin);
  const shim = join(bin, "node");
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${nodeLog.replace(/\\/g, "/")}"\ncat >/dev/null\nexit "\${FAKE_GATE_EXIT:-0}"\n`);
  chmodSync(shim, 0o755);
  env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${HOOKS.replace(/\\/g, "/")}\n[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n`);

  remote = join(tmp, "remote.git");
  work = join(tmp, "work");
  git(tmp, "init", "--bare", remote);
  git(tmp, "init", work);
  mkdirSync(join(work, "docs"));
  writeFileSync(join(work, "docs", "gate.mjs"), "// stub\n");
  git(work, "remote", "add", "origin", remote);
  targetRemote = join(tmp, "AllanSantos-DV", "copilot-marketplace.git").replace(/\\/g, "/");
  mkdirSync(join(tmp, "AllanSantos-DV"));
  git(tmp, "init", "--bare", targetRemote);
  git(work, "remote", "add", "marketplace", targetRemote);
  commitFile("README.md", "x\n", "chore: init");
  git(work, "push", "origin", "main");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("commit-msg: remove o trailer de agente, preserva o resto e não inicia node", () => {
  resetNodeLog();
  const r = commitFile("a.txt", "a\n", "feat: a\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n\n🤖 Generated with [Claude Code](https://claude.com)");
  assert.equal(r.status, 0, r.stderr);
  const body = git(work, "log", "-1", "--format=%B").stdout;
  assert.match(body, /^feat: a/);
  assert.doesNotMatch(body, /co-authored-by|generated with/i);
  assert.deepEqual(nodeCalls(), []);
});

test("commit-msg: mantém co-autor humano", () => {
  const r = commitFile("b.txt", "b\n", "feat: b\n\nCo-authored-by: Maria <maria@example.com>");
  assert.equal(r.status, 0, r.stderr);
  assert.match(git(work, "log", "-1", "--format=%B").stdout, /Co-authored-by: Maria/);
});

test("commit-msg: delega ao hook local e propaga a recusa", () => {
  const hook = join(work, ".git", "hooks", "commit-msg");
  writeFileSync(hook, "#!/bin/sh\necho local-hook-ran >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const r = commitFile("c.txt", "c\n", "feat: c");
  rmSync(hook);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /local-hook-ran/);
  git(work, "reset", "-q", "--hard");
  git(work, "clean", "-fdq");
});

test("pre-push: push sem plugin tocado passa sem node", () => {
  commitFile("notes.md", "n\n", "docs: notes");
  resetNodeLog();
  const r = git(work, "push", "marketplace", "main:refs/heads/other-1");
  assert.ok(!/BLOQUEADO/.test(r.stderr), r.stderr);
  assert.deepEqual(nodeCalls(), []);
  const origin = git(work, "push", "origin", "main");
  assert.equal(origin.status, 0, origin.stderr);
  assert.deepEqual(nodeCalls(), []);
});

test("pre-push: plugin tocado no repo alvo aciona o gate (node) e respeita a recusa", () => {
  commitFile("plugins/x/plugin.json", "{}\n", "feat(x): add");
  resetNodeLog();
  const blocked = sh(work, "git", ["push", "marketplace", "main:refs/heads/other-2"], { FAKE_GATE_EXIT: "1" });
  assert.notEqual(blocked.status, 0);
  assert.equal(nodeCalls().length, 1);
  assert.match(nodeCalls()[0], /gate\.mjs prepush .*copilot-marketplace\.git$/);
});

test("pre-push: remoto fora do alvo nunca aciona o gate", () => {
  resetNodeLog();
  const r = git(work, "push", "origin", "main");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(nodeCalls(), []);
});

test("pre-push: bloqueia commit com atribuição de IA e libera depois de limpo", () => {
  const msg = join(tmp, "msg.txt");
  writeFileSync(msg, "feat: d\n\nCo-authored-by: Claude <noreply@anthropic.com>\n");
  writeFileSync(join(work, "d.txt"), "d\n");
  git(work, "add", "-A");
  // --no-verify pula o commit-msg e deixa o trailer chegar ao push.
  git(work, "commit", "--no-verify", "-F", msg);
  const r = git(work, "push", "origin", "main");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BLOQUEADO/);
  git(work, "commit", "--amend", "-m", "feat: d");
  assert.equal(git(work, "push", "origin", "main").status, 0);
});

test("pre-push: repositório comum encadeia o hook local do repo", () => {
  const plain = join(tmp, "plain");
  const plainRemote = join(tmp, "plain-remote.git");
  git(tmp, "init", "--bare", plainRemote);
  git(tmp, "init", plain);
  git(plain, "remote", "add", "origin", plainRemote);
  writeFileSync(join(plain, "f"), "f\n");
  git(plain, "add", "-A");
  git(plain, "commit", "-m", "init");
  const hook = join(plain, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\necho plain-local-pre-push >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  resetNodeLog();
  const r = git(plain, "push", "origin", "main");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /plain-local-pre-push/);
  assert.deepEqual(nodeCalls(), []);
});
