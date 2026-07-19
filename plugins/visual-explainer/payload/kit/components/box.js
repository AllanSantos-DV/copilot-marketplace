/* DESIGN SYSTEM · "box" — caixa/CARD rotulado (etapa, estado, bloco, serviço).
   params: { x, y, w, h, label, sublabel, icon, iconColor, subColor, color, stroke, textColor, radius, flat, scale }
   (x,y = centro). Usa o card canônico do design system: superfície com tint sutil + hairline
   + radius; com `icon` (nome Lucide) vira CARD RICO — ícone em container tintado + barra de accent
   + título (tracking negativo) + subtítulo (cor secundária). Sem `icon`, rótulo centrado. FLAT. */
VXK.register('box', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, zoom=e.zoom, sc=(n.scale!=null?n.scale:1);
    const hb=(n.h||50), w=(n.w||120)*sc, h=hb*sc, x=n.x||0, y=n.y||0, L=x-w/2, T=y-h/2;
    const rad=Math.min((n.radius!=null?n.radius:9)*sc, w/2, h/2);
    const acc=n.iconColor||n.accent||'#8ab4ff';
    const hasIcon=n.icon && typeof VXK!=='undefined' && VXK.drawIcon && VXK.hasIcon && VXK.hasIcon(n.icon);

    M.card(ctx, L, T, w, h, { zoom, radius:rad, fill:n.color, stroke:n.stroke, selected, accent:acc, accentBar:hasIcon });

    if(hasIcon){
      const isz=Math.max(18, Math.min(hb*0.44, 30))*sc, icx=L+16*sc+isz/2;
      M.iconChip(ctx, icx, y, isz, n.icon, acc, zoom);
      const tx=icx + isz*0.68 + 12*sc;
      ctx.textAlign='left'; ctx.fillStyle=n.textColor||M.ds.text.primary;
      if(n.sublabel){
        ctx.textBaseline='alphabetic';
        M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', tx, y-2*sc);
        M.type(ctx,'sublabel',zoom); ctx.fillStyle=n.subColor||M.ds.text.secondary; ctx.fillText(n.sublabel, tx, y+14*sc);
      } else { ctx.textBaseline='middle'; M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', tx, y); }
    } else {
      ctx.textAlign='center'; ctx.fillStyle=n.textColor||M.ds.text.primary;
      if(n.sublabel){
        ctx.textBaseline='alphabetic';
        M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', x, y-6*sc);
        M.type(ctx,'sublabel',zoom); ctx.fillStyle=n.subColor||M.ds.text.secondary; ctx.fillText(n.sublabel, x, y+10*sc);
      } else { ctx.textBaseline='middle'; M.type(ctx,'cardTitle',zoom); ctx.fillText(n.label||'', x, y); }
    }
    ctx.letterSpacing='0px'; ctx.textBaseline='alphabetic';
  },
  hit(_i, n, wx, wy){ const sc=(n.scale!=null?n.scale:1), w=(n.w||120)*sc, h=(n.h||50)*sc, x=n.x||0, y=n.y||0;
    return wx>=x-w/2 && wx<=x+w/2 && wy>=y-h/2 && wy<=y+h/2; }
});
