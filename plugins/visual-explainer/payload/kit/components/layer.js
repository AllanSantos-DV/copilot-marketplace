/* DESIGN SYSTEM · "layer" — uma CAMADA/placa de um aparelho, para VISTA EXPLODIDA.
   Renderiza FLAT (placa chapada vista de frente) ou ISO (placa isométrica flat-shaded:
   topo + 2 faces laterais sólidas, sem gradiente). O centro interpola da posição
   MONTADA (asmX/asmY) para a EXPLODIDA (expX/expY) por `lift` (0..1, animável) — é o
   "desmontar". Um rótulo-pílula aparece à direita conforme explode. Clicável → painel.
   params: { asmX,asmY, expX,expY, lift, w, h, thickness, iso, label, sublabel, icon,
             color, accent, textColor, info } */
VXK.register('layer', {
  create(n){ return {}; },
  pos(n){ return VXK.liftCenter(n); },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, zoom=e.zoom, k=1/zoom;
    const [cx,cy]=VXK.liftCenter(n);
    const w=(n.w!=null?n.w:300), h=(n.h!=null?n.h:150);
    const lift=n.lift!=null?Math.max(0,Math.min(1,n.lift)):0;
    const col=n.color||'#2b3f66', rgb=M.hex2rgb(col), acc=n.accent||n.iconColor||'#8ab4ff';

    if(n.iso){
      // isométrico flat-shaded: projeta o footprint w×h; extruda `thickness` p/ baixo
      const HX=0.9, HY=0.46, th=(n.thickness!=null?n.thickness:16);
      const w2=w/2, h2=h/2;
      const P=(u,v)=>[cx+(u-v)*HX, cy+(u+v)*HY];
      const Tb=P(-w2,-h2), Tr=P(w2,-h2), Tf=P(w2,h2), Tl=P(-w2,h2);   // topo: back/right/front/left
      const down=(p)=>[p[0],p[1]+th];
      // faces laterais (frente-direita e frente-esquerda), sólidas e mais escuras
      const rface=[Tr,Tf,down(Tf),down(Tr)], lface=[Tl,Tf,down(Tf),down(Tl)];
      const poly=(pts,fill,strokeA)=>{ ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]); for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]); ctx.closePath();
        ctx.fillStyle=fill; ctx.fill(); if(strokeA!=null){ ctx.strokeStyle=M.rgba([255,255,255],strokeA); ctx.lineWidth=1*k; ctx.stroke(); } };
      poly(lface, M.rgba(M.shade(rgb,-0.26),1), 0.06);
      poly(rface, M.rgba(M.shade(rgb,-0.15),1), 0.06);
      poly([Tb,Tr,Tf,Tl], col, 0);                                     // topo (cor cheia)
      ctx.beginPath(); ctx.moveTo(Tb[0],Tb[1]); ctx.lineTo(Tr[0],Tr[1]); ctx.lineTo(Tf[0],Tf[1]); ctx.lineTo(Tl[0],Tl[1]); ctx.closePath();
      ctx.strokeStyle=selected?'#fff':M.rgba([238,243,255],0.34); ctx.lineWidth=(selected?1.8:1.1)*k; ctx.stroke();
      // barra de accent no topo (aresta de trás)
      ctx.strokeStyle=acc; ctx.lineWidth=2.4*k; ctx.beginPath(); ctx.moveTo(Tb[0],Tb[1]); ctx.lineTo(Tr[0],Tr[1]); ctx.stroke();
      const hasIcon=n.icon && VXK.drawIcon && VXK.hasIcon && VXK.hasIcon(n.icon);
      if(hasIcon){ const isz=Math.max(20,Math.min(h*0.4,34)); M.iconChip(ctx, cx, cy+ (th? th*0.2:0), isz, n.icon, acc, zoom); }
    } else {
      // FLAT: placa vista de frente (rounded rect chapado + hairline + fina aresta de placa)
      const L=cx-w/2, T=cy-h/2, rad=Math.min(12, w/2, h/2);
      M.card(ctx, L, T, w, h, { zoom, radius:rad, fill:col, selected, accent:acc, accentTop:true });
      const th=(n.thickness!=null?n.thickness:6);                       // aresta inferior (espessura da placa) — chapada, sem 3D
      ctx.fillStyle=M.rgba(M.shade(rgb,-0.22),1); ctx.fillRect(L+rad, T+h-th, w-2*rad, th);
      const hasIcon=n.icon && VXK.drawIcon && VXK.hasIcon && VXK.hasIcon(n.icon);
      if(hasIcon){ const isz=Math.max(20,Math.min(h*0.5,36)); M.iconChip(ctx, L+18+isz/2, cy, isz, n.icon, acc, zoom); }
    }

    // rótulo-pílula à direita: aparece conforme explode (fade por lift)
    const la=Math.max(0, Math.min(1,(lift-0.15)/0.5));
    if(la>0.02 && n.label){
      const baseA=ctx.globalAlpha;                                       // respeita a opacidade de entrada do nó
      let ax, ay;                                                        // âncora do leader = aresta direita real da placa
      if(n.iso){ const HX=0.9,HY=0.46,w2=w/2,h2=h/2; ax=cx+(w2+h2)*HX; ay=cy+(w2-h2)*HY; }
      else { ax=cx+w/2; ay=cy; }
      const bx=ax+22, by=cy;
      ctx.globalAlpha=baseA*la;
      ctx.strokeStyle=M.rgba(M.hex2rgb(acc),0.6); ctx.lineWidth=1.4*k;
      ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx-6, by); ctx.stroke();
      ctx.textAlign='left';
      M.type(ctx,'cardTitle',zoom); const tw=ctx.measureText(n.label).width;
      let sw=0; if(n.sublabel){ M.type(ctx,'sublabel',zoom); sw=ctx.measureText(n.sublabel).width; }
      const pw=Math.max(tw,sw)+24*k, ph=(n.sublabel?40:28)*k;
      M.roundRectPath(ctx, bx, by-ph/2, pw, ph, 8*k); ctx.fillStyle=M.rgba([16,23,38],0.86); ctx.fill();
      M.roundRectPath(ctx, bx, by-ph/2, pw, ph, 8*k); ctx.strokeStyle=M.rgba(M.hex2rgb(acc),0.4); ctx.lineWidth=1*k; ctx.stroke();
      ctx.fillStyle=n.textColor||M.ds.text.primary; ctx.textBaseline=n.sublabel?'alphabetic':'middle';
      M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label, bx+12*k, n.sublabel?by-3*k:by);
      if(n.sublabel){ M.type(ctx,'sublabel',zoom); ctx.fillStyle=M.ds.text.secondary; ctx.fillText(n.sublabel, bx+12*k, by+13*k); }
      ctx.globalAlpha=baseA; ctx.letterSpacing='0px'; ctx.textBaseline='alphabetic';
    }
  },
  hit(_i,n,wx,wy){
    const [cx,cy]=VXK.liftCenter(n), w=(n.w!=null?n.w:300), h=(n.h!=null?n.h:150);
    const ok={label:n.label, info:n.info||n.sublabel, color:n.accent||'#8ab4ff'};
    if(n.iso){                                                           // hit POLIGONAL (topo + 2 faces) — não seleciona a placa errada em sobreposição
      const HX=0.9,HY=0.46,th=(n.thickness!=null?n.thickness:16),w2=w/2,h2=h/2;
      const P=(u,v)=>[cx+(u-v)*HX, cy+(u+v)*HY], d=p=>[p[0],p[1]+th];
      const Tb=P(-w2,-h2),Tr=P(w2,-h2),Tf=P(w2,h2),Tl=P(-w2,h2);
      const inPoly=(pts)=>VXK.geom.pointInPoly(pts, wx, wy);   // ray-cast agora em VXK.geom (fonte única)
      return (inPoly([Tb,Tr,Tf,Tl]) || inPoly([Tr,Tf,d(Tf),d(Tr)]) || inPoly([Tl,Tf,d(Tf),d(Tl)])) ? ok : false;
    }
    return (wx>=cx-w/2&&wx<=cx+w/2&&wy>=cy-h/2&&wy<=cy+h/2) ? ok : false;
  },
  bounds(n){
    const [cx,cy]=VXK.liftCenter(n), w=(n.w!=null?n.w:300), h=(n.h!=null?n.h:150);
    if(n.iso){ const HX=0.9,HY=0.46,th=(n.thickness!=null?n.thickness:16),w2=w/2,h2=h/2;
      const spanX=(w2+h2)*HX, spanY=(w2+h2)*HY;
      return [cx-spanX, cy-spanY, cx+spanX+ (n.label? w*0.6:0), cy+spanY+th]; }
    return [cx-w/2, cy-h/2, cx+w/2 + (n.label? w*0.5:0), cy+h/2];
  }
});
