// Leitura do .memory/project.json — a convenção de escopo declarado do ecossistema (espelha
// ProjectConfig.java do native-java). O plugin passa a HONRAR o project_id e os metadata.defaults/
// branches declarados, em vez de só derivar do git/path. Sem o arquivo → null (cai na escada do git).
//
// Schema (campos usados; forward-compat ignora o resto):
//   { "version", "project": {name,client,team}, "server": {url,workspace},
//     "metadata": { "defaults": {project_id, ...}, "branches": { "glob": {..} } },
//     "user": { "identifyBy": "os-username|git-email|manual", "name" } }
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function projectConfigPath(workspacePath) {
    return join(String(workspacePath || "."), ".memory", "project.json");
}

// Carrega e faz parse TOLERANTE. Ausente/corrompido → null (nunca lança).
export function loadProjectConfig(workspacePath) {
    try {
        const p = projectConfigPath(workspacePath);
        if (!existsSync(p)) return null;
        const raw = readFileSync(p, "utf8");
        if (!raw || !raw.trim()) return null;
        const cfg = JSON.parse(raw);
        return cfg && typeof cfg === "object" ? cfg : null;
    } catch {
        return null;
    }
}

// Extrai o project_id DECLARADO (metadata.defaults.project_id). null se ausente.
export function declaredProjectId(cfg) {
    const v = cfg && cfg.metadata && cfg.metadata.defaults && cfg.metadata.defaults.project_id;
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

function gitBranch(workspacePath) {
    try {
        const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000, windowsHide: true,
        });
        const s = String(out).trim();
        return s && s !== "HEAD" ? s : null;
    } catch {
        return null;
    }
}

// Casa o branch atual contra os padrões glob de metadata.branches (exato primeiro, depois glob simples).
// Espelha matchBranchMetadata do ProjectConfig.java (glob básico: * = qualquer sufixo).
function matchBranchMeta(cfg, workspacePath) {
    const branches = cfg && cfg.metadata && cfg.metadata.branches;
    if (!branches || typeof branches !== "object") return null;
    const branch = gitBranch(workspacePath);
    if (!branch) return null;
    if (branches[branch] && typeof branches[branch] === "object") return branches[branch];
    for (const [pattern, meta] of Object.entries(branches)) {
        if (meta && typeof meta === "object" && globMatch(pattern, branch)) return meta;
    }
    return null;
}

// glob simples: converte * → .*, ? → ., ancorado. Suficiente p/ "feat/*", "release/*", etc.
function globMatch(pattern, value) {
    try {
        const re = new RegExp("^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        return re.test(value);
    } catch {
        return false;
    }
}

// Metadata a carimbar em toda escrita/busca a partir do project.json (paridade REST com o
// mergeMetadata do servidor: defaults + branch; o metadata do CHAMADOR tem prioridade e é
// aplicado por quem chama, depois). Retorna {} se não houver config. Sempre inclui project_id
// se declarado. NUNCA lança.
export function configMetadata(workspacePath) {
    const cfg = loadProjectConfig(workspacePath);
    if (!cfg) return {};
    const out = {};
    const defaults = cfg.metadata && cfg.metadata.defaults;
    if (defaults && typeof defaults === "object") Object.assign(out, defaults);
    const branchMeta = matchBranchMeta(cfg, workspacePath);
    if (branchMeta) Object.assign(out, branchMeta);
    return out;
}
