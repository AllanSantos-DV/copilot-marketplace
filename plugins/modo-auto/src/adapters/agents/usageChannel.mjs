// usageChannel.mjs — LEITOR do canal de custo no stderr do worker (ponto de junção worker→pai). O worker emite UMA
// linha `\x1e#USAGE {json}\n` no stderr com o usage do turno; o resto do stderr é erro visível. DESVIO DOCUMENTADO
// do plano: o plano dizia `\x1e{json}\n` (sem marcador); usamos o PREFIXO `#USAGE ` de propósito para DESAMBIGUAR a
// linha de custo de QUALQUER outra linha de stderr (stack de erro, warning de npm) — sem o prefixo, um erro que por
// acaso começasse com `{` seria mal-interpretado como usage. É um desvio seguro e mínimo. Este montador de linhas é
// TOLERANTE ao que o painel profundo exigiu provar: (1) CHUNK FRAGMENTADO — o JSON pode ser cortado no meio entre
// dois chunks do stream (o buffer persiste entre `feed`); (2) CRLF do Windows — tira o \r final antes do parse
// (senão JSON.parse explode em 100% dos casos no OS primário); (3) bytes de HEARTBEAT `\x1e` intercalados
// (atividade) — são removidos. FAIL-LOUD: JSON inválido → onUsage NÃO é chamado + log (não crash, não usage fake).
// Puro/testável (sem I/O): recebe chunks via feed(), separa custo (onUsage) de texto de erro (onText).

const USAGE_RE = /^#USAGE (.*)$/;

export function createUsageChannel({ onUsage = () => {}, onText = () => {}, log = () => {} } = {}) {
  let buf = "";

  function emitLine(raw) {
    const line = raw.replace(/\r$/, "").replace(/\x1e/g, ""); // CRLF (Windows) + heartbeat bytes → fora
    const m = USAGE_RE.exec(line);
    if (m) { try { const u = JSON.parse(m[1]); if (u && typeof u === "object") onUsage(u); } catch (e) { log(`[usage] parse falhou (SINALIZADO, não crash): ${String(e?.message || e).slice(0, 120)}`); } return; }
    if (line) onText(line); // resto = erro real do worker (linha a linha, sem heartbeat)
  }

  return {
    // alimenta um chunk do stderr; processa TODAS as linhas completas, guarda o resto parcial no buffer.
    feed(chunk) {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { const raw = buf.slice(0, nl); buf = buf.slice(nl + 1); emitLine(raw); }
    },
    // esvazia o resto SEM \n final (texto de erro sem newline, ou usage na última linha) — chamar no close.
    flush() { if (buf) { emitLine(buf); buf = ""; } },
  };
}
