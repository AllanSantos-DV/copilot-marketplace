// voice-engine-bootstrap.mjs — o PRIMEIRO install do motor, e só ele.
//
// Ovo-e-galinha: o motor sabe se instalar, se atualizar, se reciclar e verificar a própria
// assinatura — mas nada disso ajuda numa máquina onde ele ainda NÃO existe. Alguém tem de
// buscar o instalador da primeira vez.
//
// Esse "alguém" era o `vox_lifecycle.py` vendorizado: 1049 linhas de resolução de release,
// download, Ed25519, lock entre processos, reciclagem e máquina de estados, copiadas para
// dentro deste plugin — e de cada outro consumidor, cada cópia com a chave pública pinada da
// época. Aqui sobra o IRREDUTÍVEL: baixar, VERIFICAR e rodar o instalador.
//
// Por que não importar o `engine-kit` e reusar tudo: um plugin do Copilot CLI é distribuído
// como arquivos soltos, sem `node_modules` — `import "engine-kit"` não resolve. Este é, então,
// o único pedaço que continua morando no consumidor. São ~90 linhas contra 1049, e a chave
// pública NÃO fica mais pinada aqui: vem do manifesto do engine-registry, o mesmo âncora de
// confiança (HTTPS + repo do dono) que o kit usa.
//
// Depois deste passo o plugin nunca mais precisa saber de release, hash ou chave: atualizar e
// reciclar é `vox ensure`, do próprio motor.
//
// Fail-closed: sem sha256 conferido E assinatura válida, NÃO instala. Degrada SINALIZADO —
// devolve `{ ok:false, reason }`, nunca finge que instalou.

import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ENGINE = "vox-engine";
// `VOX_REGISTRY_MANIFEST` permite apontar para outro manifesto (uma branch em validação, um
// registry interno). Sem override, o canônico publicado.
const REGISTRY_MANIFEST = process.env.VOX_REGISTRY_MANIFEST ||
    "https://raw.githubusercontent.com/AllanSantos-DV/engine-registry/main/manifest.json";

/** Envelope DER fixo de uma chave Ed25519 (RFC 8410): o Node não importa chave crua. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Raiz da instalação por-usuário do motor. É o único caminho estável do contrato. */
const INSTALL_ROOT = join(process.env.LOCALAPPDATA || homedir(), "vox-engine");

/**
 * Onde o `vox` aparece depois de instalado.
 *
 * O instalador cria um venv em `<raiz>/venv` e os console-scripts ficam em `venv/Scripts`.
 * Eu tinha escrito `<raiz>/Scripts` — sem o segmento `venv` — e o motor ficava "não instalado"
 * com o executável no disco, disparando reinstalação em loop. O outro palpite (`~/.vox-engine`)
 * também estava errado: aquilo é o VOX_HOME dos MODELOS, não a raiz de instalação.
 */
const CANDIDATE_DIRS = [
    join(INSTALL_ROOT, "venv", "Scripts"),   // Windows
    join(INSTALL_ROOT, "venv", "bin"),       // POSIX
];

/**
 * O motor PUBLICA onde instalou o próprio CLI (`<raiz>/cli.json`), a partir do executável do
 * venv dele — sem adivinhar. Ler isso primeiro é o que impede este bug de voltar quando o
 * layout mudar: o consumidor deixa de deduzir e passa a consultar.
 */
function fromPointer() {
    try {
        const raw = readFileSync(join(INSTALL_ROOT, "cli.json"), "utf-8");
        const p = JSON.parse(raw)?.vox;
        return p && existsSync(p) ? p : null;
    } catch {
        return null;   // ausente/ilegível é esperado antes do 1º boot — cai para o palpite
    }
}

/** Caminho do `vox`, ou null se o motor ainda não está instalado. */
export function findVox() {
    if (process.env.VOX_CLI && existsSync(process.env.VOX_CLI)) { return process.env.VOX_CLI; }
    const declarado = fromPointer();
    if (declarado) { return declarado; }
    for (const d of CANDIDATE_DIRS) {
        for (const name of ["vox.exe", "vox"]) {
            const p = join(d, name);
            if (existsSync(p)) { return p; }
        }
    }
    // PATH por último: só resolve se alguém instalou o motor globalmente, e arriscaria pegar um
    // `vox` de outro projeto antes do motor de que este plugin depende.
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["vox"], { encoding: "utf8" });
    if (probe.status === 0) {
        const first = String(probe.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (first && existsSync(first)) { return first; }
    }
    return null;
}

async function grab(url, timeoutMs = 300000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { throw new Error(`HTTP ${res.status} em ${url}`); }
    return Buffer.from(await res.arrayBuffer());
}

/** Verifica a assinatura Ed25519 do SHA-256 do artefato (contrato `ed25519-sha256-raw`). */
export function verifySignature(blob, sig, publicKeyHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(String(publicKeyHex || ""))) { return false; }
    if (!Buffer.isBuffer(sig) || sig.length !== 64) { return false; }
    try {
        const key = createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
            format: "der", type: "spki",
        });
        // Ed25519 no Node exige a API estática com o 1º argumento NULL.
        return edVerify(null, createHash("sha256").update(blob).digest(), key, sig);
    } catch {
        return false;
    }
}

/** Resolve o descritor do motor no registry e monta as URLs da release. */
export async function resolveEngine() {
    const manifest = JSON.parse(String(await grab(REGISTRY_MANIFEST, 20000)));
    const engine = (manifest.engines || []).find((e) => e.name === ENGINE);
    if (!engine) { throw new Error(`"${ENGINE}" não está no registry`); }
    const inst = engine.install || {};
    if (!inst.publicKey) {
        // Sem chave declarada não há como provar a origem: recusar é o único caminho honesto.
        throw new Error("o registry não declara a chave pública do motor → ABORT (fail-closed)");
    }
    const fill = (tpl, extra = {}) =>
        String(tpl).replace(/\{(\w+)\}/g, (m, k) => ({ version: engine.version, ...extra })[k] ?? m);
    const assetName = fill(inst.asset);
    const base = `https://github.com/${inst.repo}/releases/download/${fill(inst.tag)}`;
    return {
        version: engine.version,
        publicKey: inst.publicKey,
        assetName,
        assetUrl: `${base}/${assetName}`,
        checksumUrl: `${base}/${fill(inst.checksum, { asset: assetName })}`,
        signatureUrl: `${base}/${fill(inst.signature || "{asset}.sig", { asset: assetName })}`,
    };
}

/**
 * Garante o motor INSTALADO (não "no ar" — subir é do `vox ensure`).
 *
 * @returns {Promise<{ok:true, vox:string, installed:boolean, version?:string} | {ok:false, reason:string}>}
 */
export async function ensureEngineInstalled({ log = () => {} } = {}) {
    const jaTem = findVox();
    if (jaTem) { return { ok: true, vox: jaTem, installed: false }; }

    log("motor de voz não instalado — buscando o instalador assinado no engine-registry");

    let d;
    try { d = await resolveEngine(); }
    catch (e) { return { ok: false, reason: `registry: ${e?.message || e}` }; }

    let blob, sha, sig;
    try {
        blob = await grab(d.assetUrl);
        sha = String(await grab(d.checksumUrl, 20000)).trim().split(/\s+/)[0].toLowerCase();
        sig = await grab(d.signatureUrl, 20000);
    } catch (e) {
        return { ok: false, reason: `download do instalador falhou: ${e?.message || e}` };
    }

    const actual = createHash("sha256").update(blob).digest("hex").toLowerCase();
    if (actual !== sha) {
        return { ok: false, reason: `SHA256 divergente (release=${sha.slice(0, 12)}… baixado=${actual.slice(0, 12)}…) → ABORT` };
    }
    if (!verifySignature(blob, sig, d.publicKey)) {
        return { ok: false, reason: "assinatura Ed25519 do instalador NÃO confere → ABORT (fail-closed)" };
    }

    const dest = mkdtempSync(join(tmpdir(), "vox-install-"));
    const zip = join(dest, d.assetName);
    writeFileSync(zip, blob);

    log(`instalando o motor v${d.version} (pode levar alguns minutos)…`);
    const run = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}\\x' -Force; ` +
        `& '${dest}\\x\\install.ps1'`,
    ], { encoding: "utf8", timeout: 30 * 60 * 1000, windowsHide: true });

    if (run.status !== 0) {
        const err = String(run.stderr || run.stdout || "").trim().slice(-400);
        return { ok: false, reason: `o instalador falhou (exit ${run.status}): ${err}` };
    }

    const vox = findVox();
    if (!vox) {
        return { ok: false, reason: "o instalador terminou mas o executável 'vox' não apareceu" };
    }
    log(`motor v${d.version} instalado`);
    return { ok: true, vox, installed: true, version: d.version };
}
