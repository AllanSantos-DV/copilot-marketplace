/* DESIGN SYSTEM · "arrow" — seta conectora (direção de fluxo). Decorativa (não clicável).
   params: { x0,y0, x1,y1, color, label, dashed, flow, flowColor, flowCount, flowSpeed, prog }
   `prog` (0..1, default 1) = WRITE-ON: desenha só até a fração prog, com a ponta na frente —
   anime prog de 0→1 num passo para a seta "se desenhar" (torna a causalidade visível). */
VXK.register('arrow', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0, col=n.color||'#8aa0c0';
    const prog=(n.prog!=null?Math.max(0,Math.min(1,n.prog)):1); if(prog<=0.001) return;
    const ex=x0+(x1-x0)*prog, ey=y0+(y1-y0)*prog;                     // ponta atual (write-on)
    ctx.strokeStyle=col; ctx.lineWidth=2/e.zoom;
    if(n.dashed) ctx.setLineDash([6/e.zoom, 5/e.zoom]);
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.setLineDash([]);
    const a=Math.atan2(y1-y0, x1-x0), s=10/e.zoom;
    ctx.beginPath(); ctx.moveTo(ex,ey);
    ctx.lineTo(ex-Math.cos(a-0.42)*s, ey-Math.sin(a-0.42)*s);
    ctx.lineTo(ex-Math.cos(a+0.42)*s, ey-Math.sin(a+0.42)*s);
    ctx.closePath(); ctx.fillStyle=col; ctx.fill();
    if(n.flow){                                                        // pulso FLAT que corre na direção do fluxo (loop pelo relógio)
      const cnt=n.flowCount||3, spd=n.flowSpeed||1, fcol=n.flowColor||col;
      const dx=x1-x0, dy=y1-y0, t=(e.t||0)*spd, r=3/e.zoom;
      const ux=Math.cos(a), uy=Math.sin(a), back=s*0.9;               // some antes da ponta p/ não cobrir a seta
      for(let i=0;i<cnt;i++){ let f=((t + i/cnt) % 1); if(f>prog) continue;   // só na parte já desenhada
        const px=x0+dx*f - ux*back*f, py=y0+dy*f - uy*back*f;
        ctx.beginPath(); ctx.arc(px,py, r, 0, 6.2832); ctx.fillStyle=fcol; ctx.globalAlpha=0.85; ctx.fill(); ctx.globalAlpha=1; }
    }
    if(n.label && prog>0.5){ ctx.fillStyle='#9aa7c2'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center';
      ctx.fillText(n.label, (x0+x1)/2, (y0+y1)/2 - 6/e.zoom); }
  },
  hit(){ return false; }
});
