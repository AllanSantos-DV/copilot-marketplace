/* DESIGN SYSTEM · "dimensionLine" — indicador técnico de medida.
   params: { x0,y0,x1,y1, label, color, offset, ticks, arrows, boxLabel } */
VXK.register('dimensionLine', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0;
    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy);
    if(len<0.0001) return;

    const k=1/e.zoom, ux=dx/len, uy=dy/len, nx=-uy, ny=ux;
    const off=n.offset||0, ox=nx*off, oy=ny*off;
    const ax=x0+ox, ay=y0+oy, bx=x1+ox, by=y1+oy;
    const col=n.color||'#9db4ff';

    ctx.save();
    ctx.strokeStyle=col;
    ctx.fillStyle=col;
    ctx.lineWidth=1.4*k;
    ctx.lineCap='butt';
    ctx.lineJoin='miter';
    ctx.beginPath();
    ctx.moveTo(ax,ay);
    ctx.lineTo(bx,by);
    ctx.stroke();

    if(n.arrows){
      const size=Math.min(9*k,len*0.35), wing=Math.min(3.5*k,size*0.45);
      ctx.beginPath();
      ctx.moveTo(ax+ux*size,ay+uy*size);
      ctx.lineTo(ax+nx*wing,ay+ny*wing);
      ctx.lineTo(ax-nx*wing,ay-ny*wing);
      ctx.closePath();
      ctx.moveTo(bx-ux*size,by-uy*size);
      ctx.lineTo(bx+nx*wing,by+ny*wing);
      ctx.lineTo(bx-nx*wing,by-ny*wing);
      ctx.closePath();
      ctx.fill();
    } else if(n.ticks!==false){
      const half=5*k;
      ctx.beginPath();
      ctx.moveTo(ax-nx*half,ay-ny*half);
      ctx.lineTo(ax+nx*half,ay+ny*half);
      ctx.moveTo(bx-nx*half,by-ny*half);
      ctx.lineTo(bx+nx*half,by+ny*half);
      ctx.stroke();
    }

    if(n.label!=null && n.label!==''){
      const label=String(n.label), fontSize=Math.max(1,Math.round(12*k));
      const mx=(ax+bx)/2, my=(ay+by)/2;
      ctx.font='600 '+fontSize+'px Segoe UI';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      if(n.boxLabel!==false){
        const padX=7*k, padY=4*k;
        const boxW=ctx.measureText(label).width+padX*2, boxH=fontSize+padY*2;
        e.mat.roundRectPath(ctx,mx-boxW/2,my-boxH/2,boxW,boxH,5*k);
        ctx.fillStyle='#111827';
        ctx.fill();
        e.mat.roundRectPath(ctx,mx-boxW/2,my-boxH/2,boxW,boxH,5*k);
        ctx.strokeStyle=col;
        ctx.lineWidth=1*k;
        ctx.stroke();
        ctx.fillStyle='#eef3ff';
        ctx.fillText(label,mx,my);
      } else {
        ctx.fillStyle=col;
        ctx.fillText(label,mx+nx*8*k,my+ny*8*k);
      }
    }
    ctx.restore();
  },
  hit(){ return false; }
});
