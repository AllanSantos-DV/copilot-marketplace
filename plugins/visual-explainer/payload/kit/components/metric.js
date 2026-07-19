/* DESIGN SYSTEM · "metric" — KPI numérico animável.
   params: { x, y, value, label, prefix, suffix, decimals, color, accent, size, sublabel } */
(function(){
  function metricText(n){
    const raw=Number(n.value), value=Number.isFinite(raw)?raw:0;
    const rawDecimals=n.decimals==null?0:Number(n.decimals);
    const decimals=Number.isFinite(rawDecimals)?Math.max(0,Math.min(100,Math.round(rawDecimals))):0;
    const prefix=n.prefix==null?'':String(n.prefix), suffix=n.suffix==null?'':String(n.suffix);
    return prefix+value.toFixed(decimals)+suffix;
  }

  function metricLayout(n, e){
    const zoom=Math.abs(Number(e&&e.zoom))||1;
    const rawSize=n.size==null?44:Number(n.size);
    const size=Number.isFinite(rawSize)?Math.max(1,rawSize):44;
    const x=Number.isFinite(Number(n.x))?Number(n.x):0;
    const y=Number.isFinite(Number(n.y))?Number(n.y):0;
    const hasLabel=n.label!=null && String(n.label)!=='';
    const hasSublabel=n.sublabel!=null && String(n.sublabel)!=='';
    const hasAccent=n.accent!==false && n.accent!==null;
    const labelSize=Math.max(11,size*0.3), sublabelSize=Math.max(9,size*0.23);
    const underlineWidth=Math.max(22,Math.min(44,size*0.72));
    let total=size;
    if(hasAccent) total+=9;
    if(hasLabel) total+=9+labelSize;
    if(hasSublabel) total+=4+sublabelSize;

    let cursor=-total/2;
    const numberY=y+(cursor+size/2)/zoom;
    cursor+=size;
    let underlineY=null;
    if(hasAccent){ cursor+=7; underlineY=y+(cursor+1)/zoom; cursor+=2; }
    let labelY=null;
    if(hasLabel){ cursor+=9; labelY=y+(cursor+labelSize/2)/zoom; cursor+=labelSize; }
    let sublabelY=null;
    if(hasSublabel){ cursor+=4; sublabelY=y+(cursor+sublabelSize/2)/zoom; }

    return {zoom,size,x,y,hasLabel,hasSublabel,hasAccent,labelSize,sublabelSize,
      underlineWidth,total,numberY,underlineY,labelY,sublabelY,text:metricText(n)};
  }

  VXK.register('metric', {
    create(n){ return {}; },
    draw(ctx, inst, n, e, selected){
      const m=metricLayout(n,e);
      ctx.save();
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.fillStyle=n.color||'#eef3ff';
      ctx.font='700 '+(m.size/m.zoom)+'px Segoe UI';
      ctx.fillText(m.text,m.x,m.numberY);

      if(m.hasAccent){
        ctx.fillStyle=n.accent||'#5b8cff';
        ctx.fillRect(m.x-m.underlineWidth/(2*m.zoom),m.underlineY-1/m.zoom,
          m.underlineWidth/m.zoom,2/m.zoom);
      }
      if(m.hasLabel){
        ctx.fillStyle='#9aa7c2';
        ctx.font='600 '+(m.labelSize/m.zoom)+'px Segoe UI';
        ctx.fillText(String(n.label),m.x,m.labelY);
      }
      if(m.hasSublabel){
        ctx.fillStyle='#74829a';
        ctx.font=(m.sublabelSize/m.zoom)+'px Segoe UI';
        ctx.fillText(String(n.sublabel),m.x,m.sublabelY);
      }
      ctx.restore();
    },
    hit(inst, n, wx, wy, e){
      const m=metricLayout(n,e), ctx=e&&e.ctx;
      let width=m.text.length*m.size*0.6/m.zoom;
      if(ctx && typeof ctx.measureText==='function'){
        ctx.save();
        ctx.font='700 '+(m.size/m.zoom)+'px Segoe UI';
        width=ctx.measureText(m.text).width;
        if(m.hasLabel){
          ctx.font='600 '+(m.labelSize/m.zoom)+'px Segoe UI';
          width=Math.max(width,ctx.measureText(String(n.label)).width);
        }
        if(m.hasSublabel){
          ctx.font=(m.sublabelSize/m.zoom)+'px Segoe UI';
          width=Math.max(width,ctx.measureText(String(n.sublabel)).width);
        }
        ctx.restore();
      }
      if(m.hasAccent) width=Math.max(width,m.underlineWidth/m.zoom);
      const inside=Math.abs(wx-m.x)<=width/2+6/m.zoom &&
        Math.abs(wy-m.y)<=m.total/(2*m.zoom)+4/m.zoom;
      return inside?{label:n.label,info:m.text}:false;
    }
  });
})();
