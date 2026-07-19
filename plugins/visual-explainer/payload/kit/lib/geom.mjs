// kit/lib/geom.mjs — geometria PURA do VXK (sem canvas, sem I/O). FONTE ÚNICA.
//
// HEXAGONAL: núcleo agnóstico consumido por DOIS adapters:
//   • BUILD-TIME (Node): `import { shapesBBox } from './geom.mjs'`  (ex.: explode.mjs)
//   • RUNTIME  (browser): o builder inlina este arquivo como `window.VXK.geom`
//     ANTES dos componentes; shape.js / layer.js / part.js usam `VXK.geom.*`.
//
// Superset das 3 cópias que existiam (part.js, explode.mjs, shape.js): mesmos
// resultados para specs válidas, com guards mais robustos (num) e suporte a text/path.

// ray-casting even-odd. Idêntico ao que estava duplicado em shape.js e layer.js.
export function pointInPoly(pts, x, y){
  let ins = false;
  for(let i=0, j=pts.length-1; i<pts.length; j=i++){
    const xi=pts[i][0], yi=pts[i][1], xj=pts[j][0], yj=pts[j][1];
    if(((yi>y) !== (yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-12) + xi)) ins = !ins;
  }
  return ins;
}

const _num = (v,d)=> (typeof v==='number' && isFinite(v)) ? v : d;

// bounds locais de UMA forma [minX,minY,maxX,maxY] ou null. Superset de shape.js.boundsOf
// + part/explode (que ignoravam text): aqui text/path entram, guards por num().
export function shapeBounds(sh){
  if(!sh || !sh.kind) return null;
  switch(sh.kind){
    case 'circle':  { const cx=_num(sh.cx,0), cy=_num(sh.cy,0), r=Math.abs(_num(sh.r,0)); return [cx-r,cy-r,cx+r,cy+r]; }
    case 'ellipse': { const cx=_num(sh.cx,0), cy=_num(sh.cy,0), rx=Math.abs(_num(sh.rx,0)), ry=Math.abs(_num(sh.ry,0)); return [cx-rx,cy-ry,cx+rx,cy+ry]; }
    case 'rect':    { const x=_num(sh.x,0), y=_num(sh.y,0), w=_num(sh.w,0), h=_num(sh.h,0); return [Math.min(x,x+w),Math.min(y,y+h),Math.max(x,x+w),Math.max(y,y+h)]; }
    case 'line':    { const x1=_num(sh.x1,0), y1=_num(sh.y1,0), x2=_num(sh.x2,0), y2=_num(sh.y2,0); return [Math.min(x1,x2),Math.min(y1,y2),Math.max(x1,x2),Math.max(y1,y2)]; }
    case 'polyline':
    case 'polygon': { const p=sh.points||[]; if(!p.length) return null; let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const pt of p){ a=Math.min(a,pt[0]); b=Math.min(b,pt[1]); c=Math.max(c,pt[0]); d=Math.max(d,pt[1]); } return [a,b,c,d]; }
    case 'text':    { const x=_num(sh.x,0), y=_num(sh.y,0), s=_num(sh.size,14), w=String(sh.text||'').length*s*0.58;
                      let x0=x; if(sh.align==='center') x0=x-w/2; else if(sh.align==='right') x0=x-w;
                      let y0=y-s*0.8, y1=y+s*0.25; if(sh.baseline==='middle'){ y0=y-s*0.5; y1=y+s*0.5; } else if(sh.baseline==='top'){ y0=y; y1=y+s; }
                      return [x0,y0,x0+w,y1]; }
    case 'path':    { const bb=sh.bbox; if(Array.isArray(bb) && bb.length===4) return [bb[0],bb[1],bb[0]+bb[2],bb[1]+bb[3]]; return null; }
    default: return null;
  }
}

// bbox agregada de VÁRIAS formas [x0,y0,x1,y1]. Opções:
//   minExtent>0 : garante extensão mínima (peça fina/linha ganha corpo p/ enquadrar)  — usado por part/explode
//   empty       : valor de retorno quando NADA contribui (default null; explode usa [-40,-20,40,20])
export function shapesBBox(shapes, opts){
  const minExtent = (opts && opts.minExtent) || 0;
  const empty = (opts && 'empty' in opts) ? opts.empty : null;
  const skipText = !!(opts && opts.skipText);          // chamadores FÍSICOS (part/explode) não desenham text → não enquadram texto invisível
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity, any=false;
  for(const sh of (shapes||[])){
    if(skipText && sh && sh.kind==='text') continue;
    const b = shapeBounds(sh); if(!b) continue;
    any=true; if(b[0]<x0)x0=b[0]; if(b[1]<y0)y0=b[1]; if(b[2]>x1)x1=b[2]; if(b[3]>y1)y1=b[3];
  }
  if(!any) return empty;
  if(minExtent>0){
    if(x1-x0<minExtent){ const c=(x0+x1)/2, h=minExtent/2; x0=c-h; x1=c+h; }
    if(y1-y0<minExtent){ const c=(y0+y1)/2, h=minExtent/2; y0=c-h; y1=c+h; }
  }
  return [x0,y0,x1,y1];
}
