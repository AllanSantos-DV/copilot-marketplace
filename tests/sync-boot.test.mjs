// `tools/sync-boot.mjs`: a cópia do motor do canvas-sync no mcp-bridge tem de ser idêntica à fonte.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/sync-boot.mjs", import.meta.url));
const MOTOR = 'export const CANVAS_SYNC_VERSION = "1.0.0";\nexport function sync() {}\n';

let root;
const put = (rel, text) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const tool = (...args) => spawnSync(process.execPath, [join(root, "tools", "sync-boot.mjs"), ...args], { encoding: "utf8", windowsHide: true });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-boot-"));
  mkdirSync(join(root, "tools"));
  copyFileSync(TOOL, join(root, "tools", "sync-boot.mjs"));
  put("plugins/canvas-sync/boot.mjs", "// boot\n");
  put("plugins/canvas-sync/sync.mjs", MOTOR);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("motor idêntico no mcp-bridge passa", () => {
  put("plugins/mcp-bridge/sync.mjs", MOTOR);
  const r = tool();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /mcp-bridge\s+motor em sincronia/);
});

test("diferença só de fim de linha não conta como divergência", () => {
  put("plugins/mcp-bridge/sync.mjs", MOTOR.replace(/\n/g, "\r\n"));
  assert.equal(tool().status, 0);
});

test("motor divergente no mcp-bridge falha e --fix ressincroniza", () => {
  put("plugins/mcp-bridge/sync.mjs", MOTOR.replace("1.0.0", "0.9.0"));
  const r = tool();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /mcp-bridge\s+motor DIVERGE da fonte/);
  assert.equal(tool("--fix").status, 0);
  assert.equal(readFileSync(join(root, "plugins/mcp-bridge/sync.mjs"), "utf8"), MOTOR);
  assert.equal(tool().status, 0);
});
