// tools/sync-boot.mjs — UMA fonte para o bootstrap, cópia verificada nos consumidores.
//
// O problema medido (2026-07-30): cinco plugins carregavam `boot.mjs` com conteúdo IDÊNTICO
// (hash normalizado `5040E81B76F4`). Não era backup morto — cada um roda no `SessionStart`, então
// eram cinco execuções do mesmo código e, pior, **cinco lugares para corrigir** quando o
// bootstrap mudasse. É assim que uma correção chega em quatro plugins e esquece o quinto.
//
// Por que não simplesmente apagar as cópias: o runtime EXIGE o arquivo dentro da pasta do plugin
// (o dispatcher roda `boot.mjs` relativo a ela) e existe o problema do ovo e da galinha — quem
// instala só o `action-bridge`, sem o `canvas-sync`, precisa de alguém que baixe o espelhador.
// A cópia é requisito do modelo de distribuição, não escolha preguiçosa.
//
// Então a solução não é eliminar a cópia — é eliminar a DIVERGÊNCIA: uma fonte canônica
// (`plugins/canvas-sync/boot.mjs`, do dono do bootstrap) e uma verificação que falha alto quando
// alguma cópia sai de sincronia. Vendored-with-verification, o mesmo padrão já aplicado ao
// `sync.mjs` dentro do mcp-bridge.
//
//   node tools/sync-boot.mjs            # verifica (exit 1 se divergir)
//   node tools/sync-boot.mjs --fix      # ressincroniza a partir da fonte
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = join(ROOT, "plugins");
const CANON = join(PLUGINS, "canvas-sync", "boot.mjs");
const fix = process.argv.includes("--fix");

/**
 * Plugins com bootstrap PRÓPRIO — não são divergência, são decisão registrada. Sincronizar estes
 * quebraria o requisito que cada um documenta no próprio arquivo.
 */
const PROPRIOS = {
  "mcp-bridge": "bootstrap SEM REDE (requisito enterprise): roda o sync.mjs vendorizado, não baixa nada",
  "modo-auto": "bootstrap próprio, com lógica adicional do produto",
  "visual-explainer": "bootstrap próprio, menor: não usa o fluxo completo do canvas-sync",
};

// Normaliza fim de linha e BOM: comparar bytes crus acusaria divergência onde só há o
// `.gitattributes` fazendo o trabalho dele — foi exatamente esse erro que escondeu a 5ª cópia.
const norm = (s) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const hash = (s) => createHash("sha256").update(norm(s), "utf8").digest("hex").slice(0, 12);

if (!existsSync(CANON)) {
  console.log(`FALHA: fonte canônica ausente — ${CANON}`);
  process.exit(1);
}
const canonTexto = readFileSync(CANON, "utf8");
const canonHash = hash(canonTexto);

console.log("== bootstrap: uma fonte, cópias verificadas ==");
console.log(`  fonte: plugins/canvas-sync/boot.mjs (${canonHash})\n`);

let divergentes = 0;
let sincronizados = 0;

for (const nome of readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  if (nome === "canvas-sync") { continue; }
  const alvo = join(PLUGINS, nome, "boot.mjs");
  if (!existsSync(alvo)) { continue; }

  if (PROPRIOS[nome]) {
    console.log(`  --   ${nome.padEnd(18)} bootstrap próprio — ${PROPRIOS[nome]}`);
    continue;
  }

  const atual = readFileSync(alvo, "utf8");
  if (hash(atual) === canonHash) {
    console.log(`  OK   ${nome.padEnd(18)} em sincronia`);
    continue;
  }

  if (fix) {
    writeFileSync(alvo, canonTexto);
    console.log(`  FIX  ${nome.padEnd(18)} ressincronizado (${hash(atual)} → ${canonHash})`);
    sincronizados++;
  } else {
    console.log(`  !!   ${nome.padEnd(18)} DIVERGE da fonte (${hash(atual)} ≠ ${canonHash})`);
    divergentes++;
  }
}

if (divergentes) {
  console.log(`\n${divergentes} cópia(s) fora de sincronia.`);
  console.log("Corrija com: node tools/sync-boot.mjs --fix   (ou registre o bootstrap como PRÓPRIO em tools/sync-boot.mjs)");
  process.exit(1);
}
console.log(sincronizados ? `\n${sincronizados} cópia(s) ressincronizada(s).` : "\nTUDO EM SINCRONIA");
process.exit(0);
