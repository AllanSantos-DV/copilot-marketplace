/* DESIGN SYSTEM · "part" — uma PEÇA física de um aparelho, para VISTA EXPLODIDA de
   objetos com FORMA (não abstratos). Renderiza uma SILHUETA 2D flat (lista de formas:
   rect/polygon/polyline/circle/ellipse/line/path SVG) em coords locais ao centro. O
   centro interpola montado→explodido por `lift` (igual à `layer`), e um rótulo-pílula
   aparece à direita ao explodir. Clicável → painel. FLAT: fills sólidos, traços finos.
   params: { asmX,asmY, expX,expY, lift, shapes:[{kind,...,fill,stroke,strokeWidth,opacity}],
             artScale, label, sublabel, color, accent, textColor, info } */
VXK.register('part', {
  create(n){ return { p2d:new Map() }; },
  pos(n){ return VXK.liftCenter(n); },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, zoom=e.zoom, k=1/zoom;
    const [cx,cy]=VXK.liftCenter(n);
    const body=n.color||'#3a5a8c', accent=n.accent||n.iconColor||'#8ab4ff';
    const sc=(n.artScale!=null?n.artScale:1);
    const shapes=n.shapes||[];
    const resolve=(v,def)=>{ if(v==='none'||v===false) return null; if(v==null) return def; if(v==='tint') return accent; if(v==='body') return body; return v; };

    ctx.save(); ctx.translate(cx,cy); if(sc!==1) ctx.scale(sc,sc);
    const baseA=ctx.globalAlpha;                                        // respeita a opacidade de entrada (reveal/fade) do nó
    for(const sh of shapes){ if(!sh||!sh.kind) continue;
      const open=(sh.kind==='line'||sh.kind==='polyline');
      const fill = open ? null : resolve(sh.fill, body);
      const stroke = resolve(sh.stroke, open ? accent : M.rgba([238,243,255],0.34));
      const lw=(sh.strokeWidth!=null?sh.strokeWidth:1.4)*k;
      ctx.globalAlpha=baseA*(sh.opacity==null?1:sh.opacity);
      if(sh.kind==='path'){ let p=inst.p2d.get(sh.d); if(!p){ p=new Path2D(sh.d||''); inst.p2d.set(sh.d,p); }
        if(fill){ ctx.fillStyle=fill; ctx.fill(p); } if(stroke){ ctx.strokeStyle=selected?'#fff':stroke; ctx.lineWidth=lw; ctx.stroke(p); } }
      else { ctx.beginPath();
        if(sh.kind==='rect'){ const r=sh.rx||0; if(r>0) M.roundRectPath(ctx,sh.x,sh.y,sh.w,sh.h,Math.min(r,Math.abs(sh.w)/2,Math.abs(sh.h)/2)); else ctx.rect(sh.x,sh.y,sh.w,sh.h); }
        else if(sh.kind==='circle'){ ctx.arc(sh.cx||0,sh.cy||0,Math.abs(sh.r||0),0,6.2832); }
        else if(sh.kind==='ellipse'){ ctx.ellipse(sh.cx||0,sh.cy||0,Math.abs(sh.rx||0),Math.abs(sh.ry||0),0,0,6.2832); }
        else if(sh.kind==='line'){ ctx.moveTo(sh.x1,sh.y1); ctx.lineTo(sh.x2,sh.y2); }
        else if(sh.kind==='polygon'||sh.kind==='polyline'){ const p=sh.points||[]; if(p.length){ ctx.moveTo(p[0][0],p[0][1]); for(let i=1;i<p.length;i++) ctx.lineTo(p[i][0],p[i][1]); if(sh.kind==='polygon') ctx.closePath(); } }
        else { continue; }
        if(!open && fill){ ctx.fillStyle=fill; ctx.fill(); }
        if(stroke){ ctx.strokeStyle=selected?'#fff':stroke; ctx.lineWidth=lw; ctx.stroke(); }
      }
    }
    ctx.globalAlpha=1; ctx.restore();

    // rótulo-pílula à direita (fade-in ao explodir), ancorado na aresta direita da silhueta
    const lift=n.lift!=null?Math.max(0,Math.min(1,n.lift)):0, la=Math.max(0,Math.min(1,(lift-0.15)/0.5));
    if(la>0.02 && n.label){
      const bb=shapesBBox(shapes); const rightX=cx+(bb?bb[2]*sc:0)+18, midY=cy+(bb?((bb[1]+bb[3])/2)*sc:0);
      const baseA=ctx.globalAlpha, bx=rightX+6, by=cy;
      ctx.globalAlpha=baseA*la;
      ctx.strokeStyle=M.rgba(M.hex2rgb(accent),0.6); ctx.lineWidth=1.4*k;
      ctx.beginPath(); ctx.moveTo(cx+(bb?bb[2]*sc:0), midY); ctx.lineTo(bx-6, by); ctx.stroke();
      ctx.textAlign='left';
      M.type(ctx,'cardTitle',zoom); const tw=ctx.measureText(n.label).width;
      let sw=0; if(n.sublabel){ M.type(ctx,'sublabel',zoom); sw=ctx.measureText(n.sublabel).width; }
      const pw=Math.max(tw,sw)+24*k, ph=(n.sublabel?40:28)*k;
      M.roundRectPath(ctx, bx, by-ph/2, pw, ph, 8*k); ctx.fillStyle=M.rgba([16,23,38],0.86); ctx.fill();
      M.roundRectPath(ctx, bx, by-ph/2, pw, ph, 8*k); ctx.strokeStyle=M.rgba(M.hex2rgb(accent),0.4); ctx.lineWidth=1*k; ctx.stroke();
      ctx.fillStyle=n.textColor||M.ds.text.primary; ctx.textBaseline=n.sublabel?'alphabetic':'middle';
      M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label, bx+12*k, n.sublabel?by-3*k:by);
      if(n.sublabel){ M.type(ctx,'sublabel',zoom); ctx.fillStyle=M.ds.text.secondary; ctx.fillText(n.sublabel, bx+12*k, by+13*k); }
      ctx.globalAlpha=baseA; ctx.letterSpacing='0px'; ctx.textBaseline='alphabetic';
    }
  },
  hit(inst,n,wx,wy){
    const [cx,cy]=VXK.liftCenter(n), sc=(n.artScale!=null?n.artScale:1);
    const bb=shapesBBox(n.shapes||[]); if(!bb) return false;
    const lx=(wx-cx)/sc, ly=(wy-cy)/sc, pad=8;                          // slop p/ peças finas (só linha)
    return (lx>=bb[0]-pad&&lx<=bb[2]+pad&&ly>=bb[1]-pad&&ly<=bb[3]+pad)
      ? { label:n.label, info:n.info||n.sublabel, color:n.accent||'#8ab4ff' } : false;
  },
  bounds(n){
    const [cx,cy]=VXK.liftCenter(n), sc=(n.artScale!=null?n.artScale:1);
    const bb=shapesBBox(n.shapes||[]); if(!bb) return [cx-40,cy-20,cx+40,cy+20];
    return [cx+bb[0]*sc, cy+bb[1]*sc, cx+bb[2]*sc + (n.label? 140:0), cy+bb[3]*sc];
  }
});
function shapesBBox(shapes){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9, any=false;
  const put=(a,b,c,d)=>{ any=true; if(a<x0)x0=a; if(b<y0)y0=b; if(c>x1)x1=c; if(d>y1)y1=d; };
  for(const sh of (shapes||[])){ if(!sh||!sh.kind) continue;
    if(sh.kind==='rect'){ const x=sh.x||0,y=sh.y||0,w=sh.w||0,h=sh.h||0; put(Math.min(x,x+w),Math.min(y,y+h),Math.max(x,x+w),Math.max(y,y+h)); }
    else if(sh.kind==='circle'){ const cx=sh.cx||0,cy=sh.cy||0,r=Math.abs(sh.r||0); put(cx-r,cy-r,cx+r,cy+r); }
    else if(sh.kind==='ellipse'){ const cx=sh.cx||0,cy=sh.cy||0,rx=Math.abs(sh.rx||0),ry=Math.abs(sh.ry||0); put(cx-rx,cy-ry,cx+rx,cy+ry); }
    else if(sh.kind==='line'){ put(Math.min(sh.x1,sh.x2),Math.min(sh.y1,sh.y2),Math.max(sh.x1,sh.x2),Math.max(sh.y1,sh.y2)); }
    else if(sh.kind==='polygon'||sh.kind==='polyline'){ for(const p of (sh.points||[])) put(p[0],p[1],p[0],p[1]); }
    else if(sh.kind==='path' && Array.isArray(sh.bbox)&&sh.bbox.length===4){ put(sh.bbox[0],sh.bbox[1],sh.bbox[0]+sh.bbox[2],sh.bbox[1]+sh.bbox[3]); }
  }
  if(!any) return null;
  if(x1-x0<16){ const c=(x0+x1)/2; x0=c-8; x1=c+8; }                    // peça fina ganha extensão mínima
  if(y1-y0<16){ const c=(y0+y1)/2; y0=c-8; y1=c+8; }
  return [x0,y0,x1,y1];
}
