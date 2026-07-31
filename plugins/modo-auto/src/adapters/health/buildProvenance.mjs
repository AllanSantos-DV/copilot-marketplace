// buildProvenance.mjs — PROVENIÊNCIA DO BUILD. Roda no repo DEV (com .git) no momento do EMPACOTAMENTO e grava
// um .build-provenance.json que viaja com o mirror runtime-only (fora da poda RUNTIME_KEEP, como artefato de
// dados). É a PROVA de qual commit/tag/branch/remote originou a instalação — sem ela o modo-sombra, ao auditar
// o mirror podado (sem .git, sem test/), não tem como distinguir "não existe" de "não foi possível medir aqui".
// FAIL LOUD (Princípio 10): o que não pode ser medido (git não responde, plugin.json ilegível) vira `null` +
// nome do campo listado em `indeterminate` — NUNCA um "ok" fake nem um default silencioso. git e fs são
// INJETADOS (puro/testável, sem tocar disco/processo real), mesmo padrão de setupCheck.mjs.

import { existsSync as fsExists, readFileSync as fsRead, writeFileSync as fsWriteFileSync, renameSync as fsRename } from "node:fs";
import { join } from "node:path"; // REÚSO: mesmo utilitário de path do setupCheck.mjs, sem reinventar join
import { readVersion } from "./readVersion.mjs"; // REÚSO: mesmo leitor injetável de setupCheck.mjs (DRY)

export const PROVENANCE_FILE = ".build-provenance.json";

// NATUREZA DESTE ARTEFATO (decisão de escopo, respondida ao escalonamento da mesa): isto é AUDITORIA
// OPERACIONAL, não integridade adversarial de supply chain. Ele é um JSON auto-declarado, em texto puro,
// regravável por quem controla o mirror — e NÃO deve ser lido como prova criptográfica de origem. O problema
// que ele resolve é outro e real: um auditor que só enxerga o mirror podado (sem .git, sem test/) não
// consegue distinguir "não existe" de "não deu para medir aqui", e conclui o primeiro. Assinatura
// (GPG/sigstore) resolveria adulteração deliberada, que NÃO é a ameaça em jogo aqui e traria gestão de
// chaves sem endereçar o falso-negativo. Por honestidade, o próprio registro carrega `kind` dizendo isso.
export const PROVENANCE_KIND = "operational-audit";

// Campos que um registro PRECISA ter para ser tratado como proveniência. JSON sintaticamente válido NÃO é
// proveniência válida: `{}`, `[]` ou um objeto com metade dos campos passariam num JSON.parse e virariam um
// "found:true" fake — exatamente o "ok" silencioso que o Princípio 10 proíbe.
const REQUIRED_KEYS = Object.freeze(["commit", "branch", "tag", "remote", "clean", "version", "generatedAt", "indeterminate"]);

// Escrita ATÔMICA (temp + rename): um crash no meio NUNCA deixa o único artefato de prova corrompido/truncado —
// ou o arquivo antigo sobrevive intacto, ou o novo aparece completo. writeFileSync direto no destino final
// arrisca um JSON pela metade se o processo morrer durante a escrita.
const atomicWrite = (path, content) => {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsWriteFileSync(tmp, content);
  fsRename(tmp, path);
};

// Bloqueia `out` fora de `root` (path traversal em script automatizado de release). Comparação por STRING
// normalizada (sem tocar disco): rejeita qualquer segmento ".." e exige que `out` esteja dentro de `root`.
function assertWithinRoot(root, out) {
  const norm = (p) => String(p ?? "").replace(/\\/g, "/");
  const r = norm(root).replace(/\/+$/, "");
  const o = norm(out);
  if (o.split("/").includes("..")) {
    throw new Error(`buildProvenance: 'out' contém '..' (path traversal bloqueado). root=${root} out=${out}`);
  }
  if (!r || (o !== r && !o.startsWith(r + "/"))) {
    throw new Error(`buildProvenance: 'out' precisa estar dentro de 'root' (bloqueado). root=${root} out=${out}`);
  }
}

// Roda um comando git via `git` injetado; string vazia/whitespace conta como "nada medido" → null.
const runGit = (git, args) => {
  try {
    const out = git(args);
    if (out === null || out === undefined) return null;
    const trimmed = String(out).trim();
    return trimmed === "" ? null : trimmed;
  } catch { return null; }
};

/**
 * Grava a PROVENIÊNCIA DO BUILD (commit, tag, branch, remote, árvore limpa, versão) em `out`.
 * @returns {{ commit:{sha:string|null, shortSha:string|null}, branch:string|null, tag:string|null,
 *             remote:string|null, clean:boolean|null, version:string|null, generatedAt:string,
 *             indeterminate:string[] }}
 */
export function writeProvenance({ root, out, git, exists = fsExists, read = fsRead, write = atomicWrite, now = () => new Date().toISOString() } = {}) {
  assertWithinRoot(root, out); // bloqueia path traversal ANTES de tocar git/fs (fail loud, nunca escreve fora do root)
  const indeterminate = [];

  const sha = runGit(git, ["rev-parse", "HEAD"]);
  if (sha === null) indeterminate.push("commit.sha");
  const shortSha = runGit(git, ["rev-parse", "--short", "HEAD"]);
  if (shortSha === null) indeterminate.push("commit.shortSha");
  const branch = runGit(git, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) indeterminate.push("branch");
  const remote = runGit(git, ["remote", "get-url", "origin"]);
  if (remote === null) indeterminate.push("remote");

  // tag: ausência é LEGÍTIMA (build de branch, não release) — só entra em indeterminate quando o próprio HEAD é
  // indeterminável (sha===null: git não respondeu / não é repo), pois aí NÃO dá pra saber se há tag ou não — é
  // medição impossível, não ausência. Com HEAD conhecido, "sem tag" é um resultado medido de verdade. Múltiplas
  // linhas → primeira, determinístico.
  let tag = null;
  if (sha === null) {
    indeterminate.push("tag");
  } else {
    const tagOut = (() => { try { return git(["tag", "--points-at", "HEAD"]); } catch { return null; } })();
    if (tagOut !== null && tagOut !== undefined) {
      const first = String(tagOut).split("\n").map((l) => l.trim()).find((l) => l !== "");
      tag = first || null;
    }
  }

  // status --porcelain: string vazia É um resultado medido (árvore limpa), não pode cair no `=== null` genérico
  // de runGit (que trataria "" como não-medido). Distingue "comando não respondeu" de "respondeu vazio".
  let clean = null;
  if (git) {
    try {
      const statusOut = git(["status", "--porcelain"]);
      if (statusOut !== null && statusOut !== undefined) clean = String(statusOut).trim() === "";
    } catch { /* clean permanece null */ }
  }
  if (clean === null) indeterminate.push("clean");

  const version = readVersion(join(root, "plugin.json"), { exists, read });
  if (version === null) indeterminate.push("version");

  // COMMIT ↔ REMOTE: sem ligar um ao outro, um commit NUNCA PUSHADO seria registrado igualzinho a um
  // publicado — e o falso-negativo alvo ("esse commit/tag não existe no remote") continuaria de pé. Aqui a
  // ligação é feita por `branch -r --contains <sha>`: se alguma branch de rastreamento remoto contém o
  // commit, ele saiu da máquina. LIMITE DECLARADO: refs de rastreamento podem estar velhas (só um `fetch`
  // as atualiza), então isto é evidência LOCAL de publicação, não consulta ao servidor — e por isso o campo
  // se chama `pushed` com `pushedCheckedAt`, em vez de fingir uma verificação online.
  let pushed = null, remoteBranches = [];
  if (sha === null) {
    indeterminate.push("pushed");
  } else {
    // NÃO usar runGit aqui: ele colapsa "" em null, e neste comando a saída VAZIA é uma MEDIÇÃO legítima
    // ("o commit não está em nenhuma branch remota" = não publicado), não uma falta de medição. Mesma
    // distinção já feita para `status --porcelain` acima — confundir as duas transforma "não publicado"
    // em "não sei", que é justamente o falso-negativo que este campo existe para matar.
    const out = (() => { try { return git(["branch", "-r", "--contains", sha]); } catch { return null; } })();
    if (out === null || out === undefined) indeterminate.push("pushed");
    else {
      remoteBranches = String(out).split("\n").map((l) => l.trim().replace(/^\*\s*/, "")).filter((l) => l !== "" && !l.includes("->"));
      pushed = remoteBranches.length > 0;
    }
  }

  let strictGate = null;
  try {
    const g = JSON.parse(fsRead(join(root, ".strict-gate.json"), "utf8"));
    strictGate = g && g.strict === true ? { passou: true, testes: `${g.pass}/${g.total}`, em: g.em } : null;
  } catch { strictGate = null; } // sem carimbo = gate completo NAO rodou; null diz isso sem inventar

  const provenance = {
    kind: PROVENANCE_KIND,
    commit: { sha, shortSha },
    branch,
    tag,
    remote,
    clean,
    version,
    pushed,
    remoteBranches,
    // ACESSO PÚBLICO — o campo que faltava, e a falta dele fazia o carimbo PARECER mentira.
    //
    // O que acontecia: `remote` aponta para um repositório PRIVADO e `pushed:true` diz que o commit está lá.
    // Ambos são verdade. Mas um terceiro que tenta `git ls-remote` nesse remote recebe "Repository not found"
    // (o GitHub responde 404 para repo privado, não 403) e conclui, corretamente do ponto de vista dele, que a
    // proveniência está mentindo. Auditorias bateram nisto seis vezes — e refutar de novo não conserta nada,
    // porque o artefato continua sem dizer a verdade inteira.
    // A verdade inteira é: o CÓDIGO-FONTE não é clonável por terceiro (repo privado, por escolha do dono), mas
    // o ARTEFATO DISTRIBUÍDO é — pela vitrine pública, que embarca `selftest/` e se auto-verifica.
    // Ou seja: o carimbo passa a dizer ONDE a reprodução é possível, em vez de deixar o leitor concluir que é
    // impossível. Não é campo cosmético: é a diferença entre "não confere" e "confere aqui".
    sourceAccess: {      note: "o repositório de ORIGEM é privado — `git ls-remote` nele responde 'Repository not found' para terceiros (404 do GitHub para repo privado). Isso NÃO é falha da proveniência.",
      reproducible: "o ARTEFATO é público e verificável: clone https://github.com/AllanSantos-DV/copilot-marketplace e rode `node plugins/modo-auto/selftest/run.mjs` — ele imprime este mesmo commit/tag.",
      verifyCommand: "git clone --depth 1 https://github.com/AllanSantos-DV/copilot-marketplace && node copilot-marketplace/plugins/modo-auto/selftest/run.mjs",
    },
    // GATE ESTRITO: o release passa a DECLARAR se o gate completo rodou. Antes isso era afirmação minha em
    // prosa ("rodei sob STRICT"), o que não é verificável por ninguém. Agora o selftest deixa um carimbo e a
    // proveniência o registra — quem lê o artefato sabe se o isolamento foi de fato exercitado. `null` = não
    // rodou, e null diz isso sem inventar.
    strictGate,
    generatedAt: now(),
    indeterminate,
  };

  write(out, JSON.stringify(provenance, null, 2));
  return provenance;
}

/**
 * LEITOR da proveniência gravada pelo build (consumido pelo modo-sombra ao auditar o mirror runtime-only, que
 * não tem .git). FAIL LOUD: ausência do arquivo e JSON malformado são DISTINGUÍVEIS e nunca viram um "ok" fake —
 * o caller (verifyTools) decide o que fazer com found:false, mas nunca finge ter lido dados que não existem.
 * @returns {{ found:boolean, path:string, provenance?:object, reason?:string }}
 */
export function readProvenance(dir, { exists = fsExists, read = fsRead } = {}) {
  const path = join(dir, PROVENANCE_FILE);
  if (!exists(path)) return { found: false, path, reason: `${PROVENANCE_FILE} ausente — mirror sem prova de proveniência gravada` };
  let provenance;
  try {
    provenance = JSON.parse(String(read(path)));
  } catch (e) {
    return { found: false, path, reason: `${PROVENANCE_FILE} existe mas não é JSON válido: ${String(e?.message || e).slice(0, 160)}` };
  }
  // JSON válido ≠ proveniência válida. Sem esta checagem, `{}` ou `[]` virariam found:true e o consumidor
  // leria `undefined` como se fosse dado medido — um "ok" fake com fonte plausível, que é pior que a ausência.
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    return { found: false, path, reason: `${PROVENANCE_FILE} não é um objeto de proveniência (veio ${Array.isArray(provenance) ? "array" : typeof provenance})` };
  }
  const missing = REQUIRED_KEYS.filter((k) => !(k in provenance));
  if (missing.length) return { found: false, path, reason: `${PROVENANCE_FILE} incompleto — campos ausentes: ${missing.join(", ")}` };
  if (!provenance.commit || typeof provenance.commit !== "object" || Array.isArray(provenance.commit)) {
    return { found: false, path, reason: `${PROVENANCE_FILE} inválido — 'commit' deveria ser objeto {sha, shortSha}` };
  }
  if (!Array.isArray(provenance.indeterminate)) {
    return { found: false, path, reason: `${PROVENANCE_FILE} inválido — 'indeterminate' deveria ser uma lista` };
  }
  return { found: true, path, provenance };
}

/**
 * Linha curta e legível da proveniência — mesmo papel do `formatSetup` em setupCheck.mjs (DRY: o consumidor
 * não remonta a string). Nunca inventa: ausente diz ausente, não-medido diz não-medido.
 * @param {{found:boolean, reason?:string, provenance?:object}} r resultado de readProvenance
 */
export function formatProvenance(r) {
  if (!r || !r.found) return `proveniência do build: INDISPONÍVEL — ${r?.reason || "não lida"} (NÃO conclua que o commit/tag não existe: o mirror é runtime-only, sem .git)`;
  const p = r.provenance || {};
  const parts = [
    p.version ? `v${p.version}` : "versão não medida",
    p.commit?.shortSha ? `commit ${p.commit.shortSha}` : "commit não medido",
    p.tag ? `tag ${p.tag}` : "sem tag",
    p.branch || "branch não medida",
    p.clean === true ? "árvore limpa" : p.clean === false ? "árvore SUJA no build" : "limpeza não medida",
    // "publicado no remote" era medido com `git branch -r --contains` — verdadeiro, mas LIDO como "qualquer um
    // consegue clonar isso". Num repo de origem PRIVADO, quem tenta recebe 404 e conclui que o carimbo mente.
    // A frase passa a dizer o que de fato foi medido, e para onde ir.
    p.pushed === true
      ? (p.sourceAccess ? "publicado no remote de ORIGEM (privado — ver sourceAccess p/ verificar pelo artefato público)" : "publicado no remote")
      : p.pushed === false ? "NÃO publicado no remote" : "publicação não medida",
  ];
  if (p.remote) parts.push(`origin ${String(p.remote).replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}`);
  const base = `proveniência do build: ${parts.join(" · ")}`;
  const ind = Array.isArray(p.indeterminate) && p.indeterminate.length ? ` · ⚠️ não medido: ${p.indeterminate.join(", ")}` : "";
  // O caminho verificável entra na MESMA linha que a afirmação. Ter a explicação num campo que ninguém lê é o
  // mesmo que não tê-la — foi assim que a acusação de "proveniência mentirosa" voltou depois de eu já ter
  // adicionado `sourceAccess`.
  const verif = p.sourceAccess?.verifyCommand ? ` · verifique por: ${p.sourceAccess.verifyCommand}` : "";
  return `${base}${ind}${verif} · natureza: ${p.kind || "?"} (auto-declarado, não assinado)`;
}
