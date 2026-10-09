// engine-kit/keystore.mjs — ONDE moram as chaves privadas de assinatura nesta máquina.
//
// Módulo separado de propósito: `gen-key.mjs` e `sign.mjs` são CLIs (executam ao serem
// carregados). Se um importasse o outro só para reaproveitar o caminho da chave, o CLI do outro
// dispararia junto. O caminho é dado — vive num módulo sem efeito colateral.
//
// Uma chave POR MOTOR: o raio de explosão de um vazamento é um motor, não a casa toda.
//
// OVERRIDE por ambiente: `ENGINE_SIGNING_KEY_<MOTOR>` (hífens viram `_`, tudo em maiúsculas).
// Existe por um motivo concreto: a chave do `vox-engine` já vive em
// `~/.action/signing/vox_engine_ed25519_private.key` e a PÚBLICA dela está pinada em mais de dez
// cópias vendorizadas do SDK, espalhadas por outros repositórios. Mover o arquivo por estética
// arriscaria invalidar todas elas. O padrão da casa continua sendo `~/.engine-signing/`; o
// override é a porta de entrada para as chaves que já existiam antes dele.
import { join } from "node:path";
import { homedir } from "node:os";

export const SIGNING_DIR = join(homedir(), ".engine-signing");

/** Nome da variável de ambiente que sobrescreve o caminho da chave de um motor. */
export const envVarFor = (engine) => `ENGINE_SIGNING_KEY_${String(engine).replace(/-/g, "_").toUpperCase()}`;

/** Caminho canônico da chave privada de um motor (respeita o override por ambiente). */
export function keyPathFor(engine) {
  const override = process.env[envVarFor(engine)];
  if (override && override.trim()) { return override.trim(); }
  return join(SIGNING_DIR, `${engine}_ed25519_private.key`);
}

