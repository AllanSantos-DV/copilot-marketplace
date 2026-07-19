/* DESIGN SYSTEM · "ghost" — contorno de referência para posição anterior/futura.
   params: { x, y, w, h, shape, color, alpha, label, dashed } (x,y = centro). */
VXK.register('ghost', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const x=n.x||0, y=n.y||0, w=n.w||120, h=n.h||60;
    const shape=n.shape||'roundRect', color=n.color||'#8ab4ff';
    const alpha=n.alpha==null?0.28:Math.max(0, Math.min(1, n.alpha));
    const zoom=e.zoom||1;

    ctx.save();
    ctx.strokeStyle=color;
    ctx.lineWidth=1.25/zoom;
    ctx.globalAlpha=alpha;
    ctx.setLineDash(n.dashed===false?[]:[6/zoom, 4/zoom]);
    ctx.beginPath();
    if(shape==='circle'){
      ctx.arc(x, y, Math.min(w, h)/2, 0, Math.PI*2);
    } else if(shape==='rect'){
      ctx.rect(x-w/2, y-h/2, w, h);
    } else {
      const r=Math.min(12, w/2, h/2);
      ctx.moveTo(x-w/2+r, y-h/2);
      ctx.arcTo(x+w/2, y-h/2, x+w/2, y+h/2, r);
      ctx.arcTo(x+w/2, y+h/2, x-w/2, y+h/2, r);
      ctx.arcTo(x-w/2, y+h/2, x-w/2, y-h/2, r);
      ctx.arcTo(x-w/2, y-h/2, x+w/2, y-h/2, r);
      ctx.closePath();
    }
    ctx.stroke();

    if(n.label){
      ctx.setLineDash([]);
      ctx.globalAlpha=Math.min(0.62, alpha+0.18);
      ctx.fillStyle=color;
      ctx.font='500 '+Math.max(1, Math.round(11/zoom))+'px Segoe UI';
      ctx.textAlign='center';
      ctx.textBaseline='top';
      ctx.fillText(n.label, x, y+h/2+6/zoom);
    }
    ctx.restore();
  },
  hit(){ return false; }
});
