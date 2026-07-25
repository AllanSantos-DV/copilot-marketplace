// briefFile.mjs — leitura de um BRIEFING/PLANO/MATERIAL a partir de um CAMINHO DE ARQUIVO (o jeito do dono). Brief
// completo NÃO passa como parâmetro de tool (texto grande quebra: escaping de barra invertida, limite de tamanho,
// truncamento). A sessão ESCREVE o brief num arquivo (rastreável na pasta da sessão) e passa só o PATH; a mesa lê o
// arquivo por si. FAIL-LOUD: path dado mas inexistente/ilegível/vazio LANÇA (nunca cai calado no inline). `inline` é
// fallback EXPLÍCITO e SINALIZADO (p/ brief curto). Puro (só fs de leitura) e reusável por qualquer modo com brief.
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MAX_BYTES = 1_000_000; // 1MB — brief é TEXTO; guarda contra apontar pra binário/arquivo gigante por engano

/**
 * @param {{ path?:string, inline?:string, cwd?:string, label?:string, log?:Function }} o
 * @returns {string} o conteúdo do brief. LANÇA (FAIL-LOUD) se o path foi dado mas não deu pra ler, ou se nada veio.
 */
export function readBrief({ path, inline, cwd = process.cwd(), label = "briefing", log = () => {} } = {}) {
  const p = typeof path === "string" ? path.trim() : "";
  if (p) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (!existsSync(abs)) throw new Error(`${label}: arquivo NÃO encontrado no path '${p}' (resolvido: '${abs}'). Escreva o ${label} num arquivo da sessão e passe o CAMINHO.`);
    let st; try { st = statSync(abs); } catch (e) { throw new Error(`${label}: não deu pra ler '${abs}': ${e?.message || e}`); }
    if (!st.isFile()) throw new Error(`${label}: '${abs}' não é um arquivo.`);
    if (st.size > MAX_BYTES) throw new Error(`${label}: arquivo grande demais (${st.size}B > ${MAX_BYTES}B) — aponte pro texto do ${label}, não pra um binário.`);
    const text = readFileSync(abs, "utf8");
    if (!text.trim()) throw new Error(`${label}: o arquivo '${abs}' está VAZIO.`);
    log(`[brief] ${label} lido do arquivo: ${abs} (${text.length} chars)`);
    return text;
  }
  const t = typeof inline === "string" ? inline.trim() : "";
  if (t) { log(`[brief] AVISO: ${label} passado INLINE (${t.length} chars) — prefira o PATH de arquivo p/ brief grande (escaping/limite). Usando inline desta vez.`); return t; }
  throw new Error(`${label} ausente: passe o CAMINHO do arquivo com o ${label} (recomendado) — ou, só p/ texto curto, o inline.`);
}
