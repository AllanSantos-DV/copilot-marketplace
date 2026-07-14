/* DESIGN SYSTEM · "arrow" — seta conectora (direção de fluxo). Decorativa (não clicável).
   params: { x0,y0, x1,y1, color, label, dashed } */
VXK.register('arrow', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0, col=n.color||'#8aa0c0';
    ctx.strokeStyle=col; ctx.lineWidth=2/e.zoom;
    if(n.dashed) ctx.setLineDash([6/e.zoom, 5/e.zoom]);
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    ctx.setLineDash([]);
    const a=Math.atan2(y1-y0, x1-x0), s=10/e.zoom;
    ctx.beginPath(); ctx.moveTo(x1,y1);
    ctx.lineTo(x1-Math.cos(a-0.42)*s, y1-Math.sin(a-0.42)*s);
    ctx.lineTo(x1-Math.cos(a+0.42)*s, y1-Math.sin(a+0.42)*s);
    ctx.closePath(); ctx.fillStyle=col; ctx.fill();
    if(n.label){ ctx.fillStyle='#9aa7c2'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center';
      ctx.fillText(n.label, (x0+x1)/2, (y0+y1)/2 - 6/e.zoom); }
  },
  hit(){ return false; }
});
