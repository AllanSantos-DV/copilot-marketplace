/* DESIGN SYSTEM · "card" — cartão de texto rico (kicker + título + corpo + badge).
   params: { x,y (centro), w,h, kicker, title, body, color, badge, icon, tone, info, label }
     body  = texto; aceita "\n" p/ quebras/bullets · tone:'solid' = painel tingido
     badge = pílula no canto superior direito · icon = glifo curto (emoji/char)
   O texto é mundo-fixo (escala com o zoom da cena) e a quebra de linha é CACHEADA
   no inst (só recalcula se body/w/fonte mudarem). Sem shadowBlur; glow de seleção
   é radialGradient CACHEADO (origem + translate). Clicável -> painel lateral. */
VXK.register('card', {
  create(n){ return { wrap:null, wsig:'', glow:null, gsig:'' }; },
  _wrap(ctx, inst, n, fs, maxw){
    const sig=(n.body||'')+'|'+maxw+'|'+fs;
    if(inst.wsig===sig) return inst.wrap;
    inst.wsig=sig; ctx.font=fs+'px "Segoe UI",system-ui,sans-serif';
    const out=[];
    for(const para of String(n.body||'').split('\n')){
      const words=para.split(/\s+/).filter(Boolean); let line='';
      if(!words.length){ out.push(''); continue; }
      for(const wd of words){ const t=line?line+' '+wd:wd;
        if(ctx.measureText(t).width>maxw && line){ out.push(line); line=wd; } else line=t; }
      if(line) out.push(line);
    }
    inst.wrap=out; return out;
  },
  _wrapLine(ctx, s, maxw){ const words=String(s).split(/\s+/), out=[]; let line='';
    for(const wd of words){ const t=line?line+' '+wd:wd; if(ctx.measureText(t).width>maxw && line){ out.push(line); line=wd; } else line=t; }
    if(line) out.push(line); return out; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, w=n.w||300, h=n.h||170, x=n.x||0, y=n.y||0, rad=14, z=e.zoom;
    const col=n.color||'#38bdf8', rgb=M.hex2rgb(col), L=x-w/2, T=y-h/2, pad=16, solid=n.tone==='solid';
    ctx.save();
    // glow de seleção (gradiente cacheado)
    if(selected && !e.lite){ const gsig=col+'|'+w+'|'+h;
      if(inst.gsig!==gsig){ inst.gsig=gsig; const R=Math.max(w,h)*0.72;
        const g=ctx.createRadialGradient(0,0,Math.min(w,h)*0.28, 0,0,R);
        g.addColorStop(0,M.rgba(rgb,0.22)); g.addColorStop(1,M.rgba(rgb,0)); inst.glow=g; inst.glowR=R; }
      ctx.save(); ctx.translate(x,y); ctx.beginPath(); ctx.arc(0,0,inst.glowR,0,6.2832); ctx.fillStyle=inst.glow; ctx.fill(); ctx.restore(); }
    // painel + borda
    M.roundRectPath(ctx,L,T,w,h,rad); ctx.fillStyle=solid?M.rgba(M.shade(rgb,-0.52),0.94):'rgba(15,22,37,0.93)'; ctx.fill();
    M.roundRectPath(ctx,L,T,w,h,rad); ctx.strokeStyle=selected?'#ffffff':M.rgba(rgb,solid?0.85:0.5); ctx.lineWidth=(selected?2.2:1.3)/z; ctx.stroke();
    // barra de acento à esquerda (cantos seguem o raio)
    ctx.save(); M.roundRectPath(ctx,L,T,w,h,rad); ctx.clip(); ctx.fillStyle=M.rgba(rgb,0.95); ctx.fillRect(L,T,5,h); ctx.restore();
    // conteúdo
    ctx.textAlign='left'; ctx.textBaseline='top';
    let ty=T+pad-1; const cx0=L+pad;
    if(n.icon){ ctx.font='700 19px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle=M.rgba(rgb,1); ctx.fillText(n.icon, cx0, ty-2); }
    if(n.kicker){ ctx.font='800 11px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle=M.rgba(M.shade(rgb,0.4),1);
      ctx.fillText(String(n.kicker).toUpperCase(), cx0+(n.icon?28:0), ty+2); ty+=19; }
    if(n.title){ ctx.font='800 16px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle=solid?'#ffffff':'#eaf1ff';
      for(const ln of this._wrapLine(ctx,n.title,w-pad*2)){ ctx.fillText(ln, cx0, ty); ty+=20; } ty+=4; }
    if(n.body){ const fs=13, lines=this._wrap(ctx,inst,n,fs,w-pad*2);
      ctx.font=fs+'px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle=solid?'#dbe6fb':'#a9b6d3';
      for(const ln of lines){ if(ty>T+h-pad+3) break; ctx.fillText(ln, cx0, ty); ty+=fs+5; } }
    if(n.badge){ ctx.font='800 10px "Segoe UI",system-ui,sans-serif'; const bw=ctx.measureText(n.badge).width+14, bx=L+w-bw-9, by=T+9;
      M.roundRectPath(ctx,bx,by,bw,19,7); ctx.fillStyle=M.rgba(rgb,0.95); ctx.fill();
      ctx.fillStyle='#0a0e18'; ctx.textBaseline='middle'; ctx.fillText(n.badge, bx+7, by+10); }
    ctx.textBaseline='alphabetic'; ctx.restore();
  },
  hit(_i, n, wx, wy){ const w=n.w||300,h=n.h||170,x=n.x||0,y=n.y||0; return wx>=x-w/2&&wx<=x+w/2&&wy>=y-h/2&&wy<=y+h/2; }
});
