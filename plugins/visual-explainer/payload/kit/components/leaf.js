/* DESIGN SYSTEM · "leaf" — folha/planta paramétrica.
   params: { x,y, scale, w,h, color, intensity, tilt, root, stomataOpen, label, info } */
VXK.register('leaf', {
  create(n){ return {}; },
  pos(n){ return [n.x||0, n.y||0]; },
  parts(n){
    const x=n.x||0, y=n.y||0, s=n.scale||1, w=(n.w||190)*s, h=(n.h||108)*s, a=n.tilt||0;
    const T=(lx,ly)=>[x+Math.cos(a)*lx-Math.sin(a)*ly, y+Math.sin(a)*lx+Math.cos(a)*ly];
    return {
      leaf: T(0,0),
      chloroplast: T(w*0.08, -h*0.02),
      stomata: T(w*0.12, h*0.36),
      root: [x-w*0.58, y+h*1.28]
    };
  },
  draw(ctx, inst, n, e, selected){
    const x=n.x||0, y=n.y||0, s=n.scale||1, w=(n.w||190)*s, h=(n.h||108)*s, a=n.tilt||0;
    const M=e.mat, active=Math.max(0, Math.min(1, n.intensity==null?0.65:n.intensity));
    const blade=M.hexLerp(n.color||'#3aa657', '#52bf63', active*0.5);
    const inner=M.hexLerp('#84d36d', '#2f9c4b', active);
    const stroke=n.stroke||'#1f6d38';
    const lw=1.7/e.zoom;

    if(n.root!==false){
      const sx=x-w*0.47, sy=y+h*0.12, ry=y+h*1.18, rootCol=n.rootColor||'#8a5a32';
      ctx.strokeStyle=rootCol; ctx.lineWidth=4/e.zoom; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.bezierCurveTo(sx-w*.04,y+h*.48,sx-w*.1,y+h*.82,sx-w*.12,ry); ctx.stroke();
      ctx.lineWidth=2/e.zoom;
      const bx=sx-w*.12;
      for(const d of [-1,0,1]){
        ctx.beginPath(); ctx.moveTo(bx,ry);
        ctx.bezierCurveTo(bx+d*w*.10,ry+h*.08,bx+d*w*.17,ry+h*.19,bx+d*w*.24,ry+h*.26);
        ctx.stroke();
      }
    }

    ctx.save(); ctx.translate(x,y); ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-w/2, 0);
    ctx.bezierCurveTo(-w*.27, -h*.58, w*.25, -h*.58, w/2, 0);
    ctx.bezierCurveTo(w*.25, h*.58, -w*.27, h*.58, -w/2, 0);
    ctx.closePath();
    ctx.fillStyle=blade; ctx.fill();
    ctx.strokeStyle=selected?'#ffffff':stroke; ctx.lineWidth=(selected?2.6:1.8)/e.zoom; ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(w*.08, -h*.02, w*.23, h*.22, 0, 0, 6.2832);
    ctx.fillStyle=inner; ctx.fill();
    ctx.strokeStyle='rgba(238,255,232,.55)'; ctx.lineWidth=lw; ctx.stroke();

    ctx.strokeStyle=n.veinColor||'#d7f5c8'; ctx.lineWidth=1.8/e.zoom; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(-w*.42,0); ctx.lineTo(w*.42,0); ctx.stroke();
    ctx.lineWidth=1.2/e.zoom;
    for(const f of [-0.25, -0.05, 0.15, 0.32]){
      const px=-w*.33 + (f+0.25)*w*.9;
      ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px+w*.12, -h*(0.18+Math.abs(f)*0.35)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px+w*.10, h*(0.16+Math.abs(f)*0.30)); ctx.stroke();
    }

    const open=Math.max(0, Math.min(1, n.stomataOpen==null?0.55:n.stomataOpen));
    ctx.fillStyle=n.stomataColor||'#225c3a';
    for(let i=0;i<3;i++){
      ctx.beginPath(); ctx.ellipse(-w*.05+i*w*.10, h*.36, (3.5+open*3)*s, 2.2*s, 0, 0, 6.2832); ctx.fill();
    }

    if(n.label){
      ctx.fillStyle=n.textColor||'#eef3ff'; ctx.font='600 '+((((12/e.zoom)|0)||1))+'px Segoe UI';
      ctx.textAlign='center'; ctx.fillText(n.label, 0, -h*.66);
    }
    ctx.restore();
  },
  hit(inst, n, wx, wy){
    const x=n.x||0, y=n.y||0, s=n.scale||1, w=(n.w||190)*s, h=(n.h||108)*s, a=-(n.tilt||0);
    const dx=wx-x, dy=wy-y, lx=Math.cos(a)*dx-Math.sin(a)*dy, ly=Math.sin(a)*dx+Math.cos(a)*dy;
    if((lx*lx)/((w/2)*(w/2)) + (ly*ly)/((h/2)*(h/2)) <= 1.08){
      return { label:n.label||'Folha', info:n.info||'Folha com clorofila, veias e estômatos.' };
    }
    if(n.root!==false && Math.hypot(wx-(x-w*.58), wy-(y+h*1.28)) < 42*s){
      return { label:'Raiz', info:'A raiz absorve água e sais minerais do solo.' };
    }
    return false;
  }
});
