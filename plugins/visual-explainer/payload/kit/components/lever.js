/* DESIGN SYSTEM · "lever" — mostrador de config: valor num. sobre trilho min..max.
   Trilho em largura de MUNDO (n.w); rótulos/knob em tamanho de tela (px/e.zoom).
   Marcador `target` opcional (valor recomendado, tracejado). Clicável -> painel.
   params: { x, y, w, label, value, min, max, unit, target, targetLabel,
             color, info } */
VXK.register('lever', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, n.y||0]; },
  _fx(n){ const min=n.min!=null?n.min:0, max=n.max!=null?n.max:1, w=n.w||320;
    return v => (n.x||0) - w/2 + w*Math.max(0,Math.min(1,(v-min)/((max-min)||1))); },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom, k=1/z, w=n.w||320, x=n.x||0, y=n.y||0;
    const col=n.color||'#57b0ff', rgb=M.hex2rgb(col);
    const fx=this._fx(n), vx=fx(n.value!=null?n.value:n.min||0);
    const L=x-w/2, Rr=x+w/2;

    // rótulo (esq.) + valor (dir.)
    ctx.textBaseline='alphabetic';
    ctx.font='600 '+((((13/z)|0)||1))+'px "Segoe UI",system-ui,sans-serif';
    ctx.textAlign='left'; ctx.fillStyle=n.labelColor||'#c6d3ef';
    ctx.fillText(n.label||'', L, y - 15*k);
    ctx.textAlign='right';
    ctx.font='800 '+((((15/z)|0)||1))+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle=col;
    ctx.fillText((n.value!=null?n.value:'')+(n.unit? (' '+n.unit):''), Rr, y - 15*k);

    // trilho base
    ctx.lineCap='round';
    ctx.strokeStyle='rgba(255,255,255,.10)'; ctx.lineWidth=6*k;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(Rr, y); ctx.stroke();
    // porção preenchida
    ctx.strokeStyle=M.rgba(rgb,0.85); ctx.lineWidth=6*k;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(vx, y); ctx.stroke();

    // marcador de alvo (recomendado)
    if(n.target!=null){
      const tx=fx(n.target);
      ctx.setLineDash([4*k,4*k]); ctx.strokeStyle=M.rgba(rgb,0.55); ctx.lineWidth=1.4*k;
      ctx.beginPath(); ctx.moveTo(tx, y-11*k); ctx.lineTo(tx, y+11*k); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(tx, y-11*k); ctx.lineTo(tx-3.4*k, y-16*k); ctx.lineTo(tx+3.4*k, y-16*k); ctx.closePath();
      ctx.fillStyle=M.rgba(rgb,0.8); ctx.fill();
      if(n.targetLabel){ ctx.font='700 '+((((9.5/z)|0)||1))+'px "Segoe UI",system-ui'; ctx.textAlign='center';
        ctx.fillStyle=M.rgba(rgb,0.9); ctx.fillText(n.targetLabel, tx, y-19*k); }
    }

    // knob
    ctx.beginPath(); ctx.arc(vx, y, 8*k, 0, 6.2832);
    ctx.fillStyle='#eef3ff'; ctx.fill();
    ctx.beginPath(); ctx.arc(vx, y, 8*k, 0, 6.2832);
    ctx.strokeStyle= selected? '#ffffff' : col; ctx.lineWidth=(selected?2.4:2)*k; ctx.stroke();

    // extremos min/max
    ctx.font='500 '+((((10/z)|0)||1))+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle='#7c89a8'; ctx.textAlign='left';  ctx.fillText(String(n.min!=null?n.min:0), L, y + 17*k);
    ctx.textAlign='right'; ctx.fillText(String(n.max!=null?n.max:1), Rr, y + 17*k);
  },
  hit(inst, n, wx, wy, e){
    const k=1/((e&&e.zoom)||1), w=n.w||320, x=n.x||0, y=n.y||0;
    if(wx>=x-w/2-4*k && wx<=x+w/2+4*k && wy>=y-24*k && wy<=y+22*k)
      return { label:n.label||'', info:n.info||'', color:n.color||'#57b0ff' };
    return false;
  }
});
