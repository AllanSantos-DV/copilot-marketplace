// engine-kit/signature.mjs — AUTENTICIDADE: assinatura Ed25519 dos artefatos de motor.
//
// Uma implementação, N motores. O SHA256 do kit prova INTEGRIDADE (não corrompeu no caminho);
// a assinatura prova AUTENTICIDADE (veio de quem tem a chave privada). Sem ela, quem controlar
// o release serve um artefato trocado e o sha256 sidecar bate — porque o atacante gera os dois.
//
// CONTRATO — `ed25519-sha256-raw` (o mesmo que o vox-engine já pratica em produção, para que a
// migração dele não exija reassinar nada):
//   • hash-then-sign: assina-se o SHA-256 (32 bytes) do artefato, NÃO o artefato direto;
//   • o `.sig` é a assinatura Ed25519 CRUA — 64 bytes binários, nunca base64;
//   • a chave pública é 32 bytes em hex (64 chars), PINADA no manifest do registry;
//   • a chave privada é 32 bytes em hex, LOCAL (~/.engine-signing/), e nunca entra em CI.
//
// Armadilhas do Node que este módulo encapsula (motivo de existir um módulo só para isto):
//   • `crypto.createSign()/createVerify()` NÃO suportam Ed25519 — só a API estática
//     `crypto.sign(null, ...)` / `crypto.verify(null, ...)`, com o 1º argumento OBRIGATORIAMENTE
//     `null` (passar 'ed25519' ou 'sha256' quebra);
//   • o Node não importa chave Ed25519 crua: exige DER. O envelope SPKI é um prefixo FIXO de
//     12 bytes + os 32 bytes crus. O PKCS8 privado é um prefixo fixo de 16 bytes + 32 crus.
//
// Contrato do kit: NUNCA lança na verificação — devolve { ok:false, reason } para o caller
// decidir (fail-loud em quem chama, não aqui). A assinatura (lado publisher) SIM lança: ali um
// erro tem de estourar na cara de quem publica.
import { createHash, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";
/** Algoritmos que o kit sabe verificar. Desconhecido = ABORT, nunca aceite silencioso. */
export const SUPPORTED_ALGORITHMS = ["ed25519-sha256-raw"];
export const DEFAULT_ALGORITHM = "ed25519-sha256-raw";

/** Envelope DER fixo de uma chave Ed25519 (RFC 8410): SPKI público e PKCS8 privado. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");   // 12 bytes + 32 crus
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // 16 bytes + 32 crus

const RAW_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

const isHexKey = (s) => /^[0-9a-fA-F]{64}$/.test(String(s ?? ""));

/** Converte a chave PÚBLICA hex (32 bytes) num KeyObject utilizável pelo `crypto.verify`. */
export function publicKeyFromHex(hex) {
  if (!isHexKey(hex)) {
    throw new Error(`chave pública Ed25519 inválida: esperado 64 chars hex (32 bytes), veio ${String(hex ?? "").length}`);
  }
  const raw = Buffer.from(hex, "hex");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Converte a chave PRIVADA hex (32 bytes) num KeyObject utilizável pelo `crypto.sign`. */
export function privateKeyFromHex(hex) {
  if (!isHexKey(hex)) {
    throw new Error(`chave privada Ed25519 inválida: esperado 64 chars hex (32 bytes), veio ${String(hex ?? "").length}`);
  }
  const raw = Buffer.from(hex, "hex");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** Gera um par novo. Devolve as duas metades em hex cru (32 bytes cada). */
export function generateKeyPairHex() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(SPKI_PREFIX.length);
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(PKCS8_PREFIX.length);
  if (pub.length !== RAW_KEY_BYTES || priv.length !== RAW_KEY_BYTES) {
    throw new Error(`envelope DER inesperado (pub=${pub.length}B, priv=${priv.length}B) — Node incompatível`);
  }
  return { publicKeyHex: pub.toString("hex"), privateKeyHex: priv.toString("hex") };
}

/** Deriva a chave PÚBLICA (hex cru) a partir da privada — para provar a assinatura aqui mesmo. */
export function publicKeyHexFromPrivateHex(privateKeyHex) {
  const pub = createPublicKey(privateKeyFromHex(privateKeyHex));
  return pub.export({ type: "spki", format: "der" }).subarray(SPKI_PREFIX.length).toString("hex");
}

/** LADO PUBLISHER: assina o SHA-256 do artefato. Devolve os 64 bytes crus do `.sig`. LANÇA em erro. */
export function signBlob(blob, privateKeyHex) {
  const key = privateKeyFromHex(privateKeyHex);
  const sig = edSign(null, createHash("sha256").update(blob).digest(), key);
  if (sig.length !== SIGNATURE_BYTES) {
    throw new Error(`assinatura com tamanho inesperado (${sig.length}B, esperado ${SIGNATURE_BYTES}B)`);
  }
  return sig;
}

/**
 * LADO CONSUMIDOR: verifica a assinatura de um artefato. FAIL-CLOSED — qualquer dúvida é `false`.
 * @returns {{ok:true} | {ok:false, reason:string}} nunca lança.
 */
export function verifyBlob(blob, signature, publicKeyHex, { algorithm = DEFAULT_ALGORITHM } = {}) {
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    return { ok: false, reason: `algoritmo de assinatura desconhecido "${algorithm}" (suportados: ${SUPPORTED_ALGORITHMS.join(", ")}) → ABORT` };
  }
  if (!isHexKey(publicKeyHex)) {
    return { ok: false, reason: "chave pública ausente/malformada no registry (esperado 64 chars hex) → ABORT" };
  }
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature ?? []);
  if (sig.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: `sidecar .sig com ${sig.length} bytes (esperado ${SIGNATURE_BYTES} crus, sem base64) → ABORT` };
  }
  try {
    const key = publicKeyFromHex(publicKeyHex);
    const digest = createHash("sha256").update(blob).digest();
    if (edVerify(null, digest, key, sig)) { return { ok: true }; }
    return { ok: false, reason: "assinatura Ed25519 NÃO confere — artefato não veio de quem detém a chave privada → ABORT" };
  } catch (e) {
    return { ok: false, reason: `verificação de assinatura falhou: ${e?.message || e} → ABORT` };
  }
}
