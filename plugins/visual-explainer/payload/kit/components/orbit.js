/* DESIGN SYSTEM · componente "orbit" — corpo em órbita circular ao redor da origem.
   params: { orbitR, ang0, speed, r, color, label, info }
   Profundidade: corpo central (orbitR=0) é emissivo (glow + núcleo quente);
   os demais são esferas iluminadas (VXK.mat.sphere) com sombra de contato e
   um leve halo de atmosfera. Luz coerente com a cena (e.mat.light). */
VXK.register('orbit', {
  create(n){ return {}; },
  pos(n, e){ const a=(n.ang0||0) + e.t*(n.speed||0); return [ (n.x||0) + Math.cos(a)*(n.orbitR||0), (n.y||0) + Math.sin(a)*(n.orbitR||0) ]; },
  draw(ctx, inst, n, e, selected){
    const color = n.color || '#8ab4ff', M = e.mat, r = n.r || 6, cxp=(n.x||0), cyp=(n.y||0);
    if(n.orbitR){ ctx.beginPath(); ctx.arc(cxp,cyp,n.orbitR,0,6.2832); ctx.strokeStyle='rgba(150,170,210,.16)'; ctx.lineWidth=1/e.zoom; ctx.stroke(); }
    const p=this.pos(n,e), x=p[0], y=p[1];
    const isStar = !n.orbitR;
    if(!e.lite) M.glow(ctx, x, y, r, color, isStar ? 3.6 : 1.7);
    if(isStar){
      const rgb=M.hex2rgb(color), g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0, M.rgba(M.shade(rgb,0.72),1)); g.addColorStop(0.6, M.rgba(rgb,1)); g.addColorStop(1, M.rgba(M.shade(rgb,-0.12),1));
      ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fillStyle=g; ctx.fill();
    } else {
      M.sphere(ctx, x, y, r, color, e);
    }
    if(selected){ ctx.beginPath(); ctx.arc(x,y,r+3/e.zoom,0,6.2832); ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.stroke(); }
    if(n.label){ const fs=((12/e.zoom)|0)||1; ctx.font=fs+'px Segoe UI'; ctx.textAlign='center';
      ctx.lineJoin='round'; ctx.lineWidth=3/e.zoom; ctx.strokeStyle='rgba(6,10,20,.7)'; ctx.strokeText(n.label, x, y - r - 7/e.zoom);
      ctx.fillStyle='#dce5f6'; ctx.fillText(n.label, x, y - r - 7/e.zoom); }
  },
  hit(_i, n, wx, wy, e){ const p=this.pos(n,e); return Math.hypot(wx-p[0], wy-p[1]) <= (n.r||6) + 6; }
});
