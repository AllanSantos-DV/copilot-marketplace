/* DESIGN SYSTEM · "flowPipe" — conector tubular FLAT com escrita progressiva e
   pacotes direcionais em movimento. Decorativo (não clicável). params:
   { x0,y0, x1,y1, curve, width, color, trackColor, flow, flowCount,
     flowSpeed, tokenColor, arrow, dashed, prog, label } */
VXK.register('flowPipe', {
  create(n){ return { xs:[], ys:[], lens:[] }; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, k=1/e.zoom, x0=n.x0||0, y0=n.y0||0, x1=n.x1||0, y1=n.y1||0;
    const curve=n.curve!=null?n.curve:0, width=n.width!=null?Math.max(0,n.width):6;
    const col=n.color||'#5b8cff', track=n.trackColor||M.rgba(M.hex2rgb(col),0.22);
    const prog=n.prog!=null?Math.max(0,Math.min(1,n.prog)):1;
    if(prog<=0.001 || width<=0.001) return;

    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy), nx=len?-dy/len:0, ny=len?dx/len:0;
    const cx=(x0+x1)/2+nx*curve, cy=(y0+y1)/2+ny*curve;
    const steps=32, xs=inst.xs, ys=inst.ys, lens=inst.lens;
    let total=0, lastX=x0, lastY=y0;
    for(let i=0;i<=steps;i++){
      const u=i/steps, v=1-u, px=v*v*x0+2*v*u*cx+u*u*x1, py=v*v*y0+2*v*u*cy+u*u*y1;
      xs[i]=px; ys[i]=py;
      if(i) total+=Math.hypot(px-lastX,py-lastY);
      lens[i]=total; lastX=px; lastY=py;
    }
    const paramAt=f=>{
      if(total<=0.001) return 0;
      const target=Math.max(0,Math.min(1,f))*total;
      let i=1; while(i<=steps && lens[i]<target) i++;
      if(i>steps) return 1;
      const span=lens[i]-lens[i-1], mix=span>0?(target-lens[i-1])/span:0;
      return (i-1+mix)/steps;
    };
    const pointAt=u=>{
      const v=1-u;
      return [v*v*x0+2*v*u*cx+u*u*x1, v*v*y0+2*v*u*cy+u*u*y1];
    };
    const uEnd=paramAt(prog), end=pointAt(uEnd), qx=x0+(cx-x0)*uEnd, qy=y0+(cy-y0)*uEnd;
    const txEnd=2*(1-uEnd)*(cx-x0)+2*uEnd*(x1-cx);
    const tyEnd=2*(1-uEnd)*(cy-y0)+2*uEnd*(y1-cy);
    const tLen=Math.hypot(txEnd,tyEnd)||1, uxEnd=txEnd/tLen, uyEnd=tyEnd/tLen;
    const headLen=Math.max(10,width*1.6)*k, headHalf=Math.max(4,width*0.85)*k;

    ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.strokeStyle=track; ctx.lineWidth=width*k;
    if(n.dashed) ctx.setLineDash([6*k,5*k]);
    ctx.beginPath(); ctx.moveTo(x0,y0);
    if(Math.abs(curve)>0.001 && len>0.001) ctx.quadraticCurveTo(qx,qy,end[0],end[1]);
    else ctx.lineTo(end[0],end[1]);
    ctx.stroke(); ctx.setLineDash([]);

    if(n.flow!==false){
      const count=Math.max(0,Math.round(n.flowCount!=null?n.flowCount:4));
      const speed=n.flowSpeed!=null?n.flowSpeed:1, token=n.tokenColor||col;
      const tokenLen=Math.max(7,width*1.15)*k, tokenWidth=Math.max(2,width*0.48)*k;
      ctx.strokeStyle=token; ctx.lineWidth=tokenWidth; ctx.globalAlpha=0.9;
      for(let i=0;i<count;i++){
        const raw=(e.t||0)*speed+i/count, f=((raw%1)+1)%1;
        if(f>prog || (n.arrow!==false && (prog-f)*total<headLen*0.9)) continue;
        const u=paramAt(f), p=pointAt(u);
        let tx=2*(1-u)*(cx-x0)+2*u*(x1-cx), ty=2*(1-u)*(cy-y0)+2*u*(y1-cy);
        const tl=Math.hypot(tx,ty)||1; tx/=tl; ty/=tl;
        ctx.beginPath(); ctx.moveTo(p[0]-tx*tokenLen/2,p[1]-ty*tokenLen/2);
        ctx.lineTo(p[0]+tx*tokenLen/2,p[1]+ty*tokenLen/2); ctx.stroke();
      }
      ctx.globalAlpha=1;
    }

    if(n.arrow!==false){
      const bx=end[0]-uxEnd*headLen, by=end[1]-uyEnd*headLen;
      ctx.beginPath(); ctx.moveTo(end[0],end[1]);
      ctx.lineTo(bx-uyEnd*headHalf,by+uxEnd*headHalf);
      ctx.lineTo(bx+uyEnd*headHalf,by-uxEnd*headHalf);
      ctx.closePath(); ctx.fillStyle=col; ctx.fill();
    }
    if(n.label && prog>0.5){
      const p=pointAt(paramAt(0.5));
      ctx.fillStyle='#9aa7c2'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center';
      ctx.fillText(n.label,p[0],p[1]-(width/2+7)*k);
    }
    ctx.restore();
  },
  hit(){ return false; }
});
