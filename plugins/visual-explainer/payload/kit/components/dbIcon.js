/* DESIGN SYSTEM · "dbIcon" — banco de dados em cilindro FLAT.
   params: { x, y, scale, color, topColor, stroke, label, info } */
VXK.register('dbIcon', {
  create(){ return {}; },
  draw(ctx, _inst, n, e, selected){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const s=n.scale||1, rx=66*s, ry=22*s, h=105*s, lw=(selected?2:1.5)/e.zoom;
    const stroke=selected?'#ffffff':(n.stroke||'#dbe7ff');

    ctx.beginPath();
    ctx.moveTo(x-rx, y-h/2);
    ctx.lineTo(x-rx, y+h/2);
    ctx.bezierCurveTo(x-rx, y+h/2+ry, x+rx, y+h/2+ry, x+rx, y+h/2);
    ctx.lineTo(x+rx, y-h/2);
    ctx.closePath();
    ctx.fillStyle=n.color||'#2f9d7e';
    ctx.fill();
    ctx.strokeStyle=stroke;
    ctx.lineWidth=lw;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(x, y-h/2, rx, ry, 0, 0, Math.PI*2);
    ctx.fillStyle=n.topColor||'#58c6a2';
    ctx.fill();
    ctx.strokeStyle=stroke;
    ctx.stroke();

    ctx.strokeStyle=n.stroke||'#cdeee4';
    ctx.lineWidth=1.2/e.zoom;
    for(const oy of [-5,31]){
      const yy=y-h/2+oy*s;
      ctx.beginPath();
      ctx.moveTo(x-rx, yy);
      ctx.bezierCurveTo(x-rx, yy+ry, x+rx, yy+ry, x+rx, yy);
      ctx.stroke();
    }

    ctx.fillStyle=n.textColor||'#eef3ff';
    ctx.font='600 '+Math.max(1,Math.round(15/e.zoom))+'px Segoe UI';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.fillText(n.label||'Banco de Dados', x, y+h/2+42*s);
    ctx.textBaseline='alphabetic';
  },
  hit(_inst, n, wx, wy){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0, s=n.scale||1;
    const inside=wx>=x-66*s&&wx<=x+66*s&&wy>=y-75*s&&wy<=y+75*s;
    return inside ? {label:n.label||'Banco de Dados', info:n.info||'', color:n.color||'#2f9d7e'} : false;
  },
  pos(n){ return [Number.isFinite(n.x)?n.x:0, Number.isFinite(n.y)?n.y:0]; },
  parts(n){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0, s=n.scale||1;
    return {storage:[x,y], table:[x,y-52*s]};
  }
});
