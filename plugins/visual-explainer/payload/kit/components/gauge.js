/* DESIGN SYSTEM · "gauge" — medidor de arco FLAT para nível, progresso ou score.
   params: { x, y, r, value, min, max, label, unit, color, track, showValue,
             startAngle, endAngle } (ângulos em radianos). */
VXK.register('gauge', {
  create(n){ return {}; },
  pos(n){ return [Number.isFinite(n.x)?n.x:0, Number.isFinite(n.y)?n.y:0]; },
  parts(n, e){
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const r=Math.max(0, Number.isFinite(n.r)?n.r:60), z=(e&&e.zoom)||1;
    const a0=Number.isFinite(n.startAngle)?n.startAngle:Math.PI*3/4;
    const a1=Number.isFinite(n.endAngle)?n.endAngle:Math.PI*9/4, am=(a0+a1)/2;
    return {
      arc:[x+Math.cos(am)*r, y+Math.sin(am)*r],
      value:[x,y],
      label:[x,y+r+20/z]
    };
  },
  draw(ctx, inst, n, e, selected){
    const z=e.zoom, k=1/z, x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const r=Math.max(0, Number.isFinite(n.r)?n.r:60);
    const min=Number.isFinite(n.min)?n.min:0, max=Number.isFinite(n.max)?n.max:100;
    const value=Number.isFinite(n.value)?n.value:min, span=max-min;
    const frac=span===0?0:Math.max(0,Math.min(1,(value-min)/span));
    const a0=Number.isFinite(n.startAngle)?n.startAngle:Math.PI*3/4;
    const a1=Number.isFinite(n.endAngle)?n.endAngle:Math.PI*9/4;
    const col=n.color||'#5b8cff', track=n.track||'rgba(255,255,255,.12)';

    ctx.save();
    ctx.lineCap='round';
    ctx.lineWidth=10*k;
    ctx.strokeStyle=track;
    ctx.beginPath(); ctx.arc(x,y,r,a0,a1); ctx.stroke();

    if(frac>0){
      ctx.strokeStyle=col;
      ctx.beginPath(); ctx.arc(x,y,r,a0,a0+(a1-a0)*frac); ctx.stroke();
    }

    if(n.showValue!==false){
      ctx.fillStyle=col;
      ctx.font='700 '+((((28/z)|0)||1))+'px Segoe UI';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(String(value)+(n.unit||''), x, y);
    }

    if(n.label){
      ctx.fillStyle='rgba(238,243,255,.82)';
      ctx.font='600 '+((((13/z)|0)||1))+'px Segoe UI';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(n.label, x, y+r+20*k);
    }
    ctx.restore();
  },
  hit(inst, n, wx, wy, e){
    const z=(e&&e.zoom)||1, k=1/z;
    const x=Number.isFinite(n.x)?n.x:0, y=Number.isFinite(n.y)?n.y:0;
    const r=Math.max(0, Number.isFinite(n.r)?n.r:60), pad=8*k;
    if(wx<x-r-pad || wx>x+r+pad || wy<y-r-pad || wy>y+r+(n.label?30*k:pad)) return false;
    const min=Number.isFinite(n.min)?n.min:0, max=Number.isFinite(n.max)?n.max:100;
    const value=Number.isFinite(n.value)?n.value:min, unit=n.unit||'';
    return { label:n.label, info:String(value)+unit+' · '+String(min)+'–'+String(max)+unit,
             color:n.color||'#5b8cff' };
  }
});
