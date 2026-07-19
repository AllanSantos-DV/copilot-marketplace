/* DESIGN SYSTEM · "pulse" — anéis concêntricos de ênfase que irradiam de um ponto.
   params: { x, y, color, r, count, speed, dot, ringWidth } */
VXK.register('pulse', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const x=n.x||0, y=n.y||0, color=n.color||'#5b8cff';
    const r=n.r!=null?n.r:34, count=n.count||3;
    const speed=n.speed!=null?n.speed:1, ringWidth=n.ringWidth!=null?n.ringWidth:2;
    const k=1/e.zoom, t=(e.t||0)*speed, baseAlpha=ctx.globalAlpha;
    ctx.strokeStyle=color; ctx.lineWidth=ringWidth*k;
    for(let i=0;i<count;i++){
      const fraction=(t+i/count)%1;
      ctx.globalAlpha=baseAlpha*(1-fraction);
      ctx.beginPath(); ctx.arc(x,y,fraction*r,0,6.2832); ctx.stroke();
    }
    ctx.globalAlpha=baseAlpha;
    if(n.dot!==false){
      ctx.beginPath(); ctx.arc(x,y,3*k,0,6.2832); ctx.fillStyle=color; ctx.fill();
    }
  },
  hit(){ return false; }
});
