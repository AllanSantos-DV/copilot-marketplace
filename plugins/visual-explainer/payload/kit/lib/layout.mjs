// Auto-layout no BUILD (offline): o autor declara nodes + relations; o dagre
// calcula x/y (centro, convenção VXK) e as arestas viram geometria assada.
// Zero bytes no HTML — roda no Node e some. Opt-in por spec.layout.
import dagre from '@dagrejs/dagre';

// dimensões default por tipo (largura×altura em coords de mundo) p/ o dagre reservar espaço
function dims(n){
  if(n.w && n.h) return { w:n.w, h:n.h };
  switch(n.type){
    case 'box':        return { w:n.w||150, h:n.h||70 };
    case 'graphNode':  { const r=(n.r||34); return { w:2*r+40, h:2*r+30 }; } // +espaço p/ label externo
    case 'card':       return { w:n.w||230, h:n.h||130 };
    case 'chip':       return { w:n.w||150, h:44 };
    case 'browserIcon':case 'serverIcon':case 'dbIcon': { const s=(n.scale||1); return { w:150*s, h:120*s }; }
    default:           return { w:n.w||150, h:n.h||80 };
  }
}

// centro do node em coords de mundo (após layout)
function center(n){ return [n.x, n.y]; }

// clipa o ponto do centro de A em direção a B até a borda da caixa de A (retângulo meia-extensão)
function edgePoint(from, to, d){
  const dx=to[0]-from[0], dy=to[1]-from[1];
  if(dx===0 && dy===0) return from.slice();
  const hw=d.w/2, hh=d.h/2;
  const tx = dx!==0 ? hw/Math.abs(dx) : Infinity;
  const ty = dy!==0 ? hh/Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return [from[0]+dx*t, from[1]+dy*t];
}

// ordem topológica (chain) e detecção de fluxo quase-linear (path) p/ o modo wrap
function topoIds(ids, rels){
  const indeg=new Map(ids.map(i=>[i,0])), adj=new Map(ids.map(i=>[i,[]]));
  for(const r of rels){ if(adj.has(r.from)&&indeg.has(r.to)){ adj.get(r.from).push(r.to); indeg.set(r.to, indeg.get(r.to)+1); } }
  const q=ids.filter(i=>indeg.get(i)===0), order=[], seen=new Set();
  while(q.length){ const n=q.shift(); if(seen.has(n))continue; seen.add(n); order.push(n);
    for(const m of adj.get(n)){ indeg.set(m,indeg.get(m)-1); if(indeg.get(m)===0) q.push(m); } }
  for(const i of ids) if(!seen.has(i)) order.push(i);
  return order;
}
function isLinear(parts, rels){
  const indeg={}, outdeg={};
  for(const n of parts){ indeg[n.id]=0; outdeg[n.id]=0; }
  for(const r of rels){ if(outdeg[r.from]!=null) outdeg[r.from]++; if(indeg[r.to]!=null) indeg[r.to]++; }
  return parts.every(n=>indeg[n.id]<=1 && outdeg[n.id]<=1);
}

export function applyAutoLayout(spec){
  if(!spec || !spec.layout) return { applied:false };
  const cfg = (typeof spec.layout==='object') ? spec.layout : {};
  const rankdir = cfg.rankdir || 'LR';
  const nodesep = cfg.nodesep!=null ? cfg.nodesep : 70;
  const ranksep = cfg.ranksep!=null ? cfg.ranksep : 110;
  const edgeType = cfg.edgeType || 'arrow';         // 'arrow' (padrão) ou 'edge' (grafo com glow)

  const nodes = spec.nodes || (spec.nodes = []);
  const byId = new Map(nodes.map(n=>[n.id, n]));
  const rels = spec.relations || spec.edges || [];

  // 1) participantes do layout: quem tem id e não está fixado (fixed:true) nem é seta/edge/decor
  const skip = new Set(['arrow','edge','frame','banner']);
  const parts = nodes.filter(n => n.id && !n.fixed && !skip.has(n.type) && n.pin==null);
  if(!parts.length) return { applied:false };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep, ranksep, marginx:20, marginy:20, align:cfg.align });
  g.setDefaultEdgeLabel(()=>({}));
  const dimOf = new Map();
  for(const n of parts){ dimOf.set(n.id, dims(n)); }

  // MODO WRAP (serpentina): cadeia longa e quase-linear preenche a tela em 2D em vez de virar
  // uma fila fina. Auto-liga p/ paths com >=7 nós; explícito via layout.wrap (true ou nº de colunas).
  const wrap = cfg.wrap != null ? cfg.wrap : (parts.length >= 7 && isLinear(parts, rels));
  let gw, gh, placed = 0;
  if(wrap){
    const order = topoIds(parts.map(n=>n.id), rels);
    const cols = (typeof wrap === 'number' && wrap >= 2) ? wrap : Math.max(2, Math.min(5, Math.round(Math.sqrt(order.length * 1.3))));
    const colW = cfg.colW || 250, rowH = cfg.rowH || 165;
    order.forEach((id,i)=>{ const n=byId.get(id); const row=Math.floor(i/cols); let c=i%cols; if(row%2===1) c=cols-1-c; n.x=c*colW; n.y=row*rowH; });
    const xs=order.map(id=>byId.get(id).x), ys=order.map(id=>byId.get(id).y);
    const cxg=(Math.min(...xs)+Math.max(...xs))/2, cyg=(Math.min(...ys)+Math.max(...ys))/2;
    for(const id of order){ const n=byId.get(id); n.x=Math.round(n.x-cxg); n.y=Math.round(n.y-cyg); placed++; }
    gw=(Math.max(...xs)-Math.min(...xs))+colW; gh=(Math.max(...ys)-Math.min(...ys))+rowH;
  } else {
    for(const n of parts){ g.setNode(n.id, { width:dimOf.get(n.id).w, height:dimOf.get(n.id).h }); }
    for(const r of rels){ if(byId.has(r.from) && byId.has(r.to)) g.setEdge(r.from, r.to); }
    dagre.layout(g);
    gw = g.graph().width || 0; gh = g.graph().height || 0;
    const ox=gw/2, oy=gh/2;
    for(const n of parts){ const nd=g.node(n.id); if(nd){ n.x=Math.round(nd.x-ox); n.y=Math.round(nd.y-oy); placed++; } }
  }

  // 2b) fit-scaling (opt-out via fit:false): escala posições E tamanhos p/ caber em zoom 1,
  // sem tocar na casca. Grafos largos encolhem uniformemente; câmera segue em zoom 1.
  const fitW = cfg.fitW || 900, fitH = cfg.fitH || 520;
  let s = 1;
  if(cfg.fit !== false && (gw>fitW || gh>fitH)) s = Math.min(fitW/gw, fitH/gh);
  if(s < 1){
    for(const n of parts){
      n.x = Math.round(n.x*s); n.y = Math.round(n.y*s);
      const d = dimOf.get(n.id);
      if(n.type==='box'){ n.w = Math.round(d.w*s); n.h = Math.round(d.h*s); }
      else if(n.type==='graphNode'){ n.r = Math.round((n.r||34)*s); }
      else if(n.type==='browserIcon'||n.type==='serverIcon'||n.type==='dbIcon'||n.type==='card'||n.type==='chip'){ if(n.scale!=null) n.scale=+(n.scale*s).toFixed(3); else n.scale=+s.toFixed(3); }
      else { if(n.w) n.w=Math.round(n.w*s); if(n.h) n.h=Math.round(n.h*s); }
      dimOf.set(n.id, { w:d.w*s, h:d.h*s });   // arestas usam a dimensão já escalada
    }
  }

  // 3) gera uma aresta assada por relação (o autor não escreve x0/y0/x1/y1).
  //    SEM id de propósito: opacityOf() dá 1 a nós sem id -> a aresta é sempre
  //    visível (estrutura do grafo), não fica oculta pelo reveal por-passo.
  let generated=0;
  const relColor = cfg.edgeColor || spec.accent || '#5b8cff';
  const seen = new Set();
  for(const n of nodes){ if((n.type==='arrow'||n.type==='edge') && n.from && n.to) seen.add(n.from+'>'+n.to); }  // não duplica o que o autor já ligou
  for(const r of rels){
    const key=r.from+'>'+r.to; if(seen.has(key)) continue; seen.add(key);
    const A=byId.get(r.from), B=byId.get(r.to); if(!A||!B) continue;
    const cA=center(A), cB=center(B);
    const p0=edgePoint(cA,cB, dimOf.get(A.id)||{w:0,h:0});
    const p1=edgePoint(cB,cA, dimOf.get(B.id)||{w:0,h:0});
    const e = { type:edgeType,
      x0:Math.round(p0[0]), y0:Math.round(p0[1]), x1:Math.round(p1[0]), y1:Math.round(p1[1]),
      color:r.color||relColor };
    if(cfg.edgeFlow!==false){ e.flow=true; e.flowColor=r.color||relColor; }   // fluxo animado de graça em todo grafo/fluxo
    if(spec.story) e.id = '__edge_'+r.from+'_'+r.to;   // story mode: aresta ganha id p/ ser revelada junto do nó-alvo
    if(r.label) e.label=r.label;
    if(r.dashed) e.dashed=true;
    if(edgeType==='arrow') e.arrow=true;
    else if(r.arrow!==false) e.arrow=true;
    if(r.info) e.info=r.info;
    nodes.push(e); generated++;
  }

  // 4) resolve setas/edges EXPLÍCITAS que usaram from/to (autor listou o node, sem coords)
  for(const n of nodes){
    if((n.type==='arrow'||n.type==='edge') && n.from && n.to){
      const A=byId.get(n.from), B=byId.get(n.to); if(!A||!B) continue;
      const p0=edgePoint(center(A),center(B), dimOf.get(A.id)||{w:0,h:0});
      const p1=edgePoint(center(B),center(A), dimOf.get(B.id)||{w:0,h:0});
      n.x0=Math.round(p0[0]); n.y0=Math.round(p0[1]); n.x1=Math.round(p1[0]); n.y1=Math.round(p1[1]);
      delete n.from; delete n.to;
    }
  }

  return { applied:true, nodesPlaced:placed, edgesGenerated:generated, rankdir, gw, gh, fitScale:+s.toFixed(3) };
}
