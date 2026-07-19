/* DESIGN SYSTEM · "toggle" — interruptor (kill-switch) OFF/ON.
   `on` é numérico 0..1 (o step engine consegue animar o knob deslizando).
   Clicar INVERTE o estado (hit muta n.on) e devolve a info do estado atual.
   Tamanho de tela constante (dims em px/e.zoom). Sem shadowBlur.
   params: { x, y, w, key, on(0..1), offText, onText, offInfo, onInfo,
             onColor, offColor, info, label } */
VXK.register('toggle', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, n.y||0]; },
  _cols(n){ return { on:n.onColor||'#3ddc84', off:n.offColor||'#ff5d6c' }; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom, k=1/z;
    const x=n.x||0, y=n.y||0, on=Math.max(0,Math.min(1, n.on==null?0:n.on));
    const c=this._cols(n), rgb=M.hex2rgb(on>0.5?c.on:c.off);
    const cur=M.hexLerp(c.off, c.on, on), crgb=M.hex2rgb(cur);
    const TW=112*k, TH=40*k, R=TH/2;

    // chave (config key) — mono, acima
    ctx.textAlign='center'; ctx.textBaseline='alphabetic';
    ctx.font=(((12.5/z)|0)||1)+'px Consolas,"Courier New",monospace';
    ctx.fillStyle=n.keyColor||'#c6d3ef';
    ctx.fillText(n.key||n.label||'', x, y - 34*k);

    // trilho
    M.roundRectPath(ctx, x-TW/2, y-TH/2, TW, TH, R);
    ctx.fillStyle=M.rgba(crgb, 0.20 + 0.10*on); ctx.fill();
    M.roundRectPath(ctx, x-TW/2, y-TH/2, TW, TH, R);
    ctx.strokeStyle=M.rgba(crgb, 0.72); ctx.lineWidth=1.4*k; ctx.stroke();
    if(selected){ M.roundRectPath(ctx, x-TW/2-3*k, y-TH/2-3*k, TW+6*k, TH+6*k, R+3*k);
      ctx.strokeStyle='#ffffff'; ctx.lineWidth=1.6*k; ctx.stroke(); }

    // palavra de estado no lado vazio do trilho
    ctx.font='800 '+((((10.5/z)|0)||1))+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle=M.rgba(crgb, 0.95);
    ctx.textBaseline='middle';
    ctx.letterSpacing=(1*k)+'px';
    if(on>0.5){ ctx.textAlign='left';  ctx.fillText('ON',  x-TW/2+13*k, y+0.5*k); }
    else       { ctx.textAlign='right'; ctx.fillText('OFF', x+TW/2-13*k, y+0.5*k); }
    ctx.letterSpacing='0px';

    // knob
    const kx = x - (TW/2 - R) + on*(TW - TH);
    const kr = R - 4*k;
    ctx.beginPath(); ctx.arc(kx, y, kr, 0, 6.2832);
    ctx.fillStyle='#eef3ff'; ctx.fill();
    ctx.beginPath(); ctx.arc(kx, y, kr, 0, 6.2832);
    ctx.strokeStyle=M.rgba(crgb,0.9); ctx.lineWidth=1.6*k; ctx.stroke();
    // marca no knob
    ctx.beginPath(); ctx.arc(kx, y, kr*0.42, 0, 6.2832);
    ctx.fillStyle=M.rgba(crgb,0.55); ctx.fill();

    // legenda de estado (abaixo)
    const cap = on>0.5 ? (n.onText||'') : (n.offText||'');
    if(cap){
      ctx.textAlign='center'; ctx.textBaseline='alphabetic';
      ctx.font='600 '+((((11.5/z)|0)||1))+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle=M.rgba(rgb, 0.95);
      ctx.fillText(cap, x, y + 34*k);
    }
    ctx.textBaseline='alphabetic';
  },
  hit(inst, n, wx, wy, e){
    const k=1/((e&&e.zoom)||1), x=n.x||0, y=n.y||0, TW=112*k, TH=40*k;
    if(wx>=x-TW/2-8*k && wx<=x+TW/2+8*k && wy>=y-TH/2-8*k && wy<=y+TH/2+8*k){
      n.on = (n.on==null?0:n.on) > 0.5 ? 0 : 1;              // inverte de verdade
      const c=this._cols(n);
      return { label:n.key||n.label||'',
               info: n.on>0.5 ? (n.onInfo||n.info||'') : (n.offInfo||n.info||''),
               color: n.on>0.5 ? c.on : c.off };
    }
    return false;
  }
});
