/* DESIGN SYSTEM · "callout" — rótulo anotado que APONTA uma peça com linha-cotovelo
   (leader), estilo Ciechanowski/d3-annotation. Coloque em (x,y) = ponto a anotar; a
   caixa de rótulo flutua no quadrante `dir`. params:
   { x, y, dir('NE'|'NW'|'SE'|'SW'), label, body, color, len, tone } */
VXK.register('callout', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, k=1/e.zoom, ax=n.x||0, ay=n.y||0, col=n.color||'#8ab4ff';
    const dir=n.dir||'NE', dx=/E/.test(dir)?1:-1, dy=/S/.test(dir)?1:-1;
    const len=(n.len||64)*k;
    const mx=ax+dx*len*0.55, my=ay+dy*len, ex=mx+dx*len*0.9, ey=my;   // cotovelo: diagonal + horizontal
    ctx.strokeStyle=col; ctx.lineWidth=1.6*k; ctx.lineJoin='round';
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(mx,my); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.beginPath(); ctx.arc(ax,ay,3*k,0,6.2832); ctx.fillStyle=col; ctx.fill();   // ponto na peça
    const title=n.label||'', body=n.body||'';
    const fT=((13/e.zoom)|0)||1, fB=((11/e.zoom)|0)||1, padX=9*k;
    ctx.font='600 '+fT+'px Segoe UI'; let bw=ctx.measureText(title).width;
    if(body){ ctx.font=fB+'px Segoe UI'; bw=Math.max(bw, ctx.measureText(body).width); }
    const boxW=bw+padX*2, boxH=(body ? (fT+fB+12*k) : (fT+9*k));
    const bx=(dx>0?ex:ex-boxW), by=ey-boxH/2;
    M.roundRectPath(ctx, bx, by, boxW, boxH, 7*k); ctx.fillStyle=n.tone||'rgba(12,17,28,.95)'; ctx.fill();
    M.roundRectPath(ctx, bx, by, boxW, boxH, 7*k); ctx.strokeStyle=col; ctx.lineWidth=1.2*k; ctx.stroke();
    ctx.textAlign='left'; ctx.textBaseline='alphabetic'; ctx.fillStyle='#eef3ff'; ctx.font='600 '+fT+'px Segoe UI';
    ctx.fillText(title, bx+padX, by + (body ? fT+3*k : boxH/2 + fT*0.36));
    if(body){ ctx.fillStyle='rgba(230,236,246,.66)'; ctx.font=fB+'px Segoe UI'; ctx.fillText(body, bx+padX, by+fT+fB+6*k); }
  },
  hit(){ return false; }
});
