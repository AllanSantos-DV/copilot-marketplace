/* DESIGN SYSTEM · "deviceCard" — card de arquitetura para sistema/serviço.
   params: { x, y, w, h, icon, label, sublabel, color, accent, stroke,
             textColor, badge, badgeColor, ports, scale, info }
   (x,y = centro). `scale` (default 1) multiplica a geometria para pop.
   Usa o card canônico do design system: tint sutil + hairline + faixa de accent no
   topo + ícone em container tintado + título (tracking) + subtítulo (cor secundária)
   + badge-pílula + portas de conexão. FLAT. */
VXK.register('deviceCard', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, zoom=e.zoom, k=1/zoom, sc=n.scale!=null?n.scale:1;
    const w=(n.w!=null?n.w:190)*sc, h=(n.h!=null?n.h:88)*sc, x=n.x||0, y=n.y||0, L=x-w/2, T=y-h/2;
    const rad=Math.min(12*sc, w/2, h/2), acc=n.accent||'#5b8cff';
    const fill=n.color||'#1c2942', text=n.textColor||M.ds.text.primary;

    M.card(ctx, L, T, w, h, { zoom, radius:rad, fill, stroke:n.stroke, selected, accent:acc, accentTop:true });

    const hasIcon=n.icon && typeof VXK!=='undefined' && VXK.drawIcon && VXK.hasIcon && VXK.hasIcon(n.icon);
    const isz=Math.max(18, Math.min((n.h!=null?n.h:88)*0.32, 26))*sc, icx=L+16*sc+isz/2, icy=y+2*sc;
    if(hasIcon) M.iconChip(ctx, icx, icy, isz, n.icon, acc, zoom);

    // badge pílula (canto superior-direito), micro-label em UPPERCASE com tracking
    let badgeBox=null;
    if(n.badge!=null && n.badge!==''){
      const badge=String(n.badge).toUpperCase(), bfs=Math.max(1,Math.round(10*sc*k));
      ctx.font='800 '+bfs+'px "Segoe UI",system-ui,sans-serif'; ctx.letterSpacing=(0.5*sc*k)+'px';
      const bw=ctx.measureText(badge).width+14*sc*k, bh=18*sc*k;
      const bx=L+w-bw-10*sc*k, by=T+10*sc*k;
      const badgeCol=n.badgeColor||acc, brgb=M.hex2rgb(badgeCol);
      M.roundRectPath(ctx,bx,by,bw,bh,bh/2); ctx.fillStyle=M.rgba(brgb,0.16); ctx.fill();
      M.roundRectPath(ctx,bx,by,bw,bh,bh/2); ctx.strokeStyle=M.rgba(brgb,0.55); ctx.lineWidth=1*k; ctx.stroke();
      ctx.fillStyle=badgeCol; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(badge,bx+bw/2,by+bh/2+0.3*k);
      ctx.letterSpacing='0px'; badgeBox={ left:bx, width:bw };
    }

    const tx=hasIcon?icx+isz*0.68+12*sc:L+16*sc;
    const textRight=badgeBox?badgeBox.left-8*sc*k:L+w-16*sc;
    const textWidth=Math.max(0,textRight-tx);
    ctx.textAlign='left'; ctx.fillStyle=text;
    if(textWidth>0 && n.sublabel){
      ctx.textBaseline='alphabetic';
      M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', tx, y-2*sc, textWidth);
      M.type(ctx,'sublabel',zoom); ctx.fillStyle=n.subColor||M.ds.text.secondary; ctx.fillText(n.sublabel, tx, y+15*sc, textWidth);
    } else if(textWidth>0){
      ctx.textBaseline='middle'; M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', tx, y+2*sc, textWidth);
    }
    ctx.letterSpacing='0px'; ctx.textBaseline='alphabetic';

    const ports=Math.max(0,Math.floor(Number(n.ports)||0));
    if(ports){
      const gap=Math.min(13*sc,h/(ports+2)), pr=3*sc;
      ctx.fillStyle=acc; ctx.strokeStyle=selected?'#ffffff':fill; ctx.lineWidth=1.1*k;
      for(let i=0;i<ports;i++){ const py=y+(i-(ports-1)/2)*gap;
        ctx.beginPath(); ctx.arc(L,py,pr,0,6.2832); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(L+w,py,pr,0,6.2832); ctx.fill(); ctx.stroke(); }
    }
  },
  hit(_i,n,wx,wy){
    const sc=n.scale!=null?n.scale:1, w=(n.w!=null?n.w:190)*sc, h=(n.h!=null?n.h:88)*sc;
    const x=n.x||0, y=n.y||0;
    return wx>=x-w/2&&wx<=x+w/2&&wy>=y-h/2&&wy<=y+h/2 ? {label:n.label,info:n.info||n.sublabel} : false;
  },
  parts(n){
    const sc=n.scale!=null?n.scale:1, w=(n.w!=null?n.w:190)*sc, h=(n.h!=null?n.h:88)*sc;
    const x=n.x||0, y=n.y||0;
    return {center:[x,y],left:[x-w/2,y],right:[x+w/2,y],top:[x,y-h/2]};
  }
});
