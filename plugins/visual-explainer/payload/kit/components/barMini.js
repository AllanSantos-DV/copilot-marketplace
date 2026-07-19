/* DESIGN SYSTEM · "barMini" — gráfico compacto de barras verticais.
   params: { x, y, w, h, values, max, color, colors?, highlight?, labels?, gap, baseline }
   (x,y = canto superior esquerdo). */
VXK.register('barMini', {
  create(n){ return {}; },
  pos(n){ const x=n.x!=null?n.x:0, y=n.y!=null?n.y:0, w=n.w!=null?n.w:180, h=n.h!=null?n.h:90;
    return [x+w/2, y+h/2]; },
  draw(ctx, inst, n, e, selected){
    const x=n.x!=null?n.x:0, y=n.y!=null?n.y:0;
    const w=Math.max(0,n.w!=null?n.w:180), h=Math.max(0,n.h!=null?n.h:90);
    const vals=Array.isArray(n.values)?n.values:[], N=vals.length;
    const labels=Array.isArray(n.labels)?n.labels:null, labelH=labels&&N?18/e.zoom:0;
    const baseY=y+Math.max(0,h-labelH), plotH=Math.max(0,baseY-y);
    const gap=Math.max(0,n.gap!=null?n.gap:8);
    const barW=N?Math.max(0,(w-gap*(N-1))/N):0;
    let maxVal=0;
    for(let k=0;k<N;k++) if(typeof vals[k]==='number' && isFinite(vals[k])) maxVal=Math.max(maxVal,vals[k]);
    if(n.max!=null && typeof n.max==='number' && isFinite(n.max)) maxVal=n.max;

    ctx.save();
    for(let k=0;k<N;k++){
      const v=typeof vals[k]==='number'&&isFinite(vals[k])?vals[k]:0;
      const bh=maxVal>0?plotH*Math.max(0,Math.min(1,v/maxVal)):0;
      if(bh<=0 || barW<=0) continue;
      const bx=x+k*(barW+gap), by=baseY-bh, r=Math.min(4/e.zoom,barW/2,bh);
      let col=Array.isArray(n.colors)&&n.colors[k]?n.colors[k]:(n.color||'#5b8cff');
      if(k===n.highlight) col=e.mat.rgba(e.mat.shade(e.mat.hex2rgb(col),.3),1);
      ctx.beginPath(); ctx.moveTo(bx,baseY); ctx.lineTo(bx,by+r);
      ctx.arcTo(bx,by,bx+r,by,r); ctx.lineTo(bx+barW-r,by);
      ctx.arcTo(bx+barW,by,bx+barW,by+r,r); ctx.lineTo(bx+barW,baseY);
      ctx.closePath(); ctx.fillStyle=col; ctx.fill();
    }

    if(n.baseline!==false){
      ctx.beginPath(); ctx.moveTo(x,baseY); ctx.lineTo(x+w,baseY);
      ctx.strokeStyle=selected?'#eef3ff':'rgba(238,243,255,.48)';
      ctx.lineWidth=(selected?1.5:1)/e.zoom; ctx.stroke();
    }
    if(labels&&N){
      ctx.fillStyle='rgba(238,243,255,.72)';
      ctx.font=(((10/e.zoom)|0)||1)+'px Segoe UI';
      ctx.textAlign='center'; ctx.textBaseline='top';
      for(let k=0;k<N;k++) if(labels[k]!=null) ctx.fillText(String(labels[k]),x+k*(barW+gap)+barW/2,baseY+5/e.zoom);
    }
    ctx.restore();
  },
  hit(_i,n,wx,wy,e){
    const x=n.x!=null?n.x:0, y=n.y!=null?n.y:0;
    const w=Math.max(0,n.w!=null?n.w:180), h=Math.max(0,n.h!=null?n.h:90);
    if(wx<x || wx>x+w || wy<y || wy>y+h) return false;
    const vals=Array.isArray(n.values)?n.values:[], N=vals.length;
    const labels=Array.isArray(n.labels)?n.labels:null, labelH=labels&&N?18/e.zoom:0;
    const baseY=y+Math.max(0,h-labelH), plotH=Math.max(0,baseY-y);
    const gap=Math.max(0,n.gap!=null?n.gap:8), barW=N?Math.max(0,(w-gap*(N-1))/N):0;
    let maxVal=0;
    for(let k=0;k<N;k++) if(typeof vals[k]==='number'&&isFinite(vals[k])) maxVal=Math.max(maxVal,vals[k]);
    if(n.max!=null&&typeof n.max==='number'&&isFinite(n.max)) maxVal=n.max;
    for(let k=0;k<N;k++){
      const v=typeof vals[k]==='number'&&isFinite(vals[k])?vals[k]:0;
      const bh=maxVal>0?plotH*Math.max(0,Math.min(1,v/maxVal)):0, bx=x+k*(barW+gap);
      if(wx>=bx&&wx<=bx+barW&&wy>=baseY-bh&&wy<=baseY){
        let col=Array.isArray(n.colors)&&n.colors[k]?n.colors[k]:(n.color||'#5b8cff');
        if(k===n.highlight) col=e.mat.rgba(e.mat.shade(e.mat.hex2rgb(col),.3),1);
        return {label:n.label||'dados',info:(labels&&labels[k]!=null?labels[k]:'Barra '+(k+1))+': '+v,color:col};
      }
    }
    return {label:n.label||'dados',info:N?'Valores: '+vals.join(', '):'Sem valores',color:n.color||'#5b8cff'};
  }
});
