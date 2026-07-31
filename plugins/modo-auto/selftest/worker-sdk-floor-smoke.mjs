// worker-sdk-floor-smoke.mjs — o worker RECUSA setup abaixo do piso, alto e explícito,
// em vez de morrer opaco com "Cannot find package '@github/copilot-sdk'".
// Determinístico: monta PATHs sintéticos numa pasta temporária; não toca na máquina.

import { tmpDir } from "./tmpProjeto.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { resolveWorkerSdk, WorkerSetupError, WORKER_FIX_COMMAND } from "../src/adapters/agents/workerLib.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const root = tmpDir("modo-auto-sdkfloor-");
const mkCli = (name, { layout, version }) => {
    const bin = join(root, name);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "copilot.cmd"), "@echo off\n");
    const pkgDir = join(bin, "node_modules", "@github", "copilot");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@github/copilot", version }));
    const sdkDir = layout === "novo"
        ? join(pkgDir, "node_modules", "@github", `copilot-${platform()}-${arch()}`, "copilot-sdk")
        : join(pkgDir, "copilot-sdk");
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(sdkDir, "index.js"), "export const CopilotClient = null;\n");
    return bin;
};

try {
    // Ambiente sintético: sem SDK do app, para isolar o caminho do npm global.
    const base = { COPILOT_SDK_PATH: join(root, "inexistente", "index.js") };
    const home = join(root, "home-sem-app"); // home sintetico: isola o fallback do SDK do app

    console.log("layout NOVO (CLI atual)");
    const modern = mkCli("cli-novo", { layout: "novo", version: "1.0.75" });
    const okRes = resolveWorkerSdk({ env: { ...base, PATH: modern }, home });
    check("resolve pelo npm global", okRes.source === "npm-global", `source=${okRes.source}`);
    check("reporta a versão medida do CLI", okRes.cliVersion === "1.0.75", `veio ${okRes.cliVersion}`);
    check("aponta para o layout por plataforma", okRes.url.includes(`copilot-${platform()}-${arch()}`));

    console.log("layout ANTIGO (CLI pré-migração) — tem que RECUSAR");
    const ancient = mkCli("cli-velho", { layout: "antigo", version: "1.0.5" });
    let err = null;
    try { resolveWorkerSdk({ env: { ...base, PATH: ancient }, home }); } catch (e) { err = e; }
    check("lança WorkerSetupError (não devolve URL)", err instanceof WorkerSetupError);
    check("classifica o motivo", err?.detail?.reason === "sdk-pre-migracao", `reason=${err?.detail?.reason}`);
    check("a mensagem diz a VERSÃO medida", String(err?.message).includes("1.0.5"));
    check("a mensagem explica o vazamento de configDirectory", String(err?.message).includes("configDirectory"));
    check("a mensagem traz o CONSERTO", String(err?.message).includes(WORKER_FIX_COMMAND));
    check("oferece o escape consciente", String(err?.message).includes("MODO_AUTO_ALLOW_LEGACY_SDK"));

    console.log("escape explícito");
    const esc = resolveWorkerSdk({ env: { ...base, PATH: ancient, MODO_AUTO_ALLOW_LEGACY_SDK: "1" }, home });
    check("com opt-in, aceita o layout antigo e SINALIZA a origem", esc.source === "npm-global-legacy", `source=${esc.source}`);

    console.log("preferência: SDK do app ganha do CLI pré-migração");
    const appSdk = join(root, "app-sdk");
    mkdirSync(appSdk, { recursive: true });
    writeFileSync(join(appSdk, "index.js"), "export const CopilotClient = null;\n");
    const pref = resolveWorkerSdk({ env: { PATH: ancient, COPILOT_SDK_PATH: appSdk }, home });
    check("usa o SDK do app em vez do CLI velho", pref.source === "app", `source=${pref.source}`);

    console.log("nada encontrado — erro ACIONÁVEL, não opaco");
    let err2 = null;
    try { resolveWorkerSdk({ env: { PATH: join(root, "vazio"), COPILOT_SDK_PATH: join(root, "nada", "index.js") }, home }); } catch (e) { err2 = e; }
    check("lança em vez de devolver bare specifier", err2 instanceof WorkerSetupError);
    check("classifica como não-encontrado", err2?.detail?.reason === "sdk-nao-encontrado");
    check("NÃO devolve '@github/copilot-sdk' silencioso", !String(err2?.message).match(/^@github\/copilot-sdk$/));
    check("traz o conserto", String(err2?.message).includes(WORKER_FIX_COMMAND));

    console.log("override explícito continua vencendo");
    const ov = resolveWorkerSdk({ env: { MODO_AUTO_SDK_PATH: join(appSdk, "index.js"), PATH: ancient }, home });
    check("MODO_AUTO_SDK_PATH tem prioridade", ov.source === "override");
} finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log(`\n${pass} ok · ${fail} falha(s)`);
process.exit(fail === 0 ? 0 : 1);
