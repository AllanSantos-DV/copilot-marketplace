// verifyTools.mjs — as "mãos" do shadow-verifier: TOOLS CUSTOM read-only, determinísticas e SEGURAS (sem shell
// arbitrário; execFileSync com subcomando git FIXO + args; fs só leitura). É o que permite o sombra CONFIRMAR a
// realidade em vez de fabricar (a reforma que o dono pediu). Todas LOCAIS (sem rede/auth) → determinísticas e
// seguras num agente de background. Cada handler devolve JSON string {..., ok?} — nunca lança pro modelo.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { readProvenance } from "../health/buildProvenance.mjs"; // REÚSO: mesmo leitor usado no build (DRY)

const GIT_ENV = () => ({ ...process.env, GIT_CONFIG_PARAMETERS: "" }); // neutraliza injeção helper=copilot (conta pessoal)
function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV(), timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
const full = (repo, rel) => (isAbsolute(rel) ? rel : join(repo, rel));

// Resolve a RAIZ do repo git a partir de um cwd. null se cwd NÃO está num repo (ex.: a extensão rodando de um dir
// que não é o projeto) → o caller SINALIZA e degrada, em vez de rodar git contra um path errado e gerar falso "sem
// história / não-versionado". É a defesa contra o bug de cwd que produzia contestações falsas em loop.
//
// TAMBÉM devolve null para o caso VIZINHO e mais traiçoeiro: cwd é um artefato ALHEIO ANINHADO dentro de um repo
// que não é o seu. O git SOBE na árvore, então `--show-toplevel` responde com sucesso o repo DE CIMA — e aí a
// verificação roda contra ele e conclui, corretamente para o repo errado, que tudo é "untracked / sem história".
// MEDIDO nesta máquina: `~/.copilot` É um repo git (36 commits) e a instalação do modo-auto vive dentro dele como
// arquivo não-versionado; auditar de lá produzia exatamente o falso "git traceability inexistente" que reaparecia
// em loop. O sinal que separa os dois casos é determinístico: uma pasta LEGÍTIMA do repo tem arquivos rastreados
// (medido: 289 na raiz, 108 numa subpasta), um artefato alheio tem ZERO. Repo real mas errado é pior que repo
// nenhum — o primeiro responde com confiança uma pergunta que não é a sua.
export function resolveRepoRoot(cwd) {
  const dir = String(cwd || ".");
  let top;
  try { top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: GIT_ENV(), timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
  if (!top) return null;
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (norm(top) === norm(dir)) return top; // cwd É a raiz: nada a suspeitar
  try {
    const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8", env: GIT_ENV(), timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    return tracked.trim() ? top : null; // zero rastreados aqui = artefato alheio aninhado, não subpasta do repo
  } catch { return null; }
}

// ÂNCORA dos handlers de git. Ter o `resolveRepoRoot` não bastava: os handlers rodavam `git -C <alvo>` DIRETO,
// e como o git SOBE na árvore, um alvo que é artefato aninhado (mirror/instalação dentro de `~/.copilot`, que É
// um repo) era auditado contra o repo DE CIMA — devolvendo `tracked:false` e `count:0` com toda a confiança.
// MEDIDO no runtime v0.2.96: `resolveRepoRoot(mirror)` já respondia `null`, mas `git_tracked(findingsTracker.mjs)`
// ainda dizia `tracked:false`. O resolver existia e ninguém o consultava — resolver que não é usado é decoração.
// Agora TODO handler de git passa por aqui: ou existe repo VÁLIDO (o alvo pertence a ele), ou o resultado é
// `null` + `error` explicando. Nunca "false/0 calado", que é o formato exato dos falsos "não versionado / sem
// história" que este verificador existe para matar.
function anchor(repo) {
  const root = resolveRepoRoot(repo);
  if (root) return { root };
  return { root: null, error: `alvo não pertence a nenhum repo git válido (${repo}) — é artefato fora de repo ou aninhado num repositório ALHEIO; auditar o repo de cima produziria falso "não versionado/sem história"` };
}

// Cada tool: read-only, args fixos. O modelo escolhe qual chamar p/ checar a alegação.
export const verifyTools = [
  {
    name: "path_exists",
    description: "Read-only: o caminho relativo existe no repo? JSON {exists, checked, kind}.",
    parameters: { type: "object", properties: { repo: { type: "string" }, relpath: { type: "string" } }, required: ["repo", "relpath"] },
    handler: (a) => { const p = full(String(a?.repo || ""), String(a?.relpath || "")); const exists = existsSync(p); let kind = null; try { if (exists) kind = statSync(p).isDirectory() ? "dir" : "file"; } catch { /* ignore */ } return JSON.stringify({ exists, checked: p, kind }); },
  },
  {
    name: "git_tracked",
    description: "Read-only: o arquivo está VERSIONADO no git (tracked)? JSON {tracked, relpath}.",
    parameters: { type: "object", properties: { repo: { type: "string" }, relpath: { type: "string" } }, required: ["repo", "relpath"] },
    handler: (a) => {
      const rel = String(a?.relpath || "");
      const { root, error } = anchor(String(a?.repo || ""));
      if (!root) return JSON.stringify({ tracked: null, relpath: rel, error });
      try { git(root, ["ls-files", "--error-unmatch", "--", rel]); return JSON.stringify({ tracked: true, relpath: rel, repo: root }); }
      catch (e) { if (e?.status === 1) return JSON.stringify({ tracked: false, relpath: rel, repo: root }); return JSON.stringify({ tracked: null, relpath: rel, error: `git indisponível: ${String(e?.message || e).slice(0, 120)}` }); }
    },
  },
  {
    name: "git_grep",
    description: "Read-only: busca um padrão (string literal) nos arquivos do WORKING TREE — versionados E não-versionados (respeita .gitignore). JSON {matches:[{file,line,text}], count}. Prova se um símbolo/import/texto existe AGORA no código, inclusive em trabalho ainda não commitado.",
    parameters: { type: "object", properties: { repo: { type: "string" }, pattern: { type: "string" }, path: { type: "string", description: "opcional: limitar a um subpath" } }, required: ["repo", "pattern"] },
    handler: (a) => {
      const pat = String(a?.pattern || ""); const path = a?.path ? String(a.path) : null;
      const { root, error } = anchor(String(a?.repo || ""));
      if (!root) return JSON.stringify({ matches: null, count: null, error });
      try { const out = git(root, ["grep", "-n", "-F", "--untracked", "-e", pat, ...(path ? ["--", path] : [])]);
        const matches = out ? out.split(/\r?\n/).slice(0, 50).map((l) => { const m = l.match(/^([^:]+):(\d+):(.*)$/); return m ? { file: m[1], line: +m[2], text: m[3].slice(0, 200) } : { file: null, line: null, text: l.slice(0, 200) }; }) : [];
        return JSON.stringify({ matches, count: matches.length, repo: root });
      } catch (e) { const st = e?.status; if (st === 1) return JSON.stringify({ matches: [], count: 0, repo: root }); return JSON.stringify({ matches: null, count: null, error: `git indisponível: ${String(e?.message || e).slice(0, 140)}` }); }
    },
  },
  {
    name: "git_log_grep",
    description: "Read-only: procura commits cuja MENSAGEM casa o padrão. JSON {commits:[{sha,subject}], count}. Prova se algo 'foi commitado'.",
    parameters: { type: "object", properties: { repo: { type: "string" }, pattern: { type: "string" } }, required: ["repo", "pattern"] },
    handler: (a) => {
      const pat = String(a?.pattern || "");
      const { root, error } = anchor(String(a?.repo || ""));
      if (!root) return JSON.stringify({ commits: null, count: null, error });
      try { const out = git(root, ["log", "--oneline", "-n", "20", "--grep", pat, "-i"]); const commits = out ? out.split(/\r?\n/).map((l) => { const m = l.match(/^(\w+)\s+(.*)$/); return m ? { sha: m[1], subject: m[2].slice(0, 160) } : { sha: null, subject: l.slice(0, 160) }; }) : []; return JSON.stringify({ commits, count: commits.length, repo: root }); }
      catch (e) { return JSON.stringify({ commits: null, count: null, error: `git indisponível: ${String(e?.message || e).slice(0, 140)}` }); }
    },
  },
  {
    name: "file_contains",
    description: "Read-only: o arquivo contém a substring (literal)? JSON {contains, relpath, exists}. Para 'X ainda importa Y' / 'não tem Z no arquivo'.",
    parameters: { type: "object", properties: { repo: { type: "string" }, relpath: { type: "string" }, needle: { type: "string" } }, required: ["repo", "relpath", "needle"] },
    handler: (a) => { const p = full(String(a?.repo || ""), String(a?.relpath || "")); const needle = String(a?.needle || ""); if (!existsSync(p)) return JSON.stringify({ exists: false, contains: false, relpath: a?.relpath }); try { const txt = readFileSync(p, "utf8"); return JSON.stringify({ exists: true, contains: txt.includes(needle), relpath: a?.relpath }); } catch (e) { return JSON.stringify({ exists: true, contains: false, error: String(e?.message || e).slice(0, 160) }); } },
  },
  {
    name: "read_build_provenance",
    description: "Read-only: lê '.build-provenance.json' (gravado no EMPACOTAMENTO pelo repo dev) na raiz de `repo`. É a PROVA de commit/tag/branch/remote/versão de um mirror runtime-only SEM .git — use esta tool ANTES de concluir 'sem remote'/'commit não existe'/'sem tag' num mirror podado; um 'não medido' no campo `indeterminate` do JSON é diferente de 'não existe'. JSON {found, provenance?, reason?}.",
    parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
    handler: (a) => JSON.stringify(readProvenance(String(a?.repo || ""))),
  },
];

export const VERIFY_TOOL_NAMES = verifyTools.map((t) => t.name);
