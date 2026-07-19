// Auto-coreografia (STORY MODE): o autor declara nodes + relations + uma frase por nó (`say`);
// o build gera scenes[].steps[] — walk topológico, revela CUMULATIVO (build-up), foca cada nó,
// e um passo final de recap. Roda DEPOIS do applyAutoLayout (precisa de x/y). Opt-in via spec.story.
// Zero autoria de camera/reveal/focus pelo autor: ele escreve só conteúdo + narração por nó.

function topoOrder(ids, rels){
  const indeg = new Map(ids.map(i=>[i,0]));
  const adj = new Map(ids.map(i=>[i,[]]));
  for(const r of rels){ if(adj.has(r.from) && indeg.has(r.to)){ adj.get(r.from).push(r.to); indeg.set(r.to, indeg.get(r.to)+1); } }
  const q = ids.filter(i=>indeg.get(i)===0);
  const order=[], seen=new Set();
  while(q.length){ const n=q.shift(); if(seen.has(n)) continue; seen.add(n); order.push(n);
    for(const m of adj.get(n)){ indeg.set(m, indeg.get(m)-1); if(indeg.get(m)===0) q.push(m); } }
  for(const i of ids) if(!seen.has(i)) order.push(i);   // ciclos/restos: cai na ordem declarada
  return order;
}

export function buildStorySteps(spec){
  if(!spec || !spec.story) return { applied:false };
  if(Array.isArray(spec.scenes) && spec.scenes.length) return { applied:false };   // autor já coreografou à mão
  const cfg = (typeof spec.story==='object') ? spec.story : {};
  const nodes = (spec.nodes||[]).filter(n=>n.id && n.type!=='arrow' && n.type!=='edge');
  const rels = spec.relations || spec.edges || [];
  if(!nodes.length) return { applied:false };
  const byId = new Map(nodes.map(n=>[n.id,n]));
  const order = topoOrder(nodes.map(n=>n.id), rels);
  const focusZoom = cfg.focusZoom || 1.8;
  const accent = spec.accent || '#5b8cff';
  const eid = (a,b)=>'__edge_'+a+'_'+b;

  const revealed = new Set(), revEdges = new Set();
  const steps = [];
  const pop = cfg.pop !== false;                          // "pop" de entrada dos nós (escala) — ligado por padrão
  for(const id of order){
    const n = byId.get(id); revealed.add(id);
    if(pop && n.scale==null) n.scale = 0.86;              // nasce menor; a revelação anima até 1 (só visível no momento em que aparece)
    const newEdges = [];                                  // revela uma aresta quando AMBAS as pontas já apareceram
    for(const r of rels){ const k=eid(r.from,r.to); if(!revEdges.has(k) && revealed.has(r.from) && revealed.has(r.to)){ revEdges.add(k); newEdges.push(k); } }
    const step = {
      id, title: n.title || n.label || id,
      narration: n.say || n.narration || '',
      camera: { cx: n.x||0, cy: n.y||0, zoom: focusZoom, duration: 0.55 },
      reveal: [id, ...newEdges],
      focus: [id]
    };
    if(pop) step.animate = { [id]: { scale: 1 }, duration: 0.5 };   // pop 0.86 -> 1 ao entrar
    if(n.tag) step.annotate = [{ target:id, text:n.tag, side: n.tagSide || cfg.annotSide || 'top', color: n.tagColor || accent }];
    steps.push(step);
  }
  // recap final: tudo visível, câmera PREENCHE a tela (sem zoom-out expressivo), sem anotações
  const allEdges = rels.map(r=>eid(r.from,r.to));
  const bnodes = nodes.filter(n=>n.id && n.type!=='arrow' && n.type!=='edge');
  let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
  for(const n of bnodes){ const w=(n.w||150), h=(n.h||70), x=n.x||0, y=n.y||0;
    minx=Math.min(minx,x-w/2); maxx=Math.max(maxx,x+w/2); miny=Math.min(miny,y-h/2); maxy=Math.max(maxy,y+h/2); }
  const bw=Math.max(1,maxx-minx), bh=Math.max(1,maxy-miny), cxr=(minx+maxx)/2, cyr=(miny+maxy)/2;
  let fill = Math.min(1000*0.92/bw, 600*0.92/bh); fill = Math.max(0.85, Math.min(1.6, fill));   // enche ~92% da área
  const recapZoom = cfg.fitZoom != null ? cfg.fitZoom : +fill.toFixed(3);
  steps.push({
    id:'ciclo', title: cfg.cicloTitle || 'Visão completa',
    narration: spec.outro || cfg.outro || '',
    camera: { cx: Math.round(cxr), cy: Math.round(cyr), zoom: recapZoom, duration:0.7 },
    reveal: nodes.map(n=>n.id).concat(allEdges),
    focus: nodes.map(n=>n.id)
  });
  spec.scenes = [{ id:'story', title: spec.title||'', steps }];
  return { applied:true, steps: steps.length };
}
