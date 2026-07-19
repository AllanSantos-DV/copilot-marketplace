/* DESIGN SYSTEM · "legend" — chave de cores FLAT com tamanho automático.
   x,y são o canto superior esquerdo do painel.
   params: { x,y,title,items:[{color,label,shape:'dot'|'square'|'line'}],
             cols,swatch,gap,pad,tone,border } */
(function(){
  function finite(v, fallback, min){
    const x=Number(v);
    return Number.isFinite(x)?Math.max(min,x):fallback;
  }

  function layout(ctx, n, e){
    const k=1/(finite(e&&e.zoom,1,0.0001));
    const items=Array.isArray(n.items)?n.items:[];
    const cols=Math.min(items.length||1, Math.max(1, Math.floor(finite(n.cols,1,1))));
    const rows=Math.ceil(items.length/cols);
    const pad=finite(n.pad,12,0)*k, gap=finite(n.gap,8,0)*k;
    const swatch=finite(n.swatch,12,1)*k;
    const labelFs=12*k, titleFs=13*k, rowH=Math.max(swatch,16*k);
    const title=String(n.title||''), titleH=title?17*k:0;
    const colWidths=new Array(cols).fill(0);

    ctx.save();
    ctx.font='500 '+labelFs+'px "Segoe UI",system-ui,sans-serif';
    for(let i=0;i<items.length;i++){
      const item=items[i]||{}, label=String(item.label==null?'':item.label);
      colWidths[i%cols]=Math.max(colWidths[i%cols],swatch+gap+ctx.measureText(label).width);
    }
    ctx.font='700 '+titleFs+'px "Segoe UI",system-ui,sans-serif';
    const titleW=title?ctx.measureText(title).width:0;
    ctx.restore();

    const colGap=gap*2;
    const gridW=colWidths.reduce((sum,w)=>sum+w,0)+Math.max(0,cols-1)*colGap;
    const gridH=items.length?rows*rowH+Math.max(0,rows-1)*gap:0;
    const titleGap=title&&items.length?gap:0;
    const x=finite(n.x,0,-Infinity), y=finite(n.y,0,-Infinity);
    return {
      x,y,k,items,cols,pad,gap,swatch,labelFs,titleFs,rowH,title,titleH,colWidths,colGap,
      w:Math.max(titleW,gridW)+pad*2,
      h:titleH+titleGap+gridH+pad*2,
      itemsY:y+pad+titleH+titleGap
    };
  }

  VXK.register('legend',{
    create(n){return{};},
    draw(ctx,inst,n,e,selected){
      const M=e.mat, g=layout(ctx,n,e), border=n.border===undefined?'rgba(255,255,255,.16)':n.border;
      inst.bounds={x:g.x,y:g.y,w:g.w,h:g.h};
      ctx.save();
      M.roundRectPath(ctx,g.x,g.y,g.w,g.h,9*g.k);
      ctx.fillStyle=n.tone||'rgba(12,17,28,.9)';
      ctx.fill();
      if(border!==false&&border!=='none'){
        M.roundRectPath(ctx,g.x,g.y,g.w,g.h,9*g.k);
        ctx.strokeStyle=selected?'rgba(255,255,255,.72)':border;
        ctx.lineWidth=(selected?1.6:1)*g.k;
        ctx.stroke();
      }

      ctx.textAlign='left';
      ctx.textBaseline='top';
      if(g.title){
        ctx.font='700 '+g.titleFs+'px "Segoe UI",system-ui,sans-serif';
        ctx.fillStyle='#f1f5ff';
        ctx.fillText(g.title,g.x+g.pad,g.y+g.pad);
      }

      ctx.font='500 '+g.labelFs+'px "Segoe UI",system-ui,sans-serif';
      ctx.textBaseline='middle';
      let colX=g.x+g.pad;
      for(let c=0;c<g.cols;c++){
        for(let r=0;r<Math.ceil(g.items.length/g.cols);r++){
          const i=r*g.cols+c;
          if(i>=g.items.length) continue;
          const item=g.items[i]||{}, color=item.color||'#8ab4ff';
          const cy=g.itemsY+r*(g.rowH+g.gap)+g.rowH/2;
          ctx.fillStyle=color;
          if(item.shape==='dot'){
            ctx.beginPath();
            ctx.arc(colX+g.swatch/2,cy,g.swatch/2,0,Math.PI*2);
            ctx.fill();
          }else if(item.shape==='line'){
            ctx.beginPath();
            ctx.moveTo(colX,cy);
            ctx.lineTo(colX+g.swatch,cy);
            ctx.strokeStyle=color;
            ctx.lineWidth=3*g.k;
            ctx.lineCap='round';
            ctx.stroke();
          }else{
            M.roundRectPath(ctx,colX,cy-g.swatch/2,g.swatch,g.swatch,2*g.k);
            ctx.fill();
          }
          ctx.fillStyle='rgba(236,241,250,.84)';
          ctx.fillText(String(item.label==null?'':item.label),colX+g.swatch+g.gap,cy);
        }
        colX+=g.colWidths[c]+g.colGap;
      }
      ctx.restore();
    },
    hit(inst,n,wx,wy,e){
      const b=e&&e.ctx?layout(e.ctx,n,e):(inst&&inst.bounds);
      if(!b||wx<b.x||wx>b.x+b.w||wy<b.y||wy>b.y+b.h) return false;
      const labels=(Array.isArray(n.items)?n.items:[])
        .map(item=>item&&item.label!=null?String(item.label):'').filter(Boolean);
      return {label:n.title||'legenda',info:labels.length?labels.join(' · '):'Sem itens'};
    }
  });
})();
