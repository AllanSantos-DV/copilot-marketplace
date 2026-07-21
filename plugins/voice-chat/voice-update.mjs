// voice-update.mjs — auto-update DA EXTENSÃO (não do motor: o motor é do SDK via ensure_vox no worker).
// Funções PURAS de versão, verificação de assinatura Ed25519 do manifesto, download resiliente
// (nativo + fallback curl/Schannel p/ redes que reassinam o TLS), e a decisão do que aplicar a quente
// vs app-restart (logic-hash sobre os módulos de LÓGICA). O orquestrador `checkForUpdate` e o estado
// (readUpdateState/effectiveVersion, ligados ao ARTIFACTS) vivem no extension.mjs e chamam estas.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { dbg } from "./voice-core.mjs";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_NAME = "voice-chat";

export function parseVer(v) {
    return String(v || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
}
export function verGt(a, b) {
    const A = parseVer(a), B = parseVer(b);
    for (let i = 0; i < 3; i++) {
        if ((A[i] || 0) > (B[i] || 0)) return true;
        if ((A[i] || 0) < (B[i] || 0)) return false;
    }
    return false;
}
// O primário cede a uma fork ESTRITAMENTE mais nova (mesmo mecanismo do reclaim, agora
// automático + consciente de versão). Versão vazia/igual/menor NÃO cede (evita flap/loop).
export function shouldStepDownForNewer(myVer, forkVer) {
    return !!forkVer && verGt(String(forkVer), String(myVer));
}
export function sha256Hex(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
// Chave pública Ed25519 do projeto (pinada). O manifest.json de cada release é
// ASSINADO com a chave PRIVADA (fora do repo; ver gen-manifest.mjs) e verificado
// aqui antes de qualquer arquivo ser staged. Isso fecha o buraco de um proxy que
// reassina o TLS (rede "SSL assinado" / CA hostil no trust store): sem a privada,
// ninguém forja um manifesto — então nem os bytes nem os sha256 podem ser trocados
// por conteúdo malicioso. Rotacionar a chave = nova release com esta constante nova.
const UPDATE_PUBLIC_KEY_B64 = "/PHACLNF4lvlJuSGsa44VGbfu+IbwccWoIvoDUwZmOQ=";
// Prefixo DER SPKI de uma chave Ed25519 (12 bytes) + os 32 bytes crus da pública.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
let _updPubKey = null;
export function updatePublicKey() {
    if (_updPubKey) return _updPubKey;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(UPDATE_PUBLIC_KEY_B64, "base64")]);
    _updPubKey = createPublicKey({ key: der, format: "der", type: "spki" });
    return _updPubKey;
}
// Campos do manifesto assinado com formato ESTRITO — assim a mensagem canônica é
// INJETIVA (nenhum separador `:` ou `\n` pode aparecer DENTRO de um campo), e uma
// assinatura nunca vale para dois (version, files) distintos:
//   path:    basename simples [A-Za-z0-9._-] (casa os UPDATABLE_FILES; sem / \ : \n)
//   sha256:  exatamente 64 hex minúsculos
//   version: dígitos/letras/.+- (sem `\n`)
const MANIFEST_PATH_RE = /^[A-Za-z0-9._-]+$/;
const MANIFEST_SHA256_RE = /^[0-9a-f]{64}$/;
const MANIFEST_VERSION_RE = /^[0-9A-Za-z.+-]+$/;
export function manifestFileValid(f) {
    return !!f && typeof f === "object"
        && typeof f.path === "string" && MANIFEST_PATH_RE.test(f.path)
        && typeof f.sha256 === "string" && MANIFEST_SHA256_RE.test(f.sha256);
}
// Mensagem canônica assinada — IDÊNTICA à de gen-manifest.mjs: rótulo + versão +
// "path:sha256" de cada arquivo, ordenado por path (determinístico nos dois lados).
// Só produz bytes sem ambiguidade quando os campos passaram a validação estrita.
export function manifestSigMessage(version, files) {
    const parts = (Array.isArray(files) ? files : [])
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => f.path + ":" + f.sha256);
    return Buffer.from("voice-chat-manifest-v1\n" + (version || "") + "\n" + parts.join("\n"), "utf8");
}
// Verdadeiro só se o manifesto é Ed25519-assinado, a assinatura confere com a chave
// pinada, a versão é bem-formada, E todo arquivo traz path seguro + sha256 hex de 64
// (a assinatura cobre path E hash, sem ambiguidade de encoding). Nunca lança.
export function verifyManifestSig(manifest) {
    try {
        if (!manifest || manifest.sigAlg !== "ed25519" || typeof manifest.sig !== "string") return false;
        if (typeof manifest.version !== "string" || !MANIFEST_VERSION_RE.test(manifest.version)) return false;
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        if (!files.length || !files.every(manifestFileValid)) return false;
        const msg = manifestSigMessage(manifest.version, files);
        return edVerify(null, msg, updatePublicKey(), Buffer.from(manifest.sig, "base64"));
    } catch (e) {
        dbg("verifyManifestSig error: " + (e && e.message));
        return false;
    }
}
// Anti-rollback: a versão ASSINADA precisa ser exatamente a anunciada no marketplace
// E estritamente maior que a instalada. Sem isto, um MITM anuncia uma versão alta (o
// marketplace.json NÃO é assinado) e devolve um manifesto ANTIGO genuinamente
// assinado → downgrade forçado para uma release vulnerável. `verGt` já é estrito.
export function updateVersionAcceptable(signedVer, announcedVer, currentVer) {
    return typeof signedVer === "string" && signedVer.length > 0
        && signedVer === announcedVer && verGt(signedVer, currentVer);
}
let _caBundle = null;
export function caBundle() {
    if (_caBundle) return _caBundle;
    let sys = [];
    try { sys = tls.getCACertificates("system") || []; } catch { sys = []; }
    _caBundle = [...(tls.rootCertificates || []), ...sys];
    return _caBundle;
}
// Teto de tamanho para downloads do updater (nativo E curl): uma rede hostil não
// pode streamar um corpo infinito e derrubar por OOM o event loop single-thread.
const MAX_FETCH_BYTES = 64 * 1024 * 1024;
export function fetchViaNode(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const getter = new URL(url).protocol === "http:" ? httpGet : httpsGet;
        const req = getter(url, { headers: { "User-Agent": "voice-chat-updater", Accept: "*/*" }, ca: caBundle() }, (res) => {
            const sc = res.statusCode || 0;
            if (sc >= 300 && sc < 400 && res.headers.location && redirects < 5) {
                const next = new URL(res.headers.location, url);
                res.resume();
                // Nunca segue um downgrade https -> http (evita rebaixar a segurança
                // do canal via redirect forjado).
                if (new URL(url).protocol === "https:" && next.protocol !== "https:") {
                    reject(new Error("redirect inseguro (https->" + next.protocol + ")"));
                    return;
                }
                resolve(fetchViaNode(next.toString(), redirects + 1));
                return;
            }
            if (sc !== 200) {
                res.resume();
                const err = new Error("HTTP " + sc);
                err.httpStatus = sc;   // já houve resposta HTTP: curl não ajudaria
                reject(err);
                return;
            }
            const chunks = [];
            let len = 0;
            // Teto de tamanho (mesmo do fetchViaCurl): uma rede hostil não pode streamar
            // um corpo infinito e derrubar por OOM o event loop single-thread da extensão.
            res.on("data", (c) => {
                len += c.length;
                if (len > MAX_FETCH_BYTES) {
                    res.destroy();
                    reject(new Error("resposta excedeu o limite de tamanho"));
                    return;
                }
                chunks.push(c);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    });
}
// Fallback para redes que reassinam o HTTPS com uma CA própria ("SSL assinado" /
// TLS interception corporativo): o CA bundle do Node não conhece essa CA, então o
// fetch nativo falha na verificação. O curl.exe do System32 usa o Schannel (o stack
// TLS do Windows), que confia no MESMO trust store da máquina onde a CA corporativa
// está instalada — e respeita HTTP(S)_PROXY. Só Windows; sem dep nova. Caminho
// ABSOLUTO de System32 de propósito: garante o curl Schannel (não um curl OpenSSL
// que estiver no PATH, ex.: git/msys). Retorna Buffer (o sha256 do update é checado
// depois, então o conteúdo continua verificado).
export function fetchViaCurl(url) {
    if (process.platform !== "win32") return Promise.resolve(null);
    const curl = join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
    if (!existsSync(curl)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        // spawn ASSÍNCRONO (não spawnSync): baixar por curl NÃO pode congelar o
        // event loop single-thread da extensão (áudio/turnos ficariam parados). Teto
        // de 64MB na resposta + timeout backstop de 35s (além do --max-time do curl).
        const child = spawn(curl, [
            "--fail", "--location", "--silent", "--show-error",
            "--proto-redir", "=https", "--max-redirs", "5",
            "--max-time", "30", "-A", "voice-chat-updater", "--", url,
        ], { windowsHide: true });
        const out = [], err = [];
        let outLen = 0, done = false;
        const MAX = MAX_FETCH_BYTES;
        const to = setTimeout(() => end(reject, new Error("curl: timeout")), 35000);
        function end(fn, arg) {
            if (done) return;
            done = true;
            clearTimeout(to);
            try { child.kill(); } catch { /* já saiu */ }
            fn(arg);
        }
        child.on("error", (e) => end(reject, new Error("curl: " + e.message)));
        child.stdout.on("data", (c) => {
            outLen += c.length;
            if (outLen > MAX) return end(reject, new Error("curl: resposta excedeu 64MB"));
            out.push(c);
        });
        child.stderr.on("data", (c) => err.push(c));
        child.on("close", (code) => {
            if (done) return;
            done = true;
            clearTimeout(to);
            if (code !== 0) {
                reject(new Error("curl: " + (Buffer.concat(err).toString().trim() || ("exit " + code))));
                return;
            }
            resolve(Buffer.concat(out));
        });
    });
}
export async function fetchBuf(url) {
    try {
        return await fetchViaNode(url);
    } catch (e) {
        // Só cai no curl em falha de REDE/TLS (o caso das redes que reassinam o
        // HTTPS). Se já houve resposta HTTP (4xx/5xx) ou um redirect inseguro, o
        // curl não ajudaria — propaga o erro original.
        if (e && (e.httpStatus || /redirect inseguro/.test(e.message || ""))) throw e;
        let buf = null;
        try {
            buf = await fetchViaCurl(url);
        } catch (ce) {
            throw new Error("download falhou (node: " + (e && e.message || e) + "; curl: " + (ce && ce.message || ce) + ")");
        }
        if (buf == null) throw e;   // sem curl (não-Windows / ausente): erro original
        dbg("update: fetch nativo falhou (" + (e && e.message) + "); usei curl.exe do Windows (Schannel/trust store)");
        return buf;
    }
}
export function pickPluginVersion(mp, name) {
    const arr = mp && Array.isArray(mp.plugins) ? mp.plugins : [];
    const p = arr.find((x) => x && x.name === name);
    return p && typeof p.version === "string" ? p.version : "";
}
export function releaseAssetBase(version) {
    if (process.env.VOICE_UPDATE_BASE) return process.env.VOICE_UPDATE_BASE.replace(/\/?$/, "/");
    return `https://github.com/AllanSantos-DV/copilot-marketplace/releases/download/${PLUGIN_NAME}-v${version}/`;
}

// --- Auto-aplicar update (worker/UI a quente; app-restart só se a LÓGICA mudou) ---
// Arquivos que o worker (processo filho) carrega: um restart do worker os aplica a quente.
const WORKER_UPDATE_FILES = new Set(["voice_worker.py", "vox_sdk.py", "vox_lifecycle.py", "vox_stream.py", "capture_port.py", "capture_session.py", "vox_capture_adapter.py", "_ed25519_ref.py", "requirements.txt"]);
// A versão é sincronizada dentro do extension.mjs a cada release (gen-manifest), então o FILE
// muda todo release. Para decidir se a LÓGICA mudou (e o app precisa reimportar o módulo),
// hasheamos ignorando a linha da versão: release que só troca versão (ou só mexe em worker/UI)
// NÃO conta como mudança de lógica e é aplicado a quente.
export function extLogicNormalize(src) {
    // Máscara da VERSÃO para o hash "de lógica". Robusto por design (gate):
    //  - normaliza EOL (CRLF->LF) p/ ser insensível a fim de linha entre releases;
    //  - âncora no INÍCIO da linha (flag m) p/ NUNCA casar a linha-isca 'const CURRENT_VERSION="0";'
    //    daqui de dentro nem uma ocorrência em comentário; tolera espaçamento variável.
    return String(src)
        .replace(/\r\n/g, "\n")
        .replace(/^(?:export\s+)?const\s+CURRENT_VERSION\s*=\s*"[^"]*"\s*;/m, 'const CURRENT_VERSION="0";');
}
// Arquivos de LÓGICA da extensão (ESM/cross-process) cuja mudança exige RE-IMPORT -> app-restart. NÃO
// inclui worker/SDK (hot via restart do worker), o hook (roda fresco a cada agentStop) nem a UI. O hash
// de lógica cobre TODOS eles (concatenados, versão mascarada): senão um update que só mexe num módulo
// de lógica não dispararia o app-restart e a extensão seguiria com o código antigo em memória.
export const LOGIC_FILES = ["extension.mjs", "voice-shared.cjs", "voice-core.mjs", "voice-python.mjs", "voice-update.mjs", "voice-text.mjs", "voice-state.mjs", "voice-audio.mjs", "voice-worker.mjs", "voice-net.mjs"];
export function computeLogicSha(getSrc) {
    let acc = "";
    for (const rel of LOGIC_FILES) acc += rel + "\0" + extLogicNormalize(getSrc(rel)) + "\0";
    return sha256Hex(Buffer.from(acc, "utf8"));
}
export const RUNNING_EXT_LOGIC_SHA = (() => {
    try { return computeLogicSha((rel) => readFileSync(join(EXT_DIR, rel), "utf8")); } catch { return ""; }
})();
// Decisão PURA: dado o que mudou no stage, o que aplicar. needsAppRestart só quando a LÓGICA
// mudou (o bundle é co-versionado -> aplica tudo junto num restart do app, atômico).
export function classifyStagedUpdate(changedRels, extLogicChanged) {
    const set = new Set(changedRels || []);
    let workerChanged = false;
    for (const f of WORKER_UPDATE_FILES) if (set.has(f)) { workerChanged = true; break; }
    return { workerChanged, uiChanged: set.has("iframe.html"), needsAppRestart: !!extLogicChanged };
}
