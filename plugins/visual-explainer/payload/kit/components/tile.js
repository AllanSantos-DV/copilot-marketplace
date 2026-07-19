/* DESIGN SYSTEM · "tile" — célula de matriz/heatmap (linguagem, cobertura, grade).
   params: { x, y, w, h, label, level, color, heat, pruned, badge, labelSize, info }
     label = rótulo principal (centralizado) · level = sub-rótulo pequeno embaixo
     heat  = 0..1 → intensidade do preenchimento tingido (mais quente = mais forte)
     pruned= true → célula "podada/em breve": fundo apagado, borda tracejada
     badge = pílula flutuante no topo (ex.: "EM BREVE")
   Tipografia mundo-fixa (escala com o zoom), como o "card". Sem shadowBlur;
   glow de seleção é radialGradient CACHEADO. Clicável -> painel lateral. */
VXK.register('tile', {
  create(n){ return { glow:null, glowR:0, gsig:'' }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom;
    const w=n.w||120, h=n.h||70, x=n.x||0, y=n.y||0, rad=11;
    const col=n.color||'#38bdf8', rgb=M.hex2rgb(col), L=x-w/2, T=y-h/2;
    const pruned=!!n.pruned, heat=(n.heat!=null?n.heat:0.5);
    ctx.save();
    // glow de seleção (gradiente cacheado)
    if(selected && !e.lite){
      const gsig=col+'|'+w+'|'+h;
      if(inst.gsig!==gsig){ inst.gsig=gsig; const R=Math.max(w,h)*0.78;
        const g=ctx.createRadialGradient(0,0,Math.min(w,h)*0.24, 0,0,R);
        g.addColorStop(0,M.rgba(rgb,0.26)); g.addColorStop(1,M.rgba(rgb,0)); inst.glow=g; inst.glowR=R; }
      ctx.save(); ctx.translate(x,y); ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fillStyle=inst.glow; ctx.fill(); ctx.restore();
    }
    // preenchimento tingido (heat) ou apagado (pruned)
    M.roundRectPath(ctx,L,T,w,h,rad);
    ctx.fillStyle = pruned ? 'rgba(26,20,28,0.62)' : M.rgba(rgb, 0.10+0.30*heat);
    ctx.fill();
    // borda (tracejada se pruned)
    if(pruned) ctx.setLineDash([6/z,5/z]);
    M.roundRectPath(ctx,L,T,w,h,rad);
    ctx.strokeStyle = selected?'#ffffff':M.rgba(rgb, pruned?0.7:0.52);
    ctx.lineWidth=(selected?2:1.3)/z; ctx.stroke();
    ctx.setLineDash([]);
    // rótulo principal
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='800 '+(n.labelSize||18)+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillStyle = pruned ? '#e2c6cf' : '#f2f6ff';
    ctx.fillText(n.label||'', x, n.level?y-7:y);
    // sub-rótulo (nível)
    if(n.level){ ctx.font='800 9px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle = pruned ? M.rgba(M.hex2rgb('#fb7185'),0.95) : M.rgba(M.shade(rgb,0.44),0.95);
      ctx.fillText(String(n.level).toUpperCase(), x, y+13); }
    // badge flutuante no topo
    if(n.badge){ ctx.font='800 9px "Segoe UI",system-ui,sans-serif';
      const bw=ctx.measureText(n.badge).width+12, bx=x-bw/2, by=T-8;
      M.roundRectPath(ctx,bx,by,bw,16,7); ctx.fillStyle = pruned?'#fb7185':M.rgba(rgb,0.96); ctx.fill();
      ctx.fillStyle='#0a0e18'; ctx.fillText(n.badge, x, by+8); }
    ctx.textBaseline='alphabetic'; ctx.restore();
  },
  hit(_i, n, wx, wy){ const w=n.w||120,h=n.h||70,x=n.x||0,y=n.y||0;
    if(wx>=x-w/2&&wx<=x+w/2&&wy>=y-h/2&&wy<=y+h/2)
      return { label:(n.label||'')+(n.level?' · '+n.level:''), info:n.info||'', color:n.color||'#38bdf8' };
    return false; }
});
