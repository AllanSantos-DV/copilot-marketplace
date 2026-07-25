// EXTRATOR DE JSON robusto a saídas de modelo — fonte ÚNICA (DRY). Modelos costumam devolver o JSON
// VÁLIDO embrulhado em ```json ... ``` e cercado de prosa/tabela (rationale) ANTES e DEPOIS. O parser
// guloso /\{[\s\S]*\}/ pega do 1º "{" ao ÚLTIMO "}" — logo engole a tabela de rationale e QUEBRA um JSON
// que era válido. Aqui a estratégia é ordenada: (1) bloco cercado ```json; (2) primeiro objeto BALANCEADO
// (conta chaves, ciente de strings) — não vaza pra prosa depois do "}"; (3) fallback guloso (compat).
// Retorna o objeto ou null (o CALLER decide o fail-loud — mantém o "nao retornou JSON" onde já existe).

export function extractJson(text) {
  const s = String(text || "");
  const tries = [];

  // 1) bloco cercado ```json ... ``` (ou ``` ... ```) — o caso mais comum de "JSON válido + rationale".
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] && fence[1].trim()) tries.push(fence[1].trim());

  // 2) primeiro objeto BALANCEADO a partir do 1º "{" — ignora "{"/"}" dentro de strings; para no fecho real.
  const start = s.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { tries.push(s.slice(start, i + 1)); break; } }
    }
  }

  // 3) fallback guloso (comportamento antigo) — última tentativa.
  const greedy = s.match(/\{[\s\S]*\}/);
  if (greedy) tries.push(greedy[0]);

  for (const t of tries) { try { return JSON.parse(t); } catch { /* tenta a próxima estratégia */ } }
  return null;
}
