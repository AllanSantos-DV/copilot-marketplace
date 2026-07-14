/* DESIGN SYSTEM · componente "orbit" — corpo em órbita circular ao redor da origem.
   params: { orbitR, ang0, speed, r, color, label, info }
   Reutilizável em qualquer explicação de órbitas/rotação. */
VXK.register('orbit', {
  create(n){ return {}; },
  pos(n, e){ const a=(n.ang0||0) + e.t*(n.speed||0); return [ Math.cos(a)*(n.orbitR||0), Math.sin(a)*(n.orbitR||0) ]; },
  draw(ctx, inst, n, e, selected){
    const color = n.color || '#8ab4ff';
    if(n.orbitR){ ctx.beginPath(); ctx.arc(0,0,n.orbitR,0,6.2832); ctx.strokeStyle='rgba(120,140,180,.18)'; ctx.lineWidth=1/e.zoom; ctx.stroke(); }
    const p=this.pos(n,e), x=p[0], y=p[1];
    if(!e.lite){
      if(!inst.glow){ const R=n.r*2.4; const g=ctx.createRadialGradient(0,0,0,0,0,R); g.addColorStop(0,color+'88'); g.addColorStop(1,color+'00'); inst.glow=g; inst.glowR=R; }
      ctx.save(); ctx.translate(x,y); ctx.fillStyle=inst.glow; ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fill(); ctx.restore();
    }
    ctx.beginPath(); ctx.arc(x,y,n.r,0,6.2832); ctx.fillStyle=color; ctx.fill();
    if(selected){ ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.stroke(); }
    if(n.label){ ctx.fillStyle='#cfd8ea'; ctx.font=(((12/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center';
      ctx.fillText(n.label, x, y - n.r - 6/e.zoom); }
  },
  hit(_i, n, wx, wy, e){ const p=this.pos(n,e); return Math.hypot(wx-p[0], wy-p[1]) <= (n.r||6) + 6; }
});
