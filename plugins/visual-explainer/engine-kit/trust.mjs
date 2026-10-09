// engine-kit/trust.mjs — RAIZ DE CONFIANÇA local (fecha a circularidade do publicKey).
//
// O problema real: a `publicKey` que valida a assinatura vinha do MESMO `manifest.json` que o kit
// baixa. Quem controla o repo troca o `.tgz`, o `.sig` **e** a chave — e o fail-closed aprova
// tudo, porque as três coisas vêm da mesma origem. Integridade sem raiz de confiança externa é
// uma tranca cuja chave está pendurada na porta.
//
// O que isto resolve (e o que NÃO resolve, dito na cara):
//   • RESOLVE — troca de chave DEPOIS da primeira instalação (repo comprometido, release
//     substituída, rollback com chave nova): a chave fica gravada localmente na primeira vez
//     (TOFU) e qualquer divergência posterior é ABORT, não aviso.
//   • RESOLVE — pin explícito: o consumidor pode passar a chave que ele confia (`trustedKeys`),
//     e aí nem a primeira instalação depende do manifest. É o padrão do vox-engine (chave
//     embutida no consumidor) trazido para cá, sem obrigar todo consumidor a adotá-lo.
//   • NÃO RESOLVE — comprometimento ANTERIOR ao primeiro contato: se o repo já estava tomado na
//     primeira instalação, o TOFU grava a chave do atacante. Só transparência pública (Sigstore/
//     TUF) fecha isso, e essa é decisão de produto — está registrada, não esquecida.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Lido a CADA chamada, não no import: assim um teste (ou um consumidor com HOME próprio) pode
// isolar a raiz de confiança sem depender da ordem de carregamento dos módulos. Foi a própria
// suíte que expôs isto — o motor-fake do teste de assinatura gera chave nova a cada execução e
// ficava preso na confiança da execução anterior.
const trustDir = () => process.env.ENGINE_KIT_HOME || join(homedir(), ".engine-kit");
const trustFile = () => join(trustDir(), "trust.json");

function readTrust() {
  try {
    const v = JSON.parse(readFileSync(trustFile(), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Confronta a chave que veio do registry com a raiz de confiança local.
 * @returns {{ok:true, tofu:boolean} | {ok:false, reason:string}} nunca lança.
 */
export function checkTrust(engineName, publicKey, { trustedKeys } = {}) {
  const pinned = trustedKeys?.[engineName];
  if (pinned && pinned !== publicKey) {
    return { ok: false, reason: `${engineName}: chave do registry ≠ chave FIXADA pelo consumidor → ABORT (registry pode estar comprometido)` };
  }

  const store = readTrust();
  const known = store[engineName]?.publicKey;
  if (known && known !== publicKey) {
    return {
      ok: false,
      reason:
        `${engineName}: a chave pública MUDOU desde a primeira instalação → ABORT. ` +
        `Rotação legítima exige apagar a entrada em ${trustFile()} de propósito; ` +
        `se você não rotacionou, o registry pode estar comprometido.`,
    };
  }
  if (known) return { ok: true, tofu: false };

  try {
    mkdirSync(trustDir(), { recursive: true });
    store[engineName] = { publicKey, firstSeen: new Date().toISOString(), source: pinned ? "pinned" : "tofu" };
    writeFileSync(trustFile(), JSON.stringify(store, null, 2));
  } catch {
    // Não poder gravar a raiz não pode impedir a instalação — mas também não vira silêncio:
    // sem gravar, a próxima execução repete o TOFU (e o consumidor vê `tofu:true` de novo).
  }
  return { ok: true, tofu: true };
}

export const trustPath = () => trustFile();
