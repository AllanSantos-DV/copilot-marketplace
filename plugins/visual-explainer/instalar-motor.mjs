// visual-explainer/instalar-motor.mjs — instala (ou atualiza) o motor vxk em ~/.vxk SEM o Copilot: para quem usa só Claude Code, Codex
// ou outro cliente MCP. É o mesmo caminho do boot do plugin (engine-kit: resolve no engine-registry, download com SHA-256 e assinatura
// Ed25519, fail-closed) e depois mostra como declarar o MCP no cliente, apontando para o lançador deste mesmo diretório.
//   node instalar-motor.mjs [--home <pasta>] [--offline] [--json]
// --home instala numa pasta isolada (testes); --offline só confere o que já está instalado, sem baixar. Falha alto: exit 1 com o motivo.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const die = (m) => { process.stderr.write("instalar-motor: " + m + "\n"); process.exit(1); };

// no plugin do marketplace o runtime do engine-kit vem vendorizado ao lado; no repo, de node_modules
const kitIndex = [join(here, "engine-kit", "index.mjs"), join(here, "..", "node_modules", "engine-kit", "kit", "index.mjs")].find(existsSync);
if (!kitIndex) die("engine-kit ausente (nem ao lado do plugin nem em node_modules): rode `npm install` no repo do visual");
const kit = await import(pathToFileURL(kitIndex).href);

const log = (m) => { if (!args.includes("--json")) process.stdout.write("  " + m + "\n"); };
const home = flag("--home") && resolve(flag("--home"));
const r = await kit.resolve("vxk", { allowNetwork: !args.includes("--offline"), refresh: !args.includes("--offline") });
if (!r.ok) die("não achei o motor vxk no registry: " + r.reason);
const engine = home ? { ...r.engine, homeDir: home } : r.engine;
const p = await kit.provision(engine, { log, allowNetwork: !args.includes("--offline") });
if (!p.ok) die("instalação do motor recusada: " + p.reason);
const l = await kit.lifecycle(engine, p.entryPath, { log });
if (!l.available || !l.bin || !existsSync(l.bin)) die("motor instalado mas sem binário: " + (l.reason || "não encontrado"));

const pointer = join(home || process.env.VXK_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".vxk"), "cli.json");
let versao = p.version;
try { versao = JSON.parse(readFileSync(pointer, "utf8")).version || versao; } catch { /* o ponteiro nasce no 1º uso do motor */ }
const launcher = join(here, "vxk-launch.mjs");
const saida = {
  ok: true, versao, bin: l.bin, ponteiro: pointer,
  claude_code: `claude mcp add --scope user vxk -- node "${launcher}"`,
  codex: `[mcp_servers.vxk]\ncommand = "node"\nargs = ["${launcher.replace(/\\/g, "/")}"]   # em ~/.codex/config.toml`,
};
if (args.includes("--json")) process.stdout.write(JSON.stringify(saida, null, 2) + "\n");
else process.stdout.write(`OK  motor vxk ${versao} instalado: ${l.bin}\n\nDeclare o MCP no seu cliente (uma vez):\n  Claude Code:  ${saida.claude_code}\n  Codex:        ${saida.codex.replace(/\n/g, "\n                ")}\n`);
