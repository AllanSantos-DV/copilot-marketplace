// setupCheck.mjs — AUTOCURA DE SETUP da mesa. Os workers da mesa NÃO usam o binário do app: o worker resolve o
// SDK varrendo o PATH atrás de `copilot.cmd/ps1` (workerLib.sdkIndexUrl) e importa
// `<dir>/node_modules/@github/copilot/copilot-sdk/index.js`. Na prática isso cai no **npm global**
// (%APPDATA%\npm), que NÃO se auto-atualiza junto com o app. Resultado medido (2026-07-28): app 1.0.73 × npm
// global 1.0.5 (março) = ~70 versões atrás — e o `conpty.node` velho estoura assertion (`remove_pty_baton`) sob
// criação/destruição rápida de terminais, que é exatamente o que a mesa faz ao spawnar workers.
//
// Aqui a mesa DIAGNOSTICA a si mesma: descobre a versão que ELA vai usar, compara com a do app (referência de
// "atual") e devolve o veredito + o comando de conserto. Puro/injetável (fs por parâmetro) → testável sem tocar
// o disco. FAIL LOUD: o que não dá pra medir vira INDETERMINADO sinalizado, nunca um "ok" fake.

import { existsSync as fsExists, readFileSync as fsRead, readdirSync as fsReaddir } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { homedir } from "node:os";
import { isNewer } from "../session/askBridgeProtocol.mjs"; // REÚSO: comparador semver-ish já existente

export const FIX_COMMAND = "npm i -g @github/copilot@latest";

// Diretório do pacote @github/copilot que o WORKER vai usar (mesma varredura do sdkIndexUrl, sem duplicar o
// contrato: o worker precisa do index.js, o check precisa do package.json ao lado).
export function resolveWorkerPackageDir({ env = process.env, exists = fsExists } = {}) {
  const sdkEnv = String(env.MODO_AUTO_SDK_PATH || "").trim();
  if (sdkEnv && exists(sdkEnv)) return dirname(dirname(sdkEnv)); // .../@github/copilot/copilot-sdk/index.js → .../copilot
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir || !dir.trim()) continue;
    for (const marker of ["copilot.ps1", "copilot.cmd", "copilot"]) {
      try {
        if (exists(join(dir, marker))) {
          const pkgDir = join(dir, "node_modules", "@github", "copilot");
          if (exists(join(pkgDir, "package.json"))) return pkgDir;
        }
      } catch { /* segue */ }
    }
  }
  return null;
}

const readVersion = (pkgJsonPath, { exists = fsExists, read = fsRead } = {}) => {
  try { return exists(pkgJsonPath) ? (JSON.parse(String(read(pkgJsonPath, "utf8"))).version || null) : null; }
  catch { return null; }
};

// Versão do APP instalado (referência de "atual"): o maior diretório em %LOCALAPPDATA%\copilot\pkg\<plat>.
export function resolveAppVersion({ env = process.env, exists = fsExists, readdir = fsReaddir, home = homedir() } = {}) {
  const base = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "copilot", "pkg");
  try {
    if (!exists(base)) return null;
    const vers = [];
    for (const plat of readdir(base)) {
      const d = join(base, plat);
      try { for (const v of readdir(d)) if (/^\d+\.\d+\.\d+$/.test(v)) vers.push(v); } catch { /* segue */ }
    }
    return vers.sort((a, b) => (isNewer(a, b) ? -1 : 1))[0] || null;
  } catch { return null; }
}

/**
 * DIAGNÓSTICO do setup da mesa.
 * @returns {{ ok:boolean, stale:boolean, workerVersion:string|null, appVersion:string|null,
 *             packageDir:string|null, reason:string, fix:string|null, message:string|null }}
 */
export function checkSetup({ env = process.env, exists = fsExists, read = fsRead, readdir = fsReaddir, home = homedir() } = {}) {
  const packageDir = resolveWorkerPackageDir({ env, exists });
  const workerVersion = packageDir ? readVersion(join(packageDir, "package.json"), { exists, read }) : null;
  const appVersion = resolveAppVersion({ env, exists, readdir, home });

  if (!packageDir || !workerVersion) {
    // NÃO é "ok": é INDETERMINADO e sinalizado (não afirmo saúde do que não medi).
    return { ok: false, stale: false, workerVersion, appVersion, packageDir, reason: "worker-sdk-nao-encontrado", fix: null, message: `⚠️ modo-auto: não consegui determinar a versão do CLI que os workers da mesa usam (${packageDir ? "package.json ilegível em " + packageDir : "nenhum copilot.cmd/ps1 no PATH"}). Sem isso não dá pra garantir que a mesa não está rodando num binário velho.` };
  }
  if (!appVersion) {
    return { ok: true, stale: false, workerVersion, appVersion: null, packageDir, reason: "app-version-desconhecida", fix: null, message: null };
  }
  if (isNewer(appVersion, workerVersion)) {
    return {
      ok: false, stale: true, workerVersion, appVersion, packageDir, reason: "worker-sdk-desatualizado", fix: FIX_COMMAND,
      message: `⚠️ modo-auto — SETUP DESATUALIZADO (autodiagnóstico da mesa): os WORKERS usam o CLI do npm global v${workerVersion}, mas o app está em v${appVersion}. Os workers NÃO seguem a auto-atualização do app — eles resolvem \`@github/copilot\` pelo PATH (${packageDir}). CLI velho = conpty antigo, cuja race condition (remove_pty_baton) estoura POPUP DE ASSERTION exatamente sob criação/destruição rápida de terminais, que é o padrão da mesa ao spawnar workers. CONSERTO: encerre as mesas em andamento e rode \`${FIX_COMMAND}\` (no Windows um .node em uso não é sobrescrito). Depois confirme com \`modo_setup\`.`,
    };
  }
  return { ok: true, stale: false, workerVersion, appVersion, packageDir, reason: "ok", fix: null, message: null };
}

// Linha curta p/ status/painel (sempre honesta: diz a versão MEDIDA, não um "tudo certo" genérico).
export function formatSetup(c) {
  if (!c) return "setup: não avaliado";
  if (c.reason === "worker-sdk-nao-encontrado") return "setup dos workers: INDETERMINADO (CLI não localizado no PATH) — sinalizado";
  const base = `setup dos workers: CLI v${c.workerVersion || "?"}${c.appVersion ? ` · app v${c.appVersion}` : ""}`;
  return c.stale ? `${base} → ⚠️ DESATUALIZADO (rode: ${FIX_COMMAND})` : `${base} → OK`;
}
