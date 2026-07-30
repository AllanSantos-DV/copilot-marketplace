// run-tests.mjs — ponto de entrada do `npm test`.
//
// Por que existe: o pacote publicado é RUNTIME-ONLY por design (o `test/` não viaja — são 538 KB contra 254 KB
// de runtime, e ele é copiado para a pasta de extensões de toda sessão). Só que `"test": "node test/run-all.mjs"`
// num pacote sem `test/` explodia com `ERR_MODULE_NOT_FOUND`, uma mensagem que não diz NADA — e auditoria após
// auditoria concluiu "a suíte não existe / a alegação 100/100 é irreprodutível". A ausência era real; o que
// faltava era ela ser LEGÍVEL.
//
// FAIL LOUD, não fail silent: quando a suíte não está aqui, isto NÃO finge sucesso (sai com código 1). Ele diz
// onde a suíte vive e devolve o COMANDO EXATO para reproduzir, ancorado no commit gravado no carimbo de
// proveniência — ou seja, a reprodução aponta para o código EXATO que gerou este artefato, não para "a última
// versão do repo", que poderia ser outra coisa.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = join(ROOT, "test", "run-all.mjs");

if (existsSync(SUITE)) {
  const r = spawnSync(process.execPath, [SUITE], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

// Sem suíte: explica QUAL artefato é este e como reproduzir a partir dele.
let commit = null, tag = null, remote = null, version = null;
try {
  const p = JSON.parse(readFileSync(join(ROOT, ".build-provenance.json"), "utf8"));
  commit = p?.commit?.sha || null; tag = p?.tag || null; remote = p?.remote || null; version = p?.version || null;
} catch { /* sem carimbo: seguimos com o que dá para afirmar */ }

const repo = remote || "https://github.com/AllanSantos-DV/modo-auto.git";
const ref = commit || tag || null;

console.error(
  `modo-auto — a SUÍTE NÃO ESTÁ NESTE ARTEFATO, e isso é POR DESIGN.\n` +
  `Este é o pacote RUNTIME-ONLY${version ? ` (v${version})` : ""}: ele carrega só o que executa. O \`test/\` fica no repositório\n` +
  `de origem porque é maior que o próprio runtime e seria copiado para a pasta de extensões de toda sessão.\n` +
  `\n` +
  `ISTO NÃO SIGNIFICA QUE A SUÍTE NÃO EXISTE — significa que ela não está AQUI. Para reproduzi-la no código\n` +
  `EXATO que gerou este artefato:\n` +
  `\n` +
  `  git clone ${repo} modo-auto && cd modo-auto\n` +
  (ref ? `  git checkout ${ref}${tag && commit ? `   # (${tag})` : ""}\n` : `  # (sem carimbo de proveniência aqui: use a tag correspondente à versão instalada)\n`) +
  `  npm test\n` +
  `\n` +
  (ref
    ? `A referência acima vem do carimbo .build-provenance.json deste pacote, então ela aponta para o commit que\n` +
      `originou ESTES bytes — não para "a versão mais recente", que pode ser outra coisa.\n`
    : `Sem o carimbo de proveniência não dá para afirmar QUAL commit gerou estes bytes; rode \`modo_setup\` para ver\n` +
      `o que o runtime consegue provar sobre a própria origem.\n`),
);
process.exit(1);
