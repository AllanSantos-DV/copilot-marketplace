/* DESIGN SYSTEM · "chip" — pílula compacta (item de lista, fato, invariante).
   Largura automática pelo texto (cacheada) ou fixa (n.w). Ponto/ícone colorido
   à esquerda. `danger:true` = linha vermelha (borda/tinta de alerta). Tamanho de
   tela constante (px/e.zoom). Clicável -> painel lateral.
   params: { x, y, label, color, tone, danger, icon, w, info } */
VXK.register('chip', {
  create(n){ return { hw: 0, sig:'' }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom, k=1/z;
    const x=n.x||0, y=n.y||0, col=n.color||'#57b0ff', rgb=M.hex2rgb(col);
    const danger=!!n.danger, H=27*k, fs=((12/z)|0)||1;
    M.type(ctx,'chip',z);
    const tw = ctx.measureText(n.label||'').width;
    const W = n.w!=null ? n.w : (tw + 40*k);
    inst.hw = W/2;
    const L=x-W/2, T=y-H/2;

    // corpo
    M.roundRectPath(ctx, L, T, W, H, H/2);
    ctx.fillStyle = danger ? 'rgba(40,16,22,0.66)' : (n.tone||'rgba(16,23,38,0.72)');
    ctx.fill();
    M.roundRectPath(ctx, L, T, W, H, H/2);
    ctx.strokeStyle = selected ? '#ffffff' : M.rgba(rgb, danger?0.75:0.42);
    ctx.lineWidth=(selected?1.8:1.2)*k; ctx.stroke();

    // marca à esquerda
    const mx=L+15*k;
    if(danger){ // barrinha vermelha ("linha vermelha")
      M.roundRectPath(ctx, L+9*k, y-6*k, 3.4*k, 12*k, 1.6*k); ctx.fillStyle=col; ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(mx-3*k, y, 3.6*k, 0, 6.2832); ctx.fillStyle=col; ctx.fill();
    }

    // rótulo
    ctx.fillStyle = danger ? '#ffdfe3' : (n.textColor||'#dbe6fb');
    ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(n.label||'', L+24*k, y+0.5*k);
    ctx.letterSpacing='0px'; ctx.textBaseline='alphabetic';
  },
  hit(inst, n, wx, wy, e){
    const k=1/((e&&e.zoom)||1), x=n.x||0, y=n.y||0;
    const hw = inst.hw || (n.w? n.w/2 : 60), H=27*k;
    if(wx>=x-hw && wx<=x+hw && wy>=y-H/2-3*k && wy<=y+H/2+3*k)
      return { label:n.label||'', info:n.info||'', color:n.color||'#57b0ff' };
    return false;
  }
});
