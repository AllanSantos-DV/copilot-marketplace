/* DESIGN SYSTEM · "box" — caixa rotulada (etapa de fluxo, estado, bloco).
   params: { x, y, w, h, label, color, textColor, info }  (x,y = centro) */
VXK.register('box', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const w=n.w||120, h=n.h||50, x=n.x||0, y=n.y||0, rad=10;
    ctx.save(); ctx.translate(x,y);
    const L=-w/2, T=-h/2;
    ctx.beginPath();
    ctx.moveTo(L+rad,T); ctx.arcTo(L+w,T,L+w,T+h,rad); ctx.arcTo(L+w,T+h,L,T+h,rad);
    ctx.arcTo(L,T+h,L,T,rad); ctx.arcTo(L,T,L+w,T,rad); ctx.closePath();
    ctx.fillStyle=n.color||'#25406b'; ctx.fill();
    ctx.strokeStyle=selected?'#fff':'rgba(255,255,255,.14)'; ctx.lineWidth=(selected?2:1)/e.zoom; ctx.stroke();
    ctx.fillStyle=n.textColor||'#eaf0ff'; ctx.font=(((13/e.zoom)|0)||1)+'px Segoe UI';
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(n.label||'', 0, 0); ctx.textBaseline='alphabetic';
    ctx.restore();
  },
  hit(_i, n, wx, wy){ const w=n.w||120, h=n.h||50, x=n.x||0, y=n.y||0;
    return wx>=x-w/2 && wx<=x+w/2 && wy>=y-h/2 && wy<=y+h/2; }
});
