/* DESIGN SYSTEM · "comparisonSplit" — painel A/B com divisor animável.
   params: { x, y, w, h, split, leftLabel, rightLabel, leftColor,
   rightColor, leftSub, rightSub, dividerColor, title } */
VXK.register('comparisonSplit', {
  create(n){ return {}; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, z=e.zoom||1, k=1/z;
    const x=n.x!=null?n.x:0, y=n.y!=null?n.y:0;
    const w=Math.max(0,n.w!=null?n.w:320), h=Math.max(0,n.h!=null?n.h:160);
    if(!w||!h) return;

    const split=Math.max(0,Math.min(1,n.split!=null?n.split:0.5));
    const L=x-w/2, T=y-h/2, R=L+w, B=T+h, D=L+w*split;
    const rad=Math.min(16,w/2,h/2);
    const divider=n.dividerColor||'#eef3ff';

    ctx.save();
    M.roundRectPath(ctx,L,T,w,h,rad);
    ctx.fillStyle=n.leftColor||'#2f3f6b';
    ctx.fill();

    ctx.beginPath();
    if(D<L+rad){
      const cx=L+rad, q=Math.sqrt(Math.max(0,rad*rad-(D-cx)*(D-cx)));
      let topAngle=Math.atan2(-q,D-cx);
      if(topAngle<0) topAngle+=Math.PI*2;
      ctx.moveTo(D,T+rad-q);
      ctx.arc(cx,T+rad,rad,topAngle,Math.PI*1.5);
      ctx.lineTo(R-rad,T);
      ctx.arc(R-rad,T+rad,rad,-Math.PI/2,0);
      ctx.lineTo(R,B-rad);
      ctx.arc(R-rad,B-rad,rad,0,Math.PI/2);
      ctx.lineTo(cx,B);
      ctx.arc(cx,B-rad,rad,Math.PI/2,Math.atan2(q,D-cx));
    } else if(D<=R-rad){
      ctx.moveTo(D,T);
      ctx.lineTo(R-rad,T);
      ctx.arc(R-rad,T+rad,rad,-Math.PI/2,0);
      ctx.lineTo(R,B-rad);
      ctx.arc(R-rad,B-rad,rad,0,Math.PI/2);
      ctx.lineTo(D,B);
    } else {
      const cx=R-rad, q=Math.sqrt(Math.max(0,rad*rad-(D-cx)*(D-cx)));
      ctx.moveTo(D,T+rad-q);
      ctx.arc(cx,T+rad,rad,Math.atan2(-q,D-cx),0);
      ctx.lineTo(R,B-rad);
      ctx.arc(cx,B-rad,rad,0,Math.atan2(q,D-cx));
      ctx.lineTo(D,B-rad+q);
    }
    ctx.closePath();
    ctx.fillStyle=n.rightColor||'#2f5a3f';
    ctx.fill();

    const drawLabel=(x0,x1,label,sub)=>{
      const sw=x1-x0;
      if(sw<20*k) return;
      const cx=(x0+x1)/2, maxWidth=Math.max(1,sw-16*k);
      ctx.fillStyle='#eef3ff';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font='700 '+Math.max(1,15*k)+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillText(String(label!=null?label:''),cx,y+(sub?-8*k:0),maxWidth);
      if(sub){
        ctx.globalAlpha=.7;
        ctx.font='400 '+Math.max(1,11*k)+'px "Segoe UI",system-ui,sans-serif';
        ctx.fillText(String(sub),cx,y+12*k,maxWidth);
        ctx.globalAlpha=1;
      }
    };
    drawLabel(L,D,n.leftLabel,n.leftSub);
    drawLabel(D,R,n.rightLabel,n.rightSub);
    ctx.restore();

    M.roundRectPath(ctx,L,T,w,h,rad);
    ctx.strokeStyle=selected?'#ffffff':divider;
    ctx.globalAlpha=selected?1:.45;
    ctx.lineWidth=(selected?2:1.2)*k;
    ctx.stroke();
    ctx.globalAlpha=1;

    ctx.beginPath();
    ctx.moveTo(D,T+k); ctx.lineTo(D,B-k);
    ctx.strokeStyle=divider; ctx.lineWidth=1.6*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(D,y,7*k,0,Math.PI*2);
    ctx.fillStyle=divider; ctx.fill();

    if(n.title){
      ctx.fillStyle=divider;
      ctx.font='700 '+Math.max(1,13*k)+'px "Segoe UI",system-ui,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='bottom';
      ctx.fillText(String(n.title),x,T-10*k);
    }
    ctx.restore();
  },
  hit(inst,n,wx,wy,e){
    const x=n.x!=null?n.x:0, y=n.y!=null?n.y:0;
    const w=Math.max(0,n.w!=null?n.w:320), h=Math.max(0,n.h!=null?n.h:160);
    if(wx<x-w/2||wx>x+w/2||wy<y-h/2||wy>y+h/2) return false;
    const split=Math.max(0,Math.min(1,n.split!=null?n.split:0.5));
    const left=n.leftLabel||'A', right=n.rightLabel||'B', pct=Math.round(split*100);
    return {
      label:n.title||'comparação',
      info:String(left)+' '+pct+'% · '+String(right)+' '+(100-pct)+'%'
    };
  }
});
