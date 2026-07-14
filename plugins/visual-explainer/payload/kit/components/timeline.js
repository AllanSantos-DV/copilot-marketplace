/* DESIGN SYSTEM · "timeline" — eventos numa linha do tempo com playhead animado.
   params: { x0, x1, y, duration, color, events:[{t?, label, info, color?}] }
   t em segundos (>1) ou fração 0..1; se ausente, distribui igualmente. Clique num evento -> info. */
VXK.register('timeline', {
  create(n){ return { sel:-1 }; },
  _px(n, frac){ const x0=(n.x0!=null?n.x0:-260), x1=(n.x1!=null?n.x1:260); return x0+(x1-x0)*Math.max(0,Math.min(1,frac)); },
  _frac(n, ev, idx, N){ const dur=n.duration||Math.max(1,N); return ev.t!=null ? (ev.t>1?ev.t/dur:ev.t) : idx/Math.max(1,N-1); },
  draw(ctx, st, n, e, selected){
    const y=n.y||0, col=n.color||'#5b8cff', evs=n.events||[], N=evs.length, dur=n.duration||Math.max(1,N);
    const x0=(n.x0!=null?n.x0:-260), x1=(n.x1!=null?n.x1:260);
    ctx.strokeStyle='rgba(150,170,200,.35)'; ctx.lineWidth=3/e.zoom; ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke();
    evs.forEach((ev,idx)=>{ const x=this._px(n,this._frac(n,ev,idx,N));
      ctx.fillStyle=ev.color||col; ctx.beginPath(); ctx.arc(x,y, idx===st.sel?9:6, 0, 6.2832); ctx.fill();
      if(idx===st.sel){ ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.stroke(); }
      ctx.fillStyle='#cfd8ea'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center'; ctx.fillText(ev.label||'', x, y-14/e.zoom); });
    const ph=(e.t % dur)/dur, xp=this._px(n,ph);
    ctx.strokeStyle=col; ctx.lineWidth=2/e.zoom; ctx.beginPath(); ctx.moveTo(xp,y-18); ctx.lineTo(xp,y+18); ctx.stroke();
    ctx.fillStyle=col; ctx.beginPath(); ctx.moveTo(xp,y-18); ctx.lineTo(xp-5,y-26); ctx.lineTo(xp+5,y-26); ctx.closePath(); ctx.fill();
  },
  hit(st, n, wx, wy, e){ const y=n.y||0, evs=n.events||[], N=evs.length;
    for(let idx=0; idx<N; idx++){ const ev=evs[idx], x=this._px(n,this._frac(n,ev,idx,N));
      if(Math.hypot(wx-x, wy-y) <= 11){ st.sel=idx;
        return { label:ev.label||('Evento '+(idx+1)), color:ev.color||n.color||'#5b8cff', info:ev.info||'' }; } }
    return false; }
});
