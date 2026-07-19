/* DESIGN SYSTEM · "graphNode" — nó de grafo com glow (o motivo recorrente).
   params: { x, y, r, color, label, kind, info, pulse, ring }
     kind  = etiqueta curta DENTRO do nó (FILE/CLASS/METHOD…), escala com o mundo
     label = nome exibido ABAIXO (tamanho de tela constante, como o "orbit")
     pulse = velocidade de um anel expansivo (0/ausente = estático)
     ring  = desenha um segundo aro externo (ênfase p/ "seed nodes")
   Perf: glow e núcleo são radialGradients CACHEADOS no inst (definidos na origem
   e reposicionados via translate); só recriam quando cor/raio/lite mudam. Nunca
   usa shadowBlur; larguras de linha em coords de mundo (1/e.zoom). */
VXK.register('graphNode', {
  create(n){ return { sig:'', glow:null, glowR:0, core:null }; },
  _ensure(ctx, inst, color, r, M, lite){
    const sig = color+'|'+r+'|'+(lite?1:0);
    if(inst.sig === sig) return;
    inst.sig = sig;
    const rgb = M.hex2rgb(color);
    if(!lite){
      const R = r*2.8, g = ctx.createRadialGradient(0,0,r*0.55, 0,0,R);
      g.addColorStop(0,   M.rgba(rgb,0.40));
      g.addColorStop(0.42,M.rgba(rgb,0.13));
      g.addColorStop(1,   M.rgba(rgb,0));
      inst.glow = g; inst.glowR = R;
    } else { inst.glow = null; }
    const cg = ctx.createRadialGradient(-r*0.38,-r*0.42,r*0.1, 0,0,r*1.02);
    cg.addColorStop(0,   M.rgba(M.shade(rgb,0.60),1));
    cg.addColorStop(0.55,M.rgba(rgb,1));
    cg.addColorStop(1,   M.rgba(M.shade(rgb,-0.30),1));
    inst.core = cg;
  },
  draw(ctx, inst, n, e, selected){
    const M = e.mat, color = n.color || '#38bdf8', r = n.r || 24;
    this._ensure(ctx, inst, color, r, M, e.lite);
    const x = n.x||0, y = n.y||0, rgb = M.hex2rgb(color), z = e.zoom;
    ctx.save();
    ctx.translate(x,y);
    if(inst.glow){ ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fillStyle=inst.glow; ctx.fill(); }
    // anel de pulso (seed/ativo) — barato, sem gradiente
    if(n.pulse && !e.lite){ let f=(e.t*n.pulse)%1; if(f<0)f+=1; const pr=r*(1+f*1.15);
      ctx.beginPath(); ctx.arc(0,0,pr,0,6.2832); ctx.strokeStyle=M.rgba(rgb,(1-f)*0.5); ctx.lineWidth=1.6/z; ctx.stroke(); }
    // núcleo
    ctx.beginPath(); ctx.arc(0,0,r,0,6.2832); ctx.fillStyle=inst.core; ctx.fill();
    // aro
    ctx.beginPath(); ctx.arc(0,0,r,0,6.2832);
    ctx.strokeStyle = selected ? '#ffffff' : M.rgba(M.shade(rgb,0.55),0.9);
    ctx.lineWidth = (selected?2.4:1.4)/z; ctx.stroke();
    if(n.ring){ ctx.beginPath(); ctx.arc(0,0,r+5/z,0,6.2832); ctx.strokeStyle=M.rgba(rgb,0.6); ctx.lineWidth=1.2/z; ctx.stroke(); }
    ctx.restore();
    // etiqueta de tipo DENTRO (escala com o mundo)
    if(n.kind && r>=15){ const fs=Math.max(1,(r*0.5)|0); ctx.font='800 '+fs+'px "Segoe UI",system-ui,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='rgba(8,12,22,.9)';
      ctx.fillText(n.kind, x, y+0.5); ctx.textBaseline='alphabetic'; }
    // nome ABAIXO (tamanho de tela constante)
    if(n.label){ const fs=((12/z)|0)||1; ctx.font='600 '+fs+'px "Segoe UI",system-ui,sans-serif';
      ctx.textAlign='center'; ctx.lineJoin='round'; ctx.lineWidth=3/z;
      ctx.strokeStyle='rgba(6,10,20,.8)'; ctx.strokeText(n.label, x, y + r + 13/z);
      ctx.fillStyle='#dce7fb'; ctx.fillText(n.label, x, y + r + 13/z); }
  },
  hit(_i, n, wx, wy){ const r=n.r||24; return Math.hypot(wx-(n.x||0), wy-(n.y||0)) <= r+6; }
});
