/* DESIGN SYSTEM · "stat" — KPI / número grande (métrica, resultado, contador).
   params: { x, y, w, h, kicker, value, unit, label, color, valueSize, info }
     value = número/texto grande em destaque (ex.: "6 747")
     unit  = unidade pequena ao lado do valor (ex.: "nós")
     label = legenda abaixo; aceita "\n" para 2 linhas (âncora no rodapé)
     kicker= rótulo pequeno em maiúsculas no topo
   Tipografia mundo-fixa (escala com o zoom da cena), como o "card". Sem
   shadowBlur; glow de seleção é radialGradient CACHEADO (origem + translate).
   Clicável -> painel lateral. */
VXK.register('stat', {
  create(n){ return { glow:null, glowR:0, gsig:'' }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom;
    const w=n.w||210, h=n.h||120, x=n.x||0, y=n.y||0, rad=14, pad=15;
    const col=n.color||'#38bdf8', rgb=M.hex2rgb(col), L=x-w/2, T=y-h/2;
    ctx.save();
    // glow de seleção (gradiente cacheado)
    if(selected && !e.lite){
      const gsig=col+'|'+w+'|'+h;
      if(inst.gsig!==gsig){ inst.gsig=gsig; const R=Math.max(w,h)*0.72;
        const g=ctx.createRadialGradient(0,0,Math.min(w,h)*0.26, 0,0,R);
        g.addColorStop(0,M.rgba(rgb,0.24)); g.addColorStop(1,M.rgba(rgb,0)); inst.glow=g; inst.glowR=R; }
      ctx.save(); ctx.translate(x,y); ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fillStyle=inst.glow; ctx.fill(); ctx.restore();
    }
    // painel + borda
    M.roundRectPath(ctx,L,T,w,h,rad); ctx.fillStyle='rgba(15,22,37,0.93)'; ctx.fill();
    M.roundRectPath(ctx,L,T,w,h,rad); ctx.strokeStyle=selected?'#ffffff':M.rgba(rgb,0.5); ctx.lineWidth=(selected?2.2:1.3)/z; ctx.stroke();
    // barra de acento no topo (cantos seguem o raio)
    ctx.save(); M.roundRectPath(ctx,L,T,w,h,rad); ctx.clip(); ctx.fillStyle=M.rgba(rgb,0.92); ctx.fillRect(L,T,w,4); ctx.restore();
    // kicker (topo)
    ctx.textAlign='left';
    if(n.kicker){ ctx.textBaseline='top'; ctx.font='800 11px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle=M.rgba(M.shade(rgb,0.42),1); ctx.fillText(String(n.kicker).toUpperCase(), L+pad, T+pad); }
    // valor grande + unidade
    const val=String(n.value!=null?n.value:''), vfs=n.valueSize||(h>=110?34:28);
    const vy=y + (n.kicker?9:2) + (n.label?0:vfs*0.30);
    ctx.textBaseline='alphabetic';
    ctx.font='800 '+vfs+'px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle='#f3f7ff';
    ctx.fillText(val, L+pad, vy);
    if(n.unit){ const vw=ctx.measureText(val).width; ctx.font='700 13px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle=M.rgba(M.shade(rgb,0.34),1); ctx.fillText(n.unit, L+pad+vw+7, vy-2); }
    // legenda (rodapé; "\n" = múltiplas linhas, empilhadas de baixo p/ cima)
    if(n.label){ const lfs=12, lines=String(n.label).split('\n');
      ctx.font='600 '+lfs+'px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle='#9fb0d0';
      let by=T+h-pad; for(let i=lines.length-1;i>=0;i--){ ctx.fillText(lines[i], L+pad, by); by-=lfs+3; } }
    ctx.textBaseline='alphabetic'; ctx.restore();
  },
  hit(_i, n, wx, wy){ const w=n.w||210,h=n.h||120,x=n.x||0,y=n.y||0;
    return wx>=x-w/2&&wx<=x+w/2&&wy>=y-h/2&&wy<=y+h/2; }
});
