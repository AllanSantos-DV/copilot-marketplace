/* DESIGN SYSTEM · "frame" — moldura de agrupamento com rótulo (planos, colunas).
   Decorativa (nunca clicável — não intercepta cliques do conteúdo interno).
   Contorno translúcido + preenchimento chapado bem sutil + aba de rótulo no
   canto superior esquerdo cortando a borda. params:
   { x, y, w, h, label, color, dashed, fillAlpha, labelAlign('left'|'center') } */
VXK.register('frame', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, (n.y||0) - (n.h||200)/2]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom, k=1/z;
    const w=n.w||300, h=n.h||200, x=n.x||0, y=n.y||0, rad=n.rad||16;
    const rgb=M.hex2rgb(n.color||'#41537f');
    const L=x-w/2, T=y-h/2;
    ctx.save();
    // preenchimento chapado bem sutil
    M.roundRectPath(ctx, L, T, w, h, rad);
    ctx.fillStyle=M.rgba(rgb, n.fillAlpha!=null?n.fillAlpha:0.045); ctx.fill();
    // contorno
    if(n.dashed) ctx.setLineDash([9*k, 7*k]);
    M.roundRectPath(ctx, L, T, w, h, rad);
    ctx.strokeStyle=M.rgba(rgb, 0.42); ctx.lineWidth=1.4*k; ctx.stroke();
    ctx.setLineDash([]);
    // aba de rótulo
    if(n.label){
      const fs=((11/z)|0)||1;
      ctx.font='800 '+fs+'px "Segoe UI",system-ui,sans-serif';
      ctx.letterSpacing=(1.3*k)+'px';
      const txt=String(n.label).toUpperCase();
      const tw=ctx.measureText(txt).width + 20*k, th=20*k;
      const tx = n.labelAlign==='center' ? (x - tw/2) : (L + 18*k);
      const ty = T - th/2;
      M.roundRectPath(ctx, tx, ty, tw, th, 6*k);
      ctx.fillStyle=n.tabTone||'#0d1524'; ctx.fill();
      M.roundRectPath(ctx, tx, ty, tw, th, 6*k);
      ctx.strokeStyle=M.rgba(rgb,0.6); ctx.lineWidth=1.2*k; ctx.stroke();
      ctx.fillStyle=M.rgba(M.shade(rgb,0.5),1);
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(txt, tx+tw/2, ty+th/2+0.5*k);
      ctx.letterSpacing='0px';
    }
    ctx.restore();
  },
  hit(){ return false; }
});
