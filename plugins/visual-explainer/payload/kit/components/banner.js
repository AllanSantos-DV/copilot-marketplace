/* DESIGN SYSTEM · "banner" — título de seção/herói (kicker + título + subtítulo).
   Tipografia mundo-fixa (tamanho de tela constante via px/e.zoom). Sem caixa:
   é um bloco de texto com uma régua de acento. Clicável só se tiver `info`.
   params: { x, y, kicker, title, subtitle, accent, align('center'|'left'),
             size, w, info, label } */
VXK.register('banner', {
  create(n){ return { hw: 0 }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom, k=1/z, s=n.size||1;
    const x=n.x||0, y=n.y||0, acc=n.accent||'#57b0ff', left=n.align==='left';
    ctx.save();
    ctx.textAlign = left ? 'left' : 'center';
    ctx.textBaseline='alphabetic';
    // kicker
    if(n.kicker){
      const fs=((10.5*s/z)|0)||1;
      ctx.font='800 '+fs+'px "Segoe UI",system-ui,sans-serif';
      ctx.letterSpacing=(2*k)+'px';
      ctx.fillStyle=M.rgba(M.hex2rgb(acc),0.95);
      ctx.fillText(String(n.kicker).toUpperCase(), x, y - 24*s*k);
      ctx.letterSpacing='0px';
    }
    // régua de acento
    const ruleW = (left? 44 : 30)*s*k;
    ctx.strokeStyle=M.rgba(M.hex2rgb(acc),0.9); ctx.lineWidth=2.4*k*s; ctx.lineCap='round';
    ctx.beginPath();
    if(left){ ctx.moveTo(x, y - 12*s*k); ctx.lineTo(x+ruleW, y - 12*s*k); }
    else { ctx.moveTo(x-ruleW, y - 12*s*k); ctx.lineTo(x+ruleW, y - 12*s*k); }
    ctx.stroke();
    // título
    const tfs=((26*s/z)|0)||1;
    ctx.font='760 '+tfs+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle=n.titleColor||'#f3f7ff';
    ctx.fillText(n.title||'', x, y + 12*s*k);
    inst.hw = ctx.measureText(n.title||'').width/2 + 30*k;
    // subtítulo
    if(n.subtitle){
      const sfs=((13.5*s/z)|0)||1;
      ctx.font='500 '+sfs+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle=n.subColor||'#9db0d4';
      ctx.fillText(n.subtitle, x, y + 34*s*k);
    }
    ctx.restore();
  },
  hit(inst, n, wx, wy){
    if(!n.info) return false;
    const x=n.x||0, y=n.y||0, k=1;
    const hw = (n.w? n.w/2 : (inst.hw||220));
    if(wx>=x-hw && wx<=x+hw && wy>=y-46 && wy<=y+46)
      return { label:n.title||n.label||'', info:n.info, color:n.accent||'#57b0ff' };
    return false;
  }
});
