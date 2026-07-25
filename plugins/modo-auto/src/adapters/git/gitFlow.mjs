// Política GIT-FLOW (dados + helpers PUROS) — as regras de "equipe de dev real" que o orquestrador git
// vai aplicar. Fluxo: main (produção) ← staging ← develop (integração; smoke roda aqui) ← feature/* | fix/*.
// Commits semânticos (Conventional Commits). FAIL LOUD: tipo de branch/commit inválido ou nome vazio → LANÇA.

export const GITFLOW = {
  production: "main",
  staging: "staging",
  integration: "develop", // braços paralelos integram aqui
  smokeBranch: "develop", // o smoke da pipeline roda na branch de integração
  branchTypes: { feature: "feature/", fix: "fix/", refactor: "refactor/", chore: "chore/", docs: "docs/" },
  mergeOrder: ["feature/* | fix/* → develop", "develop → staging", "staging → main"],
};

const COMMIT_TYPES = new Set(["feat", "fix", "refactor", "chore", "docs", "test", "perf", "build", "ci", "style", "revert"]);

// slug seguro p/ branch (sem acento, kebab-case, curto).
function slug(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 48).replace(/-+$/g, "");
}

// Nome de branch p/ um tipo git-flow + descrição da fase/tarefa. Ex.: branchFor("feature","Fase 2: API") → "feature/fase-2-api".
export function branchFor(type, name) {
  const prefix = GITFLOW.branchTypes[type];
  if (!prefix) throw new Error(`gitFlow: tipo de branch desconhecido "${type}" (use ${Object.keys(GITFLOW.branchTypes).join("/")})`);
  const s = slug(name);
  if (!s) throw new Error("gitFlow: nome de branch vazio após slug — dê um nome descritivo");
  return prefix + s;
}

// Mensagem de commit semântica. Ex.: commitMessage("feat","adiciona fatiador",{scope:"pipeline"}) → "feat(pipeline): adiciona fatiador".
export function commitMessage(type, subject, { scope, body } = {}) {
  const t = String(type || "").trim();
  if (!COMMIT_TYPES.has(t)) throw new Error(`gitFlow: tipo de commit inválido "${t}" (use ${[...COMMIT_TYPES].join("/")})`);
  const s = String(subject || "").trim();
  if (!s) throw new Error("gitFlow: subject do commit vazio");
  const head = `${t}${scope ? `(${slug(scope)})` : ""}: ${s}`;
  return body ? `${head}\n\n${String(body).trim()}` : head;
}
