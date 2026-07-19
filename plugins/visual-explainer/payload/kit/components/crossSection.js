/* DESIGN SYSTEM · "crossSection" — indicador FLAT de área em corte.
   params: { x, y, w, h, shape('rect'|'circle'), color, fill, angle, gap, label, lineWidth } */
(function(){
  function shapePath(ctx, shape, x, y, w, h){
    ctx.beginPath();
    if(shape==='circle'){
      ctx.arc(x, y, Math.min(w,h)/2, 0, Math.PI*2);
    } else {
      ctx.rect(x-w/2, y-h/2, w, h);
    }
    ctx.closePath();
  }

  VXK.register('crossSection', {
    create(n){ return {}; },
    draw(ctx, inst, n, e, selected){
      const z=e.zoom||1, k=1/z, M=e.mat;
      const x=Number(n.x)||0, y=Number(n.y)||0;
      const nw=Number(n.w), nh=Number(n.h);
      const w=Math.abs(Number.isFinite(nw)&&nw!==0?nw:160);
      const h=Math.abs(Number.isFinite(nh)&&nh!==0?nh:110);
      const shape=n.shape==='circle'?'circle':'rect';
      const color=n.color||'#7c89a6';
      const na=Number(n.angle), angle=(Number.isFinite(na)?na:45)*Math.PI/180;
      const ng=Number(n.gap), gap=Number.isFinite(ng)&&ng>0?ng:9;
      const nl=Number(n.lineWidth), lineWidth=Number.isFinite(nl)&&nl>0?nl:1;
      const hw=w/2, hh=h/2, r=Math.min(w,h)/2;
      const dx=Math.cos(angle), dy=Math.sin(angle);
      const nx=-dy, ny=dx;
      const offsetExtent=shape==='circle'?r:Math.abs(nx)*hw+Math.abs(ny)*hh;
      const lineExtent=shape==='circle'?r:Math.abs(dx)*hw+Math.abs(dy)*hh;
      const lineCount=Math.ceil(offsetExtent/gap)+1;

      ctx.save();
      shapePath(ctx, shape, x, y, w, h);
      if(n.fill){
        ctx.fillStyle=n.fill;
        ctx.fill();
      }
      if(typeof ctx.clip==='function') ctx.clip();

      ctx.beginPath();
      for(let i=-lineCount;i<=lineCount;i++){
        const offset=i*gap;
        const lx=x+nx*offset, ly=y+ny*offset;
        const span=lineExtent+gap;
        ctx.moveTo(lx-dx*span, ly-dy*span);
        ctx.lineTo(lx+dx*span, ly+dy*span);
      }
      ctx.strokeStyle=color;
      ctx.lineWidth=lineWidth*k;
      ctx.lineCap='butt';
      ctx.stroke();
      ctx.restore();

      ctx.save();
      shapePath(ctx, shape, x, y, w, h);
      ctx.strokeStyle=color;
      ctx.lineWidth=lineWidth*k;
      ctx.stroke();

      if(n.label){
        const text=String(n.label);
        const chipH=20*k, padX=8*k;
        ctx.font='700 '+(10*k)+'px "Segoe UI",system-ui,sans-serif';
        const chipW=ctx.measureText(text).width+padX*2;
        const left=shape==='circle'?x-r:x-hw;
        const top=shape==='circle'?y-r:y-hh;
        const chipX=shape==='circle'?x-chipW/2:left+10*k;
        const chipY=top-chipH/2;
        M.roundRectPath(ctx, chipX, chipY, chipW, chipH, 5*k);
        ctx.fillStyle='#0d1524';
        ctx.fill();
        M.roundRectPath(ctx, chipX, chipY, chipW, chipH, 5*k);
        ctx.strokeStyle=color;
        ctx.lineWidth=lineWidth*k;
        ctx.stroke();
        ctx.fillStyle=color;
        ctx.textAlign='center';
        ctx.textBaseline='middle';
        ctx.fillText(text, chipX+chipW/2, chipY+chipH/2);
      }
      ctx.restore();
    },
    hit(inst, n, wx, wy, e){
      const x=Number(n.x)||0, y=Number(n.y)||0;
      const nw=Number(n.w), nh=Number(n.h);
      const w=Math.abs(Number.isFinite(nw)&&nw!==0?nw:160);
      const h=Math.abs(Number.isFinite(nh)&&nh!==0?nh:110);
      let inside;
      if(n.shape==='circle'){
        const r=Math.min(w,h)/2, dx=wx-x, dy=wy-y;
        inside=dx*dx+dy*dy<=r*r;
      } else {
        inside=wx>=x-w/2&&wx<=x+w/2&&wy>=y-h/2&&wy<=y+h/2;
      }
      return inside
        ? {label:n.label||'corte', info:'Hachuras diagonais indicam material cortado e interior exposto.'}
        : false;
    }
  });
})();
