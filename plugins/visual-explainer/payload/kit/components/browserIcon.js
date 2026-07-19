/* DESIGN SYSTEM · "browserIcon" — navegador/monitor FLAT.
   params: { x, y, scale, color, screenColor, stroke, label, info } */
VXK.register('browserIcon', {
  create(){ return {}; },
  draw(ctx, _inst, n, e, selected){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const s=n.scale||1, w=140*s, h=92*s, lw=(selected?2:1.5)/e.zoom;
    const stroke=selected?'#ffffff':(n.stroke||'#dbe7ff');

    ctx.fillStyle=n.color||'#4476d9';
    ctx.strokeStyle=stroke;
    ctx.lineWidth=lw;
    ctx.beginPath();
    ctx.rect(x-w/2, y-h/2, w, h);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle=n.screenColor||'#eaf1ff';
    ctx.fillRect(x-w/2+9*s, y-h/2+22*s, w-18*s, h-31*s);
    ctx.strokeStyle=n.stroke||'#24446f';
    ctx.lineWidth=1.2/e.zoom;
    ctx.beginPath();
    ctx.moveTo(x-w/2, y-h/2+22*s);
    ctx.lineTo(x+w/2, y-h/2+22*s);
    ctx.stroke();

    ['#ff6b6b','#ffd166','#49c98b'].forEach((color, i)=>{
      ctx.beginPath();
      ctx.arc(x-w/2+(13+i*13)*s, y-h/2+11*s, 3.2*s, 0, Math.PI*2);
      ctx.fillStyle=color;
      ctx.fill();
    });

    ctx.strokeStyle=n.stroke||'#dbe7ff';
    ctx.lineWidth=3/e.zoom;
    ctx.beginPath();
    ctx.moveTo(x, y+h/2);
    ctx.lineTo(x, y+h/2+18*s);
    ctx.moveTo(x-25*s, y+h/2+18*s);
    ctx.lineTo(x+25*s, y+h/2+18*s);
    ctx.stroke();

    ctx.fillStyle=n.textColor||'#eef3ff';
    ctx.font='600 '+Math.max(1,Math.round(15/e.zoom))+'px Segoe UI';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.fillText(n.label||'Navegador', x, y+h/2+40*s);
    ctx.textBaseline='alphabetic';
  },
  hit(_inst, n, wx, wy){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const s=n.scale||1, inside=wx>=x-70*s&&wx<=x+70*s&&wy>=y-46*s&&wy<=y+64*s;
    return inside ? {label:n.label||'Navegador', info:n.info||'', color:n.color||'#4476d9'} : false;
  },
  pos(n){ return [Number.isFinite(n.x)?n.x:0, Number.isFinite(n.y)?n.y:0]; },
  parts(n){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0, s=n.scale||1;
    return {screen:[x,y], stand:[x,y+55*s]};
  }
});
