// Instalador do gate global do copilot-marketplace (rode uma vez por máquina).
//
//   node docs/install-gate.mjs           -> instala o hook global e liga o core.hooksPath
//   node docs/install-gate.mjs --status  -> só mostra o estado atual
//   node docs/install-gate.mjs --uninstall
//
// Copia `docs/githooks/{pre-push,dispatch.mjs}` para `~/.copilot/githooks/` e aponta o
// `git config --global core.hooksPath` para lá. O hook roda em todos os repos, mas só
// age no copilot-marketplace (o dispatcher é transparente fora dele). Node puro.
import { copyFileSync, mkdirSync, existsSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "githooks");
const DEST = join(homedir(), ".copilot", "githooks");
const FILES = ["pre-push", "dispatch.mjs"];

const gitGlobal = (args) => {
  try {
    return execFileSync("git", ["config", "--global", ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const currentHooksPath = () => gitGlobal(["--get", "core.hooksPath"]);

function status() {
  const hp = currentHooksPath();
  console.log("gate global:");
  console.log(`  core.hooksPath (global): ${hp || "(não setado)"}`);
  console.log(`  destino do hook:         ${DEST}`);
  console.log(`  instalado:               ${FILES.every((f) => existsSync(join(DEST, f))) ? "sim" : "não"}`);
  if (hp && hp !== DEST) console.log("  ⚠ core.hooksPath aponta para outro lugar — veja as instruções abaixo.");
}

if (process.argv.includes("--status")) {
  status();
  process.exit(0);
}

if (process.argv.includes("--uninstall")) {
  if (currentHooksPath() === DEST) {
    execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"]);
    console.log("gate: core.hooksPath global removido.");
  }
  try {
    rmSync(DEST, { recursive: true, force: true });
  } catch {}
  console.log("gate: hook global desinstalado.");
  process.exit(0);
}

// ---- instalar ----
mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(SRC, f), join(DEST, f));
  if (platform() !== "win32") {
    try {
      chmodSync(join(DEST, f), 0o755);
    } catch {}
  }
}
console.log(`gate: hooks copiados para ${DEST}`);

const hp = currentHooksPath();
if (!hp) {
  execFileSync("git", ["config", "--global", "core.hooksPath", DEST]);
  console.log(`gate: core.hooksPath global -> ${DEST}`);
  console.log("gate: pronto. O push neste repo agora exige a página revisada.");
} else if (hp === DEST) {
  console.log("gate: core.hooksPath já apontava para cá — ok.");
} else {
  console.error(`\ngate: ⚠ core.hooksPath global já está em:\n    ${hp}`);
  console.error("Não sobrescrevi para não quebrar seus outros hooks. Duas opções:");
  console.error(`  1) Mova o conteúdo de ${DEST} para ${hp} (mantendo os dois arquivos).`);
  console.error(`  2) Se puder, aponte o global para cá:  git config --global core.hooksPath "${DEST}"`);
  process.exit(1);
}
