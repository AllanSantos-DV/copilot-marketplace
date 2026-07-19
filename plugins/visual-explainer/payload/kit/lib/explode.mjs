// PERFIL "explode" (vista explodida) — como o story mode, o autor declara SÓ o conteúdo
// (aparelho + camadas ordenadas + uma frase por camada) e o build gera a coreografia:
// montado → desmontar (camadas se afastam) → navegar/focar/narrar cada camada → remontar.
// Zero autoria de scenes/camera/reveal/focus. Opt-in via spec.explode. Flag iso por explicação.
// Roda no build. Câmera calculada aqui (viewport nominal), então NÃO usa autoframe.

const PALETTE = ['#3a5a8c','#4a6f7a','#57806a','#7a6f4a','#8a5a5a','#6a5a8a','#4a7a8a','#7a7a5a'];

export function buildExplodeScenes(spec){
  if(!spec.explode) return { applied:false };
  const cfg = (typeof spec.explode === 'object') ? spec.explode : {};
  const layers = spec.layers || [];
  if(!layers.length) return { applied:false };

  const iso = cfg.iso != null ? cfg.iso : !!spec.iso;
  const N = layers.length;
  const accent = spec.accent || '#5b8cff';
  const w = cfg.w || (iso ? 300 : 380);
  const h = cfg.h || (iso ? 150 : 46);
  const thickness = cfg.thickness || (iso ? 14 : 6);
  const physical = layers.some(L => Array.isArray(L.shapes) && L.shapes.length);   // peças com FORMA real
  const asmGap = cfg.asmGap != null ? cfg.asmGap : (physical ? 72 : (iso ? 30 : 46)); // físico: empilha as peças (centradas); NÃO 0 (colapsaria e esconderia)
  const expGap = cfg.expGap != null ? cfg.expGap : (physical ? 152 : (iso ? 150 : 96));
  const asmY = i => (i - (N-1)/2) * asmGap;
  const expY = i => (i - (N-1)/2) * expGap;

  // bbox local das formas de uma peça (mesmo cálculo do componente part)
  function shapesBBox(shapes){
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9, any=false; const put=(a,b,c,d)=>{ any=true; if(a<x0)x0=a; if(b<y0)y0=b; if(c>x1)x1=c; if(d>y1)y1=d; };
    for(const sh of (shapes||[])){ if(!sh||!sh.kind) continue;
      if(sh.kind==='rect'){ const x=sh.x||0,y=sh.y||0,ww=sh.w||0,hh=sh.h||0; put(Math.min(x,x+ww),Math.min(y,y+hh),Math.max(x,x+ww),Math.max(y,y+hh)); }
      else if(sh.kind==='circle'){ const c=sh.cx||0,d=sh.cy||0,r=Math.abs(sh.r||0); put(c-r,d-r,c+r,d+r); }
      else if(sh.kind==='ellipse'){ const c=sh.cx||0,d=sh.cy||0,rx=Math.abs(sh.rx||0),ry=Math.abs(sh.ry||0); put(c-rx,d-ry,c+rx,d+ry); }
      else if(sh.kind==='line'){ put(Math.min(sh.x1,sh.x2),Math.min(sh.y1,sh.y2),Math.max(sh.x1,sh.x2),Math.max(sh.y1,sh.y2)); }
      else if(sh.kind==='polygon'||sh.kind==='polyline'){ for(const p of (sh.points||[])) put(p[0],p[1],p[0],p[1]); }
      else if(sh.kind==='path' && Array.isArray(sh.bbox)&&sh.bbox.length===4){ put(sh.bbox[0],sh.bbox[1],sh.bbox[0]+sh.bbox[2],sh.bbox[1]+sh.bbox[3]); }
    }
    if(!any) return [-40,-20,40,20];
    if(x1-x0<16){ const c=(x0+x1)/2; x0=c-8; x1=c+8; }            // peça fina (só linha) ganha extensão mínima p/ enquadrar
    if(y1-y0<16){ const c=(y0+y1)/2; y0=c-8; y1=c+8; }
    return [x0,y0,x1,y1];
  }
  function localBox(L){                                                    // extensão local (relativa ao centro) da peça/placa
    if(Array.isArray(L.shapes) && L.shapes.length){ const s=(L.artScale!=null?L.artScale:1), b=shapesBBox(L.shapes); return [b[0]*s,b[1]*s,b[2]*s,b[3]*s]; }
    if(iso){ const w2=w/2,h2=h/2,HX=0.9,HY=0.46, sx=(w2+h2)*HX, sy=(w2+h2)*HY; return [-sx,-sy,sx,sy+thickness]; }
    return [-w/2,-h/2,w/2,h/2];
  }

  const used = new Set();                                                // IDs únicos (evita alias e a chave reservada "duration")
  const uniqId = (want,i) => { let id=(want && want!=='duration') ? want : ('lyr'+i);
    let k=1; while(used.has(id) || id==='duration'){ id='lyr'+i+'_'+(k++); } used.add(id); return id; };
  const nodes = layers.map((L,i) => {
    const hasArt = Array.isArray(L.shapes) && L.shapes.length;
    const base = { id: uniqId(L.id, i), asmX:0, asmY: asmY(i), expX:0, expY: expY(i), lift:0,
      label: L.label || L.id, sublabel: L.sublabel || '',
      color: L.color || PALETTE[i % PALETTE.length], accent: L.accent || accent,
      info: L.info || L.say || L.sublabel || '' };
    return hasArt
      ? { type:'part', ...base, shapes: L.shapes, artScale: L.artScale }
      : { type:'layer', ...base, w, h, thickness, iso: !!iso, icon: L.icon };
  });
  spec.nodes = (spec.nodes || []).concat(nodes);
  const ids = nodes.map(n => n.id);

  // --- enquadramento (viewport nominal, como story.recap) ---
  const VW = 1040, VH = 720, FILL = 0.82;
  function layerBBox(i, exploded){
    const cy = exploded ? expY(i) : asmY(i), b = localBox(layers[i]);
    return [ b[0], cy+b[1], b[2] + (layers[i].label ? 150 : 0), cy+b[3] ];  // +espaço p/ o rótulo à direita
  }
  function stackBBox(exploded){
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for(let i=0;i<N;i++){ const b=layerBBox(i,exploded); if(b[0]<x0)x0=b[0]; if(b[1]<y0)y0=b[1]; if(b[2]>x1)x1=b[2]; if(b[3]>y1)y1=b[3]; }
    return [x0,y0,x1,y1];
  }
  function fit(b){
    const bw=Math.max(1,b[2]-b[0]), bh=Math.max(1,b[3]-b[1]);
    let z=FILL*Math.min(VW/bw, VH/bh); z=Math.max(0.35, Math.min(1.7, z));
    return { cx: Math.round((b[0]+b[2])/2), cy: Math.round((b[1]+b[3])/2), zoom:+z.toFixed(3) };
  }

  const steps = [];
  // 1) montado
  { const c=fit(stackBBox(false));
    steps.push({ id:'montado', title: cfg.assembledTitle || spec.device || 'Montado',
      narration: spec.intro || cfg.intro || '',
      camera:{ cx:c.cx, cy:c.cy, zoom:c.zoom, duration:0.7 }, fit:false,
      reveal: ids.slice(), focus: [] }); }
  // 2) desmontar (lift 0->1 de todas)
  { const c=fit(stackBBox(true)); const anim={}; ids.forEach(id=>anim[id]={lift:1}); anim.duration=1.1;
    steps.push({ id:'explodir', title: cfg.explodeTitle || 'Desmontando as camadas',
      narration: cfg.explodeSay || 'Vamos separar as camadas, como quem desmonta o aparelho, para ver cada peça por dentro.',
      camera:{ cx:c.cx, cy:c.cy, zoom:c.zoom, duration:0.9 }, fit:false,
      reveal: ids.slice(), focus: [], animate: anim }); }
  // 3) por camada: navega + foca + narra (as demais seguem explodidas e esmaecidas)
  layers.forEach((L,i) => {
    const c=fit(layerBBox(i,true));
    const st={ id:'lyr_'+i, title: L.label || L.id, narration: L.say || L.narration || '',
      camera:{ cx:c.cx, cy:c.cy, zoom:c.zoom, duration:0.6 }, fit:false,
      reveal: ids.slice(), focus: [ids[i]] };
    if(L.tag) st.annotate=[{ target:ids[i], text:L.tag, side:L.tagSide||'top', color:L.tagColor||accent }];
    steps.push(st);
  });
  // 4) remonta (recap)
  { const c=fit(stackBBox(false)); const anim={}; ids.forEach(id=>anim[id]={lift:0}); anim.duration=1.2;
    steps.push({ id:'remonta', title: cfg.recapTitle || 'Tudo junto de novo',
      narration: spec.outro || cfg.outro || 'E, remontando, cada camada volta ao seu lugar — agora você sabe o que cada uma faz.',
      camera:{ cx:c.cx, cy:c.cy, zoom:c.zoom, duration:0.9 }, fit:false,
      reveal: ids.slice(), focus: [], animate: anim }); }

  spec.scenes = [{ id:'explode', title: spec.title || '', steps }];
  return { applied:true, layers:N, iso:!!iso, steps: steps.length };
}
