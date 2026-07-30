// test-guard.mjs — smoke DETERMINÍSTICO da guarda anti-downgrade + desambiguação.
// Reproduz o incidente real: duas origens do MESMO canvas (vitrine velha + install direto
// novo) e a velha sendo processada DEPOIS. Antes, "o último ganhava" e o mirror era
// rebaixado a cada boot. Aqui isso tem que ser RECUSADO e VISÍVEL.
//
// Rodar: node test-guard.mjs   (não toca em nada fora de uma pasta temporária)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmpVersion, guardDowngrade, planSync, syncCanvases } from "./sync.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---------- unidade: comparação de versão ----------
console.log("cmpVersion");
check("0.2.85 > 0.2.58", cmpVersion("0.2.85", "0.2.58") === 1);
check("0.2.58 < 0.2.85", cmpVersion("0.2.58", "0.2.85") === -1);
check("compara por NÚMERO, não string (0.2.9 < 0.2.10)", cmpVersion("0.2.9", "0.2.10") === -1);
check("iguais dão 0", cmpVersion("1.0.0", "1.0.0") === 0);
check("desconhecido NÃO vira 0", cmpVersion(null, "1.0.0") === null && cmpVersion("abc", "1.0.0") === null);

// ---------- unidade: tabela de 4 casos ----------
console.log("guardDowngrade (tabela de 4 casos)");
check("ambos versionados, entrada mais velha -> RECUSA", guardDowngrade("0.2.85", "0.2.58").allow === false);
check("ambos versionados, entrada mais nova -> permite", guardDowngrade("0.2.58", "0.2.85").allow === true);
check("mesma versão, origem nova -> permite", guardDowngrade("1.0.0", "1.0.0").allow === true);
check("entrada SEM versão, carimbo COM -> RECUSA", guardDowngrade("1.0.0", null).allow === false);
check("entrada COM versão, carimbo SEM -> permite e SINALIZA", (() => {
    const g = guardDowngrade(null, "1.0.0");
    return g.allow === true && g.reason === "carimbo-sem-versao-sinalizado";
})());
check("ambos SEM versão -> permite como NÃO-PROTEGIDO", (() => {
    const g = guardDowngrade(null, null);
    return g.allow === true && g.reason === "ambos-sem-versao-nao-protegido";
})());
check("versão inconhecível NÃO passa como upgrade", guardDowngrade("1.0.0", "vX.Y").allow === false);

// ---------- integração: o cenário que quebrou ----------
console.log("e2e: duas origens (vitrine velha + direto novo) no mesmo alvo");
const home = mkdtempSync(join(tmpdir(), "canvas-sync-test-"));
try {
    const installed = join(home, "installed-plugins");
    const mkPlugin = (dir, name, version) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version, extensions: ["."] }));
        writeFileSync(join(dir, "extension.mjs"), `// ${name} ${version}\nexport const V = "${version}";\n`);
    };
    // Origem A: vitrine, VELHA. Origem B: install direto, NOVA.
    mkPlugin(join(installed, "copilot-marketplace", "demo"), "demo", "0.2.58");
    mkPlugin(join(installed, "_direct", "owner--demo"), "demo", "0.2.85");
    // A vitrine é a que entra por enabledPlugins — e é varrida ANTES do _direct,
    // ou seja, no comportamento antigo ela seria sobrescrita pelo _direct e vice-versa.
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "demo@copilot-marketplace": true } }));

    const r1 = syncCanvases(home);
    const stampPath = join(home, "extensions", "demo", ".canvas-sync.json");
    const stamp1 = JSON.parse(readFileSync(stampPath, "utf8"));
    check("escolhe a MAIOR versão entre as duas origens", stamp1.version === "0.2.85", `carimbou ${stamp1.version}`);
    check("a origem perdedora é reportada como shadowed (não some calada)", r1.shadowed.length === 1 && r1.shadowed[0].version === "0.2.58");
    check("o carimbo registra as origens ambíguas", Array.isArray(stamp1.ambiguousSources) && stamp1.ambiguousSources.length === 2);
    check("o carimbo diz QUAL motor escreveu", typeof stamp1.engine === "string" && typeof stamp1.engineHash === "string");
    check("o conteúdo espelhado é o da versão nova", readFileSync(join(home, "extensions", "demo", "extension.mjs"), "utf8").includes("0.2.85"));

    // Agora o caso puro do incidente: a origem NOVA some (desinstalada) e só resta a VELHA.
    rmSync(join(installed, "_direct"), { recursive: true, force: true });
    const r2 = syncCanvases(home);
    const stamp2 = JSON.parse(readFileSync(stampPath, "utf8"));
    check("a origem velha NÃO rebaixa o mirror", stamp2.version === "0.2.85", `rebaixou para ${stamp2.version}`);
    check("a recusa é VISÍVEL no resultado", r2.blocked.length === 1 && r2.blocked[0].from === "0.2.85" && r2.blocked[0].to === "0.2.58");
    check("o conteúdo espelhado continua o novo", readFileSync(join(home, "extensions", "demo", "extension.mjs"), "utf8").includes("0.2.85"));

    // force NÃO pode atropelar a guarda (senão "conserta com force" ressuscita o bug).
    const r3 = syncCanvases(home, { force: true });
    check("force NÃO atropela a guarda", r3.blocked.length === 1 && JSON.parse(readFileSync(stampPath, "utf8")).version === "0.2.85");
    // rollback deliberado continua possível, mas exige opt-in explícito.
    const r4 = syncCanvases(home, { allowDowngrade: true });
    check("allowDowngrade explícito permite o rollback deliberado", r4.mirrored.includes("demo") && JSON.parse(readFileSync(stampPath, "utf8")).version === "0.2.58");

    // Primeira publicação de um canvas novo não pode ser congelada pela guarda.
    mkPlugin(join(installed, "copilot-marketplace", "novo"), "novo", "1.0.0");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "novo@copilot-marketplace": true } }));
    const r5 = syncCanvases(home);
    check("canvas novo (sem carimbo prévio) é espelhado normalmente", r5.mirrored.includes("novo") && existsSync(join(home, "extensions", "novo", "extension.mjs")));

    // planSync é read-only e não deve inventar versão quando o plugin.json não tem.
    mkPlugin(join(installed, "copilot-marketplace", "semver"), "semver", undefined);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "semver@copilot-marketplace": true } }));
    const item = planSync(home).find((i) => i.name === "semver");
    check("plugin sem versão NÃO vira 0.0.0 fake", item && item.version === null, `veio ${item && item.version}`);
} finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
}

// ---- 0.6.0: ESPELHO EXATO (o bug do soma-pares: arquivo apagado na origem ficava no mirror pra sempre) ----
console.log("e2e: arquivo removido da origem tem que sumir do espelho");
const home2 = mkdtempSync(join(tmpdir(), "canvas-sync-prune-"));
try {
    const installed = join(home2, "installed-plugins", "copilot-marketplace", "demo");
    mkdirSync(join(installed, "src"), { recursive: true });
    writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", extensions: ["."] }));
    writeFileSync(join(installed, "extension.mjs"), "// demo\n");
    writeFileSync(join(installed, "src", "util.mjs"), "export const a = 1;\n");
    writeFileSync(join(installed, "src", "soma-pares.mjs"), "// artefato de teste ao vivo\n");
    writeFileSync(join(home2, "settings.json"), JSON.stringify({ enabledPlugins: { "demo@copilot-marketplace": true } }));

    syncCanvases(home2);
    const alvo = join(home2, "extensions", "demo");
    check("1a sincronia leva os dois arquivos", existsSync(join(alvo, "src", "util.mjs")) && existsSync(join(alvo, "src", "soma-pares.mjs")));

    // o artefato é removido da ORIGEM e a versão sobe (release seguinte)
    rmSync(join(installed, "src", "soma-pares.mjs"), { force: true });
    writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.1", extensions: ["."] }));
    const r = syncCanvases(home2);

    check("o arquivo apagado na origem SOME do espelho", !existsSync(join(alvo, "src", "soma-pares.mjs")));
    check("o que continua na origem PERMANECE", existsSync(join(alvo, "src", "util.mjs")));
    check("a remoção é REPORTADA (não silenciosa)", r.pruned.length === 1 && r.pruned[0].files.some((x) => x.includes("soma-pares")));
    check("o carimbo NÃO é removido como órfão", existsSync(join(alvo, ".canvas-sync.json")));

    // pasta inteira sumindo na origem também tem que sumir
    mkdirSync(join(installed, "extra"), { recursive: true });
    writeFileSync(join(installed, "extra", "x.mjs"), "1");
    writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.2", extensions: ["."] }));
    syncCanvases(home2);
    check("pasta nova aparece no espelho", existsSync(join(alvo, "extra", "x.mjs")));
    rmSync(join(installed, "extra"), { recursive: true, force: true });
    writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.3", extensions: ["."] }));
    syncCanvases(home2);
    check("pasta removida na origem SOME do espelho", !existsSync(join(alvo, "extra")));
} finally {
    try { rmSync(home2, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(`\n${pass} ok · ${fail} falha(s)`);
process.exit(fail === 0 ? 0 : 1);
