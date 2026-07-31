// selftest/run.mjs — CONTRATO verificável NO ARTEFATO INSTALADO.
//
// Por que existe: a suíte completa (538 KB, 100+ arquivos) NÃO viaja no pacote — ele é runtime-only e é copiado
// para a pasta de extensões de TODA sessão. Só que "os testes rodam no repo, confie em mim" não é verificável, e
// auditoria após auditoria apontou — com razão — que o verde alegado era sobre código que não é o deployado.
//
// A saída não é "incluir tudo" nem "não incluir nada": viaja o subconjunto de CONTRATO — os testes que provam que
// o artefato INSTALADO se comporta como promete (isolamento de escopo da memória, piso do SDK do worker, âncora do
// verificador git, proveniência, contexto de telemetria). São ~69 KB contra 538 KB, e rodam contra ESTES bytes.
//
// Uso: `npm run selftest` (ou `node selftest/run.mjs`) de dentro da instalação.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// Os testes LIVE (daemon/SDK) dão SKIP SINALIZADO quando o serviço não está no ar — nunca verde falso.
//
// MAS "não verde falso" não é o bastante para um GATE DE RELEASE: com o daemon fora, os smokes que provam o
// isolamento entre projetos dão skip e o gate fecha VERDE sem ter exercitado a garantia mais importante do
// produto. Medido: 12/12 offline, 11/12 sob STRICT — o release passava sem provar isolamento.
// Por isso o runner AVISA quando está rodando permissivo e diz como exigir o gate completo. Quem publica tem
// que rodar com `MODO_AUTO_STRICT=1`; quem só instalou o artefato (e legitimamente não tem daemon) roda sem.
const STRICT = process.env.MODO_AUTO_STRICT === "1";
const files = readdirSync(HERE).filter((f) => f.endsWith("-smoke.mjs")).sort();

if (!files.length) {
  console.error("selftest: nenhum teste de contrato encontrado em " + HERE + " — o pacote foi montado errado.");
  process.exit(1);
}

let pass = 0; const fail = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(HERE, f)], { cwd: ROOT, encoding: "utf8", timeout: 180000 });
  if (r.status === 0) { pass++; console.log("ok:", f); }
  else { fail.push(f); console.log("FAIL:", f, "\n" + ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter(Boolean).slice(-4).join("\n")); }
}

let prov = " · (sem carimbo de proveniência neste artefato)";
try {
  const p = JSON.parse(readFileSync(join(ROOT, ".build-provenance.json"), "utf8"));
  prov = ` · artefato v${p.version || "?"} commit ${p.commit?.shortSha || "?"}${p.tag ? " tag " + p.tag : ""}`;
} catch { /* sem carimbo: a linha acima já diz isso */ }

console.log(`\nselftest do ARTEFATO INSTALADO: ${pass}/${files.length} OK${fail.length ? `\nFALHAS: ${fail.join(", ")}` : ""}${prov}`);
console.log("(subconjunto de CONTRATO — a suíte completa vive no repositório de origem; estes provam que ESTES bytes se comportam como prometido)");
if (!STRICT) {
  // Dizer que o verde é PARCIAL faz parte do verde. Sem esta linha, quem publica lê "12/12 OK" e conclui que o
  // isolamento entre projetos foi provado — quando ele pode nem ter sido exercitado.
  console.log("⚠️ modo PERMISSIVO: testes que dependem do daemon/SDK dão SKIP e contam como ok. Para o gate COMPLETO (exigido antes de publicar), rode com MODO_AUTO_STRICT=1 — ali skip vira FALHA e o isolamento entre projetos é de fato exercitado.");
} else if (!fail.length) {
  // CARIMBO DO GATE COMPLETO. "Rodei sob STRICT" era afirmação minha em prosa; agora vira um arquivo que o
  // release lê e grava na proveniência. Disciplina externa que ninguém verifica não é gate — é intenção.
  try {
    writeFileSync(join(ROOT, ".strict-gate.json"), JSON.stringify({ strict: true, pass, total: files.length, em: new Date().toISOString() }, null, 2));
    console.log("✅ gate COMPLETO (STRICT) — carimbo gravado em .strict-gate.json; o release vai registrá-lo na proveniência.");
  } catch { /* sem permissão de escrita: o verde acima continua válido, só não fica carimbado */ }
}
process.exit(fail.length ? 1 : 0);
