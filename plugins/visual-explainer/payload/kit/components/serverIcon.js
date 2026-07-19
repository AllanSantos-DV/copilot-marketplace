/* DESIGN SYSTEM · "serverIcon" — rack de servidor FLAT.
   params: { x, y, scale, color, panelColor, stroke, label, info } */
VXK.register('serverIcon', {
  create(){ return {}; },
  draw(ctx, _inst, n, e, selected){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const s=n.scale||1, w=112*s, h=138*s, lw=(selected?2:1.5)/e.zoom;
    const stroke=selected?'#ffffff':(n.stroke||'#dbe7ff');

    ctx.fillStyle=n.color||'#263a5f';
    ctx.strokeStyle=stroke;
    ctx.lineWidth=lw;
    ctx.fillRect(x-w/2, y-h/2, w, h);
    ctx.strokeRect(x-w/2, y-h/2, w, h);

    for(let i=0;i<3;i++){
      const py=y-h/2+(12+i*42)*s;
      ctx.fillStyle=n.panelColor||'#3d5a8c';
      ctx.fillRect(x-w/2+10*s, py, w-20*s, 31*s);
      ctx.strokeStyle=n.stroke||'#9db6df';
      ctx.lineWidth=1/e.zoom;
      ctx.strokeRect(x-w/2+10*s, py, w-20*s, 31*s);

      ctx.beginPath();
      ctx.arc(x-w/2+23*s, py+15.5*s, 3.5*s, 0, Math.PI*2);
      ctx.fillStyle=i===1?'#ffd166':'#49c98b';
      ctx.fill();

      ctx.strokeStyle=n.stroke||'#dbe7ff';
      ctx.lineWidth=1.3/e.zoom;
      ctx.beginPath();
      ctx.moveTo(x-w/2+38*s, py+11*s);
      ctx.lineTo(x+w/2-15*s, py+11*s);
      ctx.moveTo(x-w/2+38*s, py+20*s);
      ctx.lineTo(x+w/2-27*s, py+20*s);
      ctx.stroke();
    }

    ctx.fillStyle=n.textColor||'#eef3ff';
    ctx.font='600 '+Math.max(1,Math.round(15/e.zoom))+'px Segoe UI';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.fillText(n.label||'Servidor', x, y+h/2+26*s);
    ctx.textBaseline='alphabetic';
  },
  hit(_inst, n, wx, wy){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0, s=n.scale||1;
    const inside=wx>=x-56*s&&wx<=x+56*s&&wy>=y-69*s&&wy<=y+69*s;
    return inside ? {label:n.label||'Servidor', info:n.info||'', color:n.color||'#263a5f'} : false;
  },
  pos(n){ return [Number.isFinite(n.x)?n.x:0, Number.isFinite(n.y)?n.y:0]; },
  parts(n){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0, s=n.scale||1;
    return {rack:[x,y], status:[x-33*s,y]};
  }
});
