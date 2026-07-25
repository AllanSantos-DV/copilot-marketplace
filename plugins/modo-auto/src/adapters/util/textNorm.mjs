// contentText() + norm() — normalização de conteúdo de eventos e de texto, compartilhada pelos filtros de
// transcript. `contentText` achata o `data.content` de um evento (string | array de partes | {text}) num
// texto plano; `norm` normaliza quebras (CRLF→LF), apara espaço-antes-de-quebra e trim. DRY: extraído das
// cópias idênticas que viviam em plan/transcript.mjs e shadow/shadowTranscript.mjs. Puro, sem I/O.

export function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : ""))).join("");
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

export function norm(s) { return String(s || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim(); }
