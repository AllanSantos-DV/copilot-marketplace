// Ordem topológica (Kahn) dos ids pelas relações {from,to} — fonte ÚNICA do builder
// (layout.mjs: detecção de fluxo linear; story.mjs: ordem dos passos). Só roda no Node.
// Ciclos/restos caem na ordem declarada, então nenhum id some.
export function topoOrder(ids, rels){
  const indeg = new Map(ids.map(i=>[i,0]));
  const adj = new Map(ids.map(i=>[i,[]]));
  for(const r of rels){ if(adj.has(r.from) && indeg.has(r.to)){ adj.get(r.from).push(r.to); indeg.set(r.to, indeg.get(r.to)+1); } }
  const q = ids.filter(i=>indeg.get(i)===0);
  const order=[], seen=new Set();
  while(q.length){ const n=q.shift(); if(seen.has(n)) continue; seen.add(n); order.push(n);
    for(const m of adj.get(n)){ indeg.set(m, indeg.get(m)-1); if(indeg.get(m)===0) q.push(m); } }
  for(const i of ids) if(!seen.has(i)) order.push(i);
  return order;
}
