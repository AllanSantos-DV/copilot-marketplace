/* DESIGN SYSTEM · "edge" — aresta de grafo com glow e pulsos de fluxo.
   params: { x0,y0, x1,y1, color, label, flow, count, curve, width, dashed, arrow, dot, info }
     flow  = velocidade dos pulsos correndo pela aresta (0/ausente = estático)
     curve = "empeno" perpendicular em px de mundo (0 = reta; quadrática se ≠0)
     arrow = desenha ponta de seta no destino · dashed = tracejada
   Perf: sem gradiente por frame (strokes rgba); pulsos = arcs; largura em coords
   de mundo (w/e.zoom). Isola o estado do canvas com save/restore. */
VXK.register('edge', {
  create(n){ return {}; },
  _ctrl(n){ const x0=n.x0||0,y0=n.y0||0,x1=n.x1||0,y1=n.y1||0,cu=n.curve||0;
    const mx=(x0+x1)/2,my=(y0+y1)/2,dx=x1-x0,dy=y1-y0,L=Math.hypot(dx,dy)||1;
    return [ mx - dy/L*cu, my + dx/L*cu ]; },
  _pt(n,t){ const x0=n.x0||0,y0=n.y0||0,x1=n.x1||0,y1=n.y1||0;
    if(!n.curve) return [ x0+(x1-x0)*t, y0+(y1-y0)*t ];
    const c=this._ctrl(n), u=1-t;
    return [ u*u*x0+2*u*t*c[0]+t*t*x1, u*u*y0+2*u*t*c[1]+t*t*y1 ]; },
  _path(ctx,n){ const x0=n.x0||0,y0=n.y0||0,x1=n.x1||0,y1=n.y1||0;
    ctx.beginPath(); ctx.moveTo(x0,y0);
    if(!n.curve){ ctx.lineTo(x1,y1); } else { const c=this._ctrl(n); ctx.quadraticCurveTo(c[0],c[1],x1,y1); } },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, col=n.color||'#7c6cff', z=e.zoom, w=(n.width||2)/z, rgb=M.hex2rgb(col);
    ctx.save();
    ctx.lineCap='round';
    if(n.dashed) ctx.setLineDash([7/z, 6/z]);
    if(!e.lite){ this._path(ctx,n); ctx.strokeStyle=M.rgba(rgb,0.16); ctx.lineWidth=w*3.4; ctx.stroke(); }
    this._path(ctx,n); ctx.strokeStyle=selected?'#ffffff':M.rgba(rgb,0.82); ctx.lineWidth=w; ctx.stroke();
    ctx.setLineDash([]);
    if(n.arrow){ const a=this._pt(n,1), b=this._pt(n,0.97), ang=Math.atan2(a[1]-b[1],a[0]-b[0]), s=10/z;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]);
      ctx.lineTo(a[0]-Math.cos(ang-0.42)*s, a[1]-Math.sin(ang-0.42)*s);
      ctx.lineTo(a[0]-Math.cos(ang+0.42)*s, a[1]-Math.sin(ang+0.42)*s);
      ctx.closePath(); ctx.fillStyle=M.rgba(rgb,0.9); ctx.fill(); }
    if(n.flow){ const cnt=e.lite?1:(n.count||2), dr=(n.dot||3.2)/z, hi=M.shade(rgb,0.45);
      for(let i=0;i<cnt;i++){ let f=(e.t*n.flow + i/cnt)%1; if(f<0)f+=1; const p=this._pt(n,f);
        ctx.beginPath(); ctx.arc(p[0],p[1],dr,0,6.2832); ctx.fillStyle=M.rgba(hi,0.95); ctx.fill(); } }
    if(n.label){ const m=this._pt(n,0.5), fs=((11/z)|0)||1; ctx.font='600 '+fs+'px "Segoe UI",system-ui,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      const tw=ctx.measureText(n.label).width, px=6/z, py=3/z;
      M.roundRectPath(ctx, m[0]-tw/2-px, m[1]-fs/2-py, tw+px*2, fs+py*2, 4/z);
      ctx.fillStyle='rgba(10,15,26,.85)'; ctx.fill();
      ctx.strokeStyle=M.rgba(rgb,0.5); ctx.lineWidth=1/z; ctx.stroke();
      ctx.fillStyle=M.rgba(M.shade(rgb,0.4),1); ctx.fillText(n.label, m[0], m[1]);
      ctx.textBaseline='alphabetic'; }
    ctx.restore();
  },
  hit(_i, n, wx, wy){ if(!n.info) return false;
    let best=1e9; for(let i=0;i<=10;i++){ const p=this._pt(n,i/10); const d=Math.hypot(wx-p[0],wy-p[1]); if(d<best) best=d; }
    return best <= (n.width||2)+7; }
});
