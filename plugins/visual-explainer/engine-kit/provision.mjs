// engine-kit/provision.mjs — PROVISION: garante o motor instalado em <home>/<extractTo>.
// Generalização do provision.mjs do embed-house (medido em produção), agora parametrizado pelo
// descritor do registry. Mantém as garantias que já funcionavam:
//   • SHA256 sidecar OBRIGATÓRIO, fail-closed (ausente/malformado/mismatch = ABORT, não instala);
//   • lock atômico ('wx') para serializar consumidores concorrentes na mesma máquina;
//   • reúso por semver same-major >= (dois consumidores com pins diferentes convergem no maior);
//   • download -> .part -> rename atômico; extração em staging -> swap;
//   • shutdown-first (Windows: DLL/EXE em uso impede sobrescrever o diretório).
// NUNCA lança: devolve { ok:false, reason }.
import { mkdirSync, existsSync, renameSync, rmSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifyBlob, DEFAULT_ALGORITHM } from "./signature.mjs";
import { checkTrust, trustPath, cmpVer, rollbackReason, noteVersion } from "./trust.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No Windows o handle de quem acabou de sair solta um instante depois: rename ocupado repete com backoff, depois lança.
export async function renameRetry(a, b, tries = 8) {
  for (let i = 1; ; await sleep(100 * i++)) {
    try { return renameSync(a, b); } catch (e) { if (i >= tries || !/^(EBUSY|EPERM|EACCES)$/.test(e.code)) { throw e; } }
  }
}

const dropFile = (p) => { try { unlinkSync(p); } catch { /* ignore */ } };
const rmTree = (p) => rmSync(p, { recursive: true, force: true });

/** Lock mais velho que isto é considerado ÓRFÃO (processo morreu antes do finally). */
const LOCK_STALE_MS = 120000;

/**
 * Extrai o .tgz. Usa o `tar` do sistema (presente por padrão no Windows 10 1803+, macOS e Linux).
 * Se faltar, falha com razão EXPLÍCITA e acionável em vez de um erro cru de spawn — nunca
 * instala pela metade.
 */
// No Windows, o tar NATIVO (bsdtar, System32) quando existir: um processo aberto a partir de um terminal
// Git Bash herda o GNU tar do Git na frente do PATH, e o GNU tar lê "C:\..." como host remoto ("Cannot
// connect to C: resolve failed") — a instalação de QUALQUER motor quebrava só por onde o host foi aberto.
export function tarBinary({ platform = process.platform, systemRoot = process.env.SystemRoot || process.env.windir, exists = existsSync } = {}) {
  if (platform === "win32" && systemRoot) {
    const native = join(systemRoot, "System32", "tar.exe");
    if (exists(native)) return native;
  }
  return "tar";
}

function extractTgz(tgz, dest) {
  const tar = tarBinary();
  try {
    execFileSync(tar, ["--version"], { stdio: "ignore", windowsHide: true });
  } catch {
    return { ok: false, reason: "`tar` não encontrado no PATH — necessário para extrair o artefato (Windows 10 1803+, macOS e Linux já trazem). Instale-o e tente de novo." };
  }
  try {
    execFileSync(tar, ["-xzf", tgz, "-C", dest], { stdio: "ignore", windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `extração (tar) falhou: ${e?.message || e}` };
  }
}

/**
 * Tenta claim do lock de provisionamento. Grava o PID para diagnóstico e reclama locks
 * órfãos (mais velhos que {@link LOCK_STALE_MS}) — sem isso, um processo morto entre o
 * `openSync` e o `finally` travaria todos os consumidores para sempre.
 */
function claimLock(lock) {
  const open = () => {
    const fd = openSync(lock, "wx");
    try { writeFileSync(lock, String(process.pid)); } catch { /* diagnóstico é best-effort */ }
    return fd;
  };
  try { return open(); } catch {
    try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); return open(); } } catch { /* outro consumidor ganhou a corrida */ }
    return null;
  }
}

/** true se a versão instalada serve o pin: MESMO major e >= (protocolo é atado ao major). */
export const satisfiesPin = (installed, pinned) => String(installed).split(".")[0] === String(pinned).split(".")[0] && cmpVer(installed, pinned) >= 0;

/**
 * Baixa o artefato e confere o sidecar SHA256 (obrigatório, fail-closed) em memória.
 * @returns {Promise<{buf:Buffer} | {reason:string}>}
 */
async function downloadChecked(engine, { log, fetcher, timeoutMs }) {
  let expected;
  try {
    expected = String(await fetcher(engine.checksumUrl, 15000)).trim().split(/\s+/)[0].toLowerCase();
  } catch (e) {
    return { reason: `${engine.name}: sha256 sidecar inacessível (${e.status || e.message}) → ABORT (fail-closed)` };
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) { return { reason: `${engine.name}: sha256 sidecar malformado → ABORT` }; }

  log(`[engine-kit] baixando ${engine.assetUrl} …`);
  let buf;
  try { buf = await fetcher(engine.assetUrl, timeoutMs); }
  catch (e) { return { reason: `${engine.name}: download falhou (${e.status || e.message})` }; }

  const actual = createHash("sha256").update(buf).digest("hex").toLowerCase();
  return actual === expected ? { buf } : { reason: `${engine.name}: SHA256 mismatch (esperado ${expected.slice(0, 12)}…, obtido ${actual.slice(0, 12)}…) → ABORT` };
}

async function fetchBuf(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return Buffer.from(await res.arrayBuffer());
}

/** Lê a versão instalada a partir do package.json do artefato (se houver). */
export function installedVersion(binDir) {
  try { return JSON.parse(readFileSync(join(binDir, "package.json"), "utf8")).version; } catch { return null; }
}

/**
 * AUTENTICIDADE do artefato (Ed25519 hash-then-sign) — o passo que o SHA256 não cobre.
 *
 * O sidecar `.sha256` só prova que o download não corrompeu: quem publica o artefato publica o
 * hash junto, então um artefato TROCADO vem com o hash certo do artefato trocado. A assinatura é
 * o que amarra o artefato a quem detém a chave privada (que nunca sai da máquina do dono).
 *
 * Política, deliberadamente fail-closed e sem meio-termo silencioso:
 *   • `publicKey` declarada no registry  → assinatura é OBRIGATÓRIA (declarar = exigir);
 *   • `signatureRequired:true` sem `publicKey` → manifesto INCONSISTENTE, aborta (não "passa");
 *   • nenhum dos dois → motor ainda não migrado: instala, mas o log SINALIZA (nunca calado).
 *
 * @returns {Promise<{ok:true, signed:boolean} | {ok:false, reason:string}>} nunca lança.
 */
async function verifyAuthenticity(engine, blob, { log, fetcher, trustedKeys }) {
  const publicKey = engine.install?.publicKey;
  const required = engine.install?.signatureRequired === true;
  const algorithm = engine.install?.signatureAlgorithm ?? DEFAULT_ALGORITHM;

  if (!publicKey) {
    // Chave fixada pelo consumidor e registry sem chave: tirar a publicKey do manifest não pode
    // ser o atalho para instalar sem assinatura.
    if (trustedKeys?.[engine.name]) {
      return { ok: false, reason: `${engine.name}: o consumidor fixou uma chave mas o registry não declara publicKey → ABORT (registry pode estar comprometido)` };
    }
    if (required) {
      return { ok: false, reason: `${engine.name}: registry pede assinatura (signatureRequired) mas não declara publicKey → ABORT (manifesto inconsistente)` };
    }
    log(`[engine-kit] ${engine.name}: SEM assinatura no registry — integridade (sha256) verificada, AUTENTICIDADE não`);
    return { ok: true, signed: false };
  }

  // A chave veio do MESMO manifest que o kit baixou — sozinha, ela não prova nada contra um
  // registry comprometido. Confronta com a raiz de confiança LOCAL antes de usá-la.
  const t = checkTrust(engine.name, publicKey, { trustedKeys });
  if (!t.ok) { return { ok: false, reason: t.reason }; }
  if (t.tofu) {
    const how = trustedKeys?.[engine.name] ? "chave FIXADA pelo consumidor conferiu e foi gravada" : "chave pública gravada na 1ª vez (TOFU)";
    log(`[engine-kit] ${engine.name}: ${how} em ${trustPath()} — trocas futuras serão ABORT`);
  }

  let sig;
  try {
    sig = await fetcher(engine.signatureUrl, 15000);
  } catch (e) {
    return { ok: false, reason: `${engine.name}: sidecar .sig inacessível (${e.status || e.message}) mas o registry declara publicKey → ABORT (fail-closed)` };
  }

  const v = verifyBlob(blob, sig, publicKey, { algorithm });
  if (!v.ok) { return { ok: false, reason: `${engine.name}: ${v.reason}` }; }

  log(`[engine-kit] ${engine.name}: assinatura Ed25519 CONFERE (${algorithm})`);
  return { ok: true, signed: true };
}

/**
 * Baixa e VERIFICA um artefato sem instalar — o caminho dos motores `self-managed`.
 *
 * Existe para fechar o ovo-e-galinha do primeiro install: um motor que traz o próprio
 * instalador (o `vox-engine` é um app Python com `install.ps1`) não pode se instalar sozinho
 * numa máquina onde ainda não está. Alguém tem de buscar o instalador — e esse alguém estava
 * sendo CADA consumidor, cada um com sua cópia de resolução de release, SHA256 e Ed25519.
 *
 * Aqui o kit faz o que já sabe fazer (integridade + autenticidade fail-closed) e devolve o
 * caminho do arquivo verificado. Quem sabe o que fazer com ele — rodar um instalador, extrair,
 * conferir uma assinatura extra — é o consumidor. O kit não executa nada.
 *
 * @returns {Promise<{ok:true, path:string, version:string, signed:boolean} | {ok:false, reason:string}>} nunca lança.
 */
export async function fetchArtifact(engine, { log = () => {}, destDir, downloadTimeoutMs = 300000, fetcher = fetchBuf, trustedKeys } = {}) {
  const dir = destDir ?? engine.homeDir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `${engine.name}: não consegui criar ${dir}: ${e?.message || e}` };
  }

  const dl = await downloadChecked(engine, { log, fetcher, timeoutMs: downloadTimeoutMs });
  if (!dl.buf) { return { ok: false, reason: dl.reason }; }
  const buf = dl.buf;

  const auth = await verifyAuthenticity(engine, buf, { log, fetcher, trustedKeys });
  if (!auth.ok) { return { ok: false, reason: auth.reason }; }

  // .part → rename: nunca entregar um caminho que aponta para download pela metade.
  const part = join(dir, `${engine.assetName}.part`);
  const out = join(dir, engine.assetName);
  try {
    writeFileSync(part, buf);
    renameSync(part, out);
  } catch (e) {
    return { ok: false, reason: `${engine.name}: não consegui gravar ${out}: ${e?.message || e}` };
  }
  log(`[engine-kit] ${engine.name} v${engine.version} verificado em ${out}`);
  return { ok: true, path: out, version: engine.version, signed: auth.signed };
}

/**
 * Garante o motor instalado. `onBeforeReplace` é o gancho de shutdown do MOTOR (o kit nunca
 * adivinha como derrubar um daemon: quem sabe é o descritor/consumidor).
 * @returns {Promise<{ok:true, entryPath:string, version:string, reused?:boolean, installed?:boolean} | {ok:false, reason:string}>}
 */
export async function provision(engine, { log = () => {}, allowNetwork = true, onBeforeReplace, downloadTimeoutMs = 120000, fetcher = fetchBuf, trustedKeys, allowDowngrade } = {}) {
  const home = engine.homeDir;
  const binDir = join(home, engine.install.extractTo ?? "bin");
  const entryPath = join(home, engine.install.entry);
  const lock = join(home, "provision.lock");

  // Já instalado? Só reusa se a versão instalada for LEGÍVEL e satisfizer o pin.
  // Versão ilegível (package.json ausente/corrompido = extração interrompida, disco cheio,
  // arquivo truncado) NÃO é motivo para reusar: é estado desconhecido → reprovisiona.
  // Reusar aqui seria fail-open silencioso — o oposto do resto do kit — e congelaria a máquina
  // numa instalação quebrada para sempre, ignorando o pin do registry.
  if (existsSync(entryPath)) {
    const inst = installedVersion(binDir);
    if (inst && satisfiesPin(inst, engine.version)) {
      noteVersion(engine.name, inst);
      return { ok: true, entryPath, version: inst, reused: true };
    }
    if (!inst && engine.status !== "self-managed") {
      log(`[engine-kit] ${engine.name}: instalação em estado desconhecido (versão ilegível) → reprovisionando`);
      if (!allowNetwork) {
        return { ok: false, reason: `${engine.name}: instalação em estado desconhecido (package.json ausente/corrompido em ${binDir}) e rede desabilitada — não dá para validar nem reparar` };
      }
    } else if (inst) {
      log(`[engine-kit] ${engine.name}: instalada v${inst} não satisfaz o pin v${engine.version} → atualizando`);
    }
  }

  // Antes de qualquer teste de rede/estado local: o que o kit NÃO faz com este motor vale
  // independente de como ele está instalado.
  // Motor que traz o PRÓPRIO instalador (ex.: um app com updater embutido). A entrada no registry
  // existe como descritor de registro — release, chave, versão — mas quem instala é ele mesmo.
  // Tentar provisionar aqui daria erro obscuro (o artefato é um instalador, não um tarball de
  // `extractTo`); melhor recusar dizendo QUEM instala.
  if (engine.status === "self-managed") {
    return { ok: false, reason: `${engine.name} é self-managed: instala e atualiza pelo próprio updater, não pelo engine-kit (o registry guarda o descritor da release)` };
  }

  if (!allowNetwork) { return { ok: false, reason: `${engine.name} ausente/desatualizado e rede desabilitada` }; }
  if (engine.status === "pending-release") {
    return { ok: false, reason: `${engine.name} ainda não publicou release (status: pending-release)` };
  }

  const rb = !allowDowngrade && rollbackReason(engine.name, engine.version);
  if (rb) { return { ok: false, reason: rb }; }

  mkdirSync(home, { recursive: true });

  // LOCK atômico: só um consumidor provisiona; os demais aguardam o resultado dele.
  // Um lock órfão (processo morto) é reclamado por idade — não trava a máquina para sempre.
  const lockFd = claimLock(lock);
  if (lockFd === null) {
    for (let i = 0; i < 40; i++) {
      if (existsSync(entryPath)) {
        const inst = installedVersion(binDir);
        // Se o vencedor terminou mas a versão continua ilegível, não invente: sinalize.
        if (inst) { return { ok: true, entryPath, version: inst, reused: true }; }
      }
      await sleep(1000);
    }
    return { ok: false, reason: `${engine.name}: provision-locked-timeout (outro consumidor está instalando há >40s)` };
  }

  try {
    // 1-3) Sidecar SHA256 obrigatório, download e integridade: nada toca o disco antes de conferir.
    const dl = await downloadChecked(engine, { log, fetcher, timeoutMs: downloadTimeoutMs });
    if (!dl.buf) { return { ok: false, reason: dl.reason }; }
    const buf = dl.buf;
    const part = join(home, `${engine.assetName}.part`);
    const tgz = join(home, engine.assetName);
    writeFileSync(part, buf);
    renameSync(part, tgz);

    // 3.5) AUTENTICIDADE — antes de extrair. Um artefato não confiável não chega a tocar o disco
    //      final: se a assinatura não confere, o .tgz é apagado e nada é instalado.
    const auth = await verifyAuthenticity(engine, buf, { log, fetcher, trustedKeys });
    if (!auth.ok) {
      dropFile(tgz);
      return { ok: false, reason: auth.reason };
    }

    // 4) Extrai em staging e faz o swap (com shutdown-first se já existe).
    const staging = join(home, `stage-${engine.version}`);
    rmTree(staging);
    mkdirSync(staging, { recursive: true });
    const ex = extractTgz(tgz, staging);
    if (!ex.ok) { return { ok: false, reason: `${engine.name}: ${ex.reason}` }; }

    // 4.5) VERSÃO — a assinatura prova QUEM publicou o artefato, não QUAL versão ele é. Uma release
    //      antiga, legitimamente assinada, servida no lugar da nova (replay/downgrade) passaria pelo
    //      sha256 e pela Ed25519. O package.json do artefato tem de dizer a versão que o registry pede.
    const got = installedVersion(staging);
    if (got !== engine.version) {
      rmTree(staging);
      dropFile(tgz);
      return { ok: false, reason: `${engine.name}: o artefato diz v${got ?? "? (package.json ausente/ilegível)"} e o registry pede v${engine.version} → ABORT` };
    }

    // A instalação atual sai do caminho por RENAME, não por rmSync: no Windows, com o motor em uso
    // (sem shutdownPath, ou um host segurando o processo), o rmSync apagava metade da pasta antes do
    // EPERM e deixava a máquina sem motor nenhum. O rename falha inteiro ou passa inteiro.
    let aside = null;
    if (existsSync(binDir)) {
      if (onBeforeReplace) { try { await onBeforeReplace(); } catch { /* best-effort */ } }
      aside = `${binDir}.old-${process.pid}`;
      rmTree(aside);
      try {
        await renameRetry(binDir, aside);
      } catch (e) {
        rmTree(staging);
        dropFile(tgz);
        return { ok: false, reason: `${engine.name}: não consegui trocar ${binDir} (${e.code || e.message}): arquivos em uso — feche quem usa o motor e rode de novo; a instalação atual ficou intacta` };
      }
    }
    // `extractTo` pode ser ANINHADO (ex.: "runtimes/<motor>", quando o home guarda estado que
    // precisa sobreviver ao swap — pesos, logs). O rename exige o diretório-pai existente: sem
    // isto, funciona na máquina que já tem a pasta e falha justamente na máquina limpa.
    mkdirSync(dirname(binDir), { recursive: true });
    try {
      await renameRetry(staging, binDir);
    } catch (e) {
      if (aside) { try { renameSync(aside, binDir); } catch { /* o reason abaixo diz onde ficou */ } }
      return { ok: false, reason: `${engine.name}: swap falhou (${e.code || e.message})${aside && existsSync(aside) ? `; a instalação anterior está em ${aside}` : ""}` };
    }
    if (aside) {
      try { rmTree(aside); }
      catch (e) { log(`[engine-kit] ${engine.name}: instalado, mas a versão anterior ficou em ${aside} (${e.code || e.message})`); }
    }
    dropFile(tgz);

    if (!existsSync(entryPath)) {
      return { ok: false, reason: `${engine.name}: artefato extraído incompleto (sem ${engine.install.entry})` };
    }
    noteVersion(engine.name, engine.version);
    log(`[engine-kit] ${engine.name} instalado em ${binDir} (v${engine.version})`);
    return { ok: true, entryPath, version: engine.version, installed: true, signed: auth.signed };
  } catch (e) {
    return { ok: false, reason: `${engine.name}: provision falhou: ${e?.message || e}` };
  } finally {
    try { closeSync(lockFd); unlinkSync(lock); } catch { /* ignore */ }
  }
}
