/* DESIGN SYSTEM · "particleStream" — partículas fluindo de (x0,y0) a (x1,y1).
   params: { x0,y0, x1,y1, count, speed, r, color, label, info }
   Pool fixo: offsets calculados no create (zero alocação por frame). */
VXK.register('particleStream', {
  create(n){ const c=Math.max(2, n.count||12); const offs=[]; for(let i=0;i<c;i++) offs.push(i/c); return { offs }; },
  draw(ctx, inst, n, e, selected){
    const x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0, col=n.color||'#3fa9ff', r=n.r||3, spd=n.speed||0.4;
    ctx.strokeStyle=col+'33'; ctx.lineWidth=2/e.zoom; ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    const offs=inst.offs, cnt = e.lite ? Math.ceil(offs.length/2) : offs.length;
    ctx.fillStyle=col;
    for(let i=0;i<cnt;i++){ let f=(e.t*spd + offs[i]) % 1; if(f<0) f+=1; const x=x0+(x1-x0)*f, y=y0+(y1-y0)*f;
      ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fill(); }
    if(selected){ ctx.strokeStyle='#fff'; ctx.lineWidth=1.5/e.zoom; ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke(); }
    if(n.label){ ctx.fillStyle='#9aa7c2'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center'; ctx.fillText(n.label, (x0+x1)/2, (y0+y1)/2 - 8/e.zoom); }
  },
  hit(_i, n, wx, wy){
    const x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0, dx=x1-x0, dy=y1-y0, L2=dx*dx+dy*dy||1;
    let t=((wx-x0)*dx+(wy-y0)*dy)/L2; t=Math.max(0,Math.min(1,t));
    return Math.hypot(wx-(x0+dx*t), wy-(y0+dy*t)) <= (n.r||3)+8;
  }
});
