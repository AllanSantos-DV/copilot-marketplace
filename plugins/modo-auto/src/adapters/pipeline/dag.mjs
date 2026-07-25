// DAG de fases — o CÉREBRO do fatiador. Dado o conjunto de fases + as dependências REAIS entre elas,
// produz GRUPOS de execução: cada grupo roda em PARALELO (fases independentes), grupos em sequência.
// Nivelamento topológico (Kahn por níveis). FAIL LOUD: fase duplicada, dependência p/ fase inexistente
// ou CICLO → LANÇA. Nunca "resolve" chutando ordem (ordem errada quebra o build). Puro/testável (sem I/O).

// Normaliza a entrada em ids de fase (aceita "fase-1" ou { id, ... }).
function toIds(phases) {
  const ids = (phases || []).map((p) => (typeof p === "string" ? p : p && p.id)).filter(Boolean).map(String);
  if (!ids.length) throw new Error("dag: nenhuma fase");
  if (new Set(ids).size !== ids.length) throw new Error("dag: fases duplicadas em " + JSON.stringify(ids));
  return ids;
}

/**
 * @param {(string|{id:string})[]} phases  as fases do plano
 * @param {Record<string,string[]>} [deps]  fase → fases das quais depende (dados/arquivos/ordem)
 * @returns {{ groups: string[][], maxWidth: number, parallel: boolean, sequential: boolean }}
 */
export function buildGroups(phases, deps = {}) {
  const ids = toIds(phases);
  const set = new Set(ids);
  const need = {};
  for (const id of ids) {
    const ds = (deps[id] || []).map(String);
    for (const d of ds) {
      if (!set.has(d)) throw new Error(`dag: fase "${id}" depende de fase inexistente "${d}"`);
      if (d === id) throw new Error(`dag: fase "${id}" depende de si mesma`);
    }
    need[id] = new Set(ds);
  }
  const done = new Set();
  const groups = [];
  let remaining = [...ids];
  while (remaining.length) {
    const ready = remaining.filter((id) => [...need[id]].every((d) => done.has(d)));
    if (!ready.length) throw new Error(`dag: ciclo de dependência entre [${remaining.join(", ")}]`);
    groups.push(ready);
    for (const id of ready) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  const widths = groups.map((g) => g.length);
  const maxWidth = Math.max(...widths);
  return { groups, maxWidth, parallel: maxWidth > 1, sequential: widths.every((n) => n === 1) };
}
