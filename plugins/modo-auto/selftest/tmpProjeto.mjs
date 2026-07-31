// tmpProjeto.mjs — diretórios temporários de teste que se APAGAM sozinhos.
//
// Por que existe: os smokes criam projetos git de mentira com `mkdtempSync` e nunca os removiam. Medi 633
// diretórios acumulados em `%TEMP%` — cada execução da suíte deixava mais um punhado, e alguns com repositórios
// git dentro. Teste que suja a máquina de quem roda é um defeito do teste, não um detalhe: quem instala o
// artefato e roda o selftest não deveria pagar isso.
//
// A remoção é registrada num `process.on("exit")` ÚNICO, então ela acontece mesmo quando o teste falha ou
// aborta no meio — que é justamente quando o lixo apareceria.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const criados = [];
let registrado = false;

/** Cria um diretório temporário que será removido ao fim do processo (inclusive em falha). */
export function tmpDir(prefixo = "modo-auto-teste-") {
  if (!registrado) {
    registrado = true;
    process.on("exit", () => {
      for (const d of criados) {
        // `force` cobre o já-removido; nada aqui pode lançar, senão o teardown mascara o resultado do teste.
        try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
      }
    });
  }
  const d = mkdtempSync(join(tmpdir(), prefixo));
  criados.push(d);
  return d;
}
