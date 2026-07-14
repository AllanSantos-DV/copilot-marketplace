/* DESIGN SYSTEM · "wave" — onda senoidal animada (física: ondas, som, sinal).
   params: { amp, wavelength, speed, x0, x1, y, color, label, info } */
VXK.register('wave', {
  create(n){ return {}; },
  y(n, e, x){ const k=2*Math.PI/(n.wavelength||160); return (n.y||0) + (n.amp||40)*Math.sin(k*(x-(n.x0!=null?n.x0:-260)) - e.t*(n.speed||2)); },
  draw(ctx, _i, n, e, selected){
    const x0=(n.x0!=null?n.x0:-260), x1=(n.x1!=null?n.x1:260), col=n.color||'#5b8cff';
    ctx.strokeStyle='rgba(150,170,200,.2)'; ctx.lineWidth=1/e.zoom; ctx.beginPath(); ctx.moveTo(x0,n.y||0); ctx.lineTo(x1,n.y||0); ctx.stroke();
    ctx.strokeStyle=col; ctx.lineWidth=(selected?3:2)/e.zoom; ctx.beginPath();
    let first=true; for(let x=x0; x<=x1; x+=6){ const y=this.y(n,e,x); if(first){ ctx.moveTo(x,y); first=false; } else ctx.lineTo(x,y); } ctx.stroke();
    if(n.label){ ctx.fillStyle='#cfd8ea'; ctx.font=(((12/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='left';
      ctx.fillText(n.label, x0, (n.y||0)-(n.amp||40)-8/e.zoom); }
  },
  hit(_i, n, wx, wy, e){ const x0=(n.x0!=null?n.x0:-260), x1=(n.x1!=null?n.x1:260);
    if(wx<x0 || wx>x1) return false; return Math.abs(wy - this.y(n,e,wx)) <= 10; }
});
