/* DESIGN SYSTEM · "pendulum" — pêndulo simples oscilando.
   params: { pivotX, pivotY, length, amp(rad), speed(rad/s), phase, r, color, label, info }
   Gradiente do brilho cacheado em espaço local (sem gradiente por frame). */
VXK.register('pendulum', {
  create(n){ return {}; },
  ang(n, e){ return (n.amp!=null?n.amp:0.6) * Math.cos(e.t*(n.speed||1.2) + (n.phase||0)); },
  bob(n, e){ const px=n.pivotX||0, py=(n.pivotY!=null?n.pivotY:-140), L=n.length||200, a=this.ang(n,e);
    return [ px + Math.sin(a)*L, py + Math.cos(a)*L ]; },
  draw(ctx, inst, n, e, selected){
    const px=n.pivotX||0, py=(n.pivotY!=null?n.pivotY:-140), r=n.r||18, color=n.color||'#5b8cff';
    const b=this.bob(n,e), x=b[0], y=b[1];
    ctx.strokeStyle='#8aa0c0'; ctx.lineWidth=3/e.zoom; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(x,y); ctx.stroke();
    ctx.fillStyle='#5b6b86'; ctx.beginPath(); ctx.arc(px,py,5,0,6.2832); ctx.fill();
    if(!e.lite){
      if(!inst.glow){ const R=r*2; const g=ctx.createRadialGradient(0,0,0,0,0,R); g.addColorStop(0,color+'77'); g.addColorStop(1,color+'00'); inst.glow=g; inst.glowR=R; }
      ctx.save(); ctx.translate(x,y); ctx.fillStyle=inst.glow; ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fill(); ctx.restore();
    }
    ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fillStyle=color; ctx.fill();
    if(selected){ ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.stroke(); }
    if(n.label){ ctx.fillStyle='#cfd8ea'; ctx.font=(((12/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center'; ctx.fillText(n.label, px, py-12/e.zoom); }
  },
  hit(_i, n, wx, wy, e){ const b=this.bob(n,e); return Math.hypot(wx-b[0], wy-b[1]) <= (n.r||18)+6; }
});
