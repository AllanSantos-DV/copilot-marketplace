/* DESIGN SYSTEM · "shape" — primitivo declarativo multi-forma (FLAT).
   O autor descreve uma lista de formas (circle/ellipse/rect/line/polyline/
   polygon/text e PATH SVG via Path2D cacheado) e o motor renderiza no canvas.
   Props de NÓ animáveis pelo step engine: x, y, scale, rotate, opacity, tint.
   Sem morphing interno: a forma é FORMA; anime pelo transform/opacity/tint do
   nó ou revelando/ocultando nós de forma entre passos. */
(function(){
  const TAU = 6.2832;
  const num = (v,d)=> (typeof v==='number' && isFinite(v)) ? v : d;
  const DEF_FILL='#8aa4d6', DEF_STROKE='rgba(16,22,40,.42)', DEF_LINE='#33456b', DEF_TXT='#eef3ff';

  // bounds/centro por forma: bounds agora em VXK.geom.shapeBounds (kit/lib/geom.mjs) — fonte única.
  // centro local de UMA forma (âncora de anotação)
  function centerOf(sh, b){
    switch(sh.kind){
      case 'circle': case 'ellipse': return [num(sh.cx,0), num(sh.cy,0)];
      case 'rect': return [num(sh.x,0)+num(sh.w,0)/2, num(sh.y,0)+num(sh.h,0)/2];
      case 'line': return [(num(sh.x1,0)+num(sh.x2,0))/2, (num(sh.y1,0)+num(sh.y2,0))/2];
      case 'polyline': case 'polygon': { const p=sh.points||[]; if(!p.length) return [0,0]; let sx=0,sy=0; for(const pt of p){sx+=pt[0];sy+=pt[1];} return [sx/p.length, sy/p.length]; }
      default: return b ? [(b[0]+b[2])/2,(b[1]+b[3])/2] : [num(sh.x,0),num(sh.y,0)];
    }
  }
  // pointInPoly: em VXK.geom.pointInPoly (kit/lib/geom.mjs) — fonte única.

  // recomputa bounds só quando a referência de n.shapes muda (barato por frame)
  function ensure(inst, n){
    if(inst._ref === n.shapes && inst._sb) return;
    const list = Array.isArray(n.shapes) ? n.shapes : [];
    const sb=[]; let U=null;
    for(const sh of list){ const b = sh ? VXK.geom.shapeBounds(sh) : null; sb.push(b); if(b){ if(!U) U=[b[0],b[1],b[2],b[3]]; else { U[0]=Math.min(U[0],b[0]); U[1]=Math.min(U[1],b[1]); U[2]=Math.max(U[2],b[2]); U[3]=Math.max(U[3],b[3]); } } }
    inst._sb=sb; inst._bounds=U; inst._ref=n.shapes;
  }
  function pathOf(inst, d){ let p=inst._p2d.get(d); if(!p){ p=new Path2D(d); inst._p2d.set(d,p); } return p; }

  function fillOf(sh, n){
    let f=sh.fill;
    if(f==='tint') return n.tint || DEF_FILL;
    if(f===null || f===false || f==='none') return null;
    if(typeof f==='string') return f;
    if(sh.kind==='line'||sh.kind==='polyline') return null;      // traçados não preenchem por padrão
    return DEF_FILL;
  }
  function strokeOf(sh, n, selected){
    if(selected) return '#ffffff';
    let s=sh.stroke;
    if(s==='tint') return n.tint || null;
    if(s===null || s===false || s==='none') return null;
    if(typeof s==='string') return s;
    if(sh.kind==='line'||sh.kind==='polyline') return DEF_LINE;  // linha precisa de traço p/ ser vista
    return DEF_STROKE;                                           // borda fina padrão nas fechadas
  }
  // teste de contenção em espaço LOCAL do nó
  function inside(sh, b, lx, ly, inst, e){
    switch(sh.kind){
      case 'circle': { const cx=num(sh.cx,0),cy=num(sh.cy,0),r=Math.abs(num(sh.r,0)); return (lx-cx)*(lx-cx)+(ly-cy)*(ly-cy)<=r*r; }
      case 'ellipse': { const cx=num(sh.cx,0),cy=num(sh.cy,0),rx=Math.abs(num(sh.rx,0))||1e-6,ry=Math.abs(num(sh.ry,0))||1e-6; const u=(lx-cx)/rx,v=(ly-cy)/ry; return u*u+v*v<=1; }
      case 'polygon': return VXK.geom.pointInPoly(sh.points||[], lx, ly);
      case 'path': {
        if(e && e.ctx && typeof e.ctx.isPointInPath==='function'){        // preciso: isPointInPath com CTM identidade
          const p=pathOf(inst, String(sh.d||'')); let ok=false;
          e.ctx.save(); e.ctx.setTransform(1,0,0,1,0,0); try{ ok=e.ctx.isPointInPath(p, lx, ly); }catch(_e){} e.ctx.restore();
          if(ok) return true;
        }
        return b ? (lx>=b[0]&&lx<=b[2]&&ly>=b[1]&&ly<=b[3]) : false;      // fallback bbox
      }
      default: return b ? (lx>=b[0]&&lx<=b[2]&&ly>=b[1]&&ly<=b[3]) : false; // rect/line/polyline/text: bbox
    }
  }

  VXK.register('shape', {
    create(n){ return { _p2d:new Map(), _ref:null, _bounds:null, _sb:null }; },

    pos(n){ return [n.x||0, n.y||0]; },

    parts(n){
      const inst = n._inst || { _p2d:new Map(), _ref:null, _bounds:null, _sb:null };
      ensure(inst, n);
      const list = Array.isArray(n.shapes) ? n.shapes : [];
      const sc=num(n.scale,1)||1, a=n.rotate||0, ca=Math.cos(a), sa=Math.sin(a), ox=num(n.x,0), oy=num(n.y,0);
      const T=(lx,ly)=>[ ox + sc*(ca*lx - sa*ly), oy + sc*(sa*lx + ca*ly) ];   // local → mundo (motor mapeia p/ tela)
      const U=inst._bounds, out={ center: U ? T((U[0]+U[2])/2,(U[1]+U[3])/2) : T(0,0) };
      for(let i=0;i<list.length;i++){ const sh=list[i]; if(!sh||!sh.name) continue; const c=centerOf(sh, inst._sb[i]); out[sh.name]=T(c[0],c[1]); }
      return out;
    },

    draw(ctx, inst, n, e, selected){
      const list = Array.isArray(n.shapes) ? n.shapes : [];
      if(!list.length) return;
      ensure(inst, n);
      const sc=num(n.scale,1)||1, zsc=Math.max(1e-3, e.zoom*Math.abs(sc));
      ctx.save();
      ctx.translate(num(n.x,0), num(n.y,0));
      if(n.rotate) ctx.rotate(n.rotate);
      if(sc!==1) ctx.scale(sc, sc);
      const a0=ctx.globalAlpha, baseA=a0*(n.opacity==null?1:n.opacity);

      for(const sh of list){
        if(!sh || !sh.kind) continue;
        ctx.globalAlpha = baseA*(sh.opacity==null?1:sh.opacity);
        const fill=fillOf(sh,n), stroke=strokeOf(sh,n,selected);
        const lw=(num(sh.strokeWidth,1.5)/zsc)*(selected?1.4:1);

        if(sh.kind==='path'){
          const d=String(sh.d||''); if(!d) continue; const p=pathOf(inst,d);
          if(fill){ ctx.fillStyle=fill; ctx.fill(p); }
          if(stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=lw; ctx.stroke(p); }
        } else if(sh.kind==='text'){
          const size=Math.max(1,(num(sh.size,14)/e.zoom)|0);            // texto escala com o nó (px/zoom)
          const fam=(typeof sh.font==='string' && !/\d/.test(sh.font)) ? sh.font : 'Segoe UI';
          ctx.font=(sh.weight||'600')+' '+size+'px '+fam;
          ctx.textAlign=sh.align||'left'; ctx.textBaseline=sh.baseline||'alphabetic';
          ctx.fillStyle=fill||DEF_TXT; ctx.fillText(String(sh.text||''), num(sh.x,0), num(sh.y,0));
          if(sh.stroke && stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=lw; ctx.strokeText(String(sh.text||''), num(sh.x,0), num(sh.y,0)); }
          ctx.textBaseline='alphabetic'; ctx.textAlign='left';
        } else {
          if((sh.kind==='polyline'||sh.kind==='polygon') && !(sh.points&&sh.points.length)) continue;
          ctx.beginPath();
          if(sh.kind==='circle'){ ctx.arc(num(sh.cx,0),num(sh.cy,0),Math.abs(num(sh.r,0)),0,TAU); }
          else if(sh.kind==='ellipse'){ ctx.ellipse(num(sh.cx,0),num(sh.cy,0),Math.abs(num(sh.rx,0)),Math.abs(num(sh.ry,0)),0,0,TAU); }
          else if(sh.kind==='rect'){ const x=num(sh.x,0),y=num(sh.y,0),w=num(sh.w,0),h=num(sh.h,0),r=num(sh.rx,0);
            if(r>0) e.mat.roundRectPath(ctx, x, y, w, h, Math.min(r, Math.abs(w)/2, Math.abs(h)/2)); else ctx.rect(x,y,w,h); }
          else if(sh.kind==='line'){ ctx.moveTo(num(sh.x1,0),num(sh.y1,0)); ctx.lineTo(num(sh.x2,0),num(sh.y2,0)); }
          else if(sh.kind==='polyline'||sh.kind==='polygon'){ const p=sh.points; ctx.moveTo(p[0][0],p[0][1]); for(let i=1;i<p.length;i++) ctx.lineTo(p[i][0],p[i][1]); if(sh.kind==='polygon') ctx.closePath(); }
          else continue;
          const closed = sh.kind!=='line' && sh.kind!=='polyline';
          if(closed && fill){ ctx.fillStyle=fill; ctx.fill(); }
          if(stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=lw; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); }
        }
      }
      ctx.globalAlpha=a0; ctx.restore();
    },

    hit(inst, n, wx, wy, e){
      const list = Array.isArray(n.shapes) ? n.shapes : [];
      if(!list.length) return false;
      ensure(inst, n);
      const sc=num(n.scale,1)||1, a=n.rotate||0, ca=Math.cos(a), sa=Math.sin(a);
      const dx=wx-num(n.x,0), dy=wy-num(n.y,0);
      const lx=(ca*dx + sa*dy)/sc, ly=(-sa*dx + ca*dy)/sc;                 // mundo → local
      for(let i=list.length-1;i>=0;i--){ const sh=list[i]; if(!sh) continue;   // 1) subforma nomeada
        if((sh.name||sh.info) && inside(sh, inst._sb[i], lx, ly, inst, e)) return { label: sh.name||n.label||'Forma', info: sh.info||n.info||'' };
      }
      for(let i=list.length-1;i>=0;i--){ const sh=list[i]; if(!sh) continue;   // 2) grupo inteiro
        if(inside(sh, inst._sb[i], lx, ly, inst, e)) return { label: n.label||'Forma', info: n.info||'' };
      }
      return false;
    }
  });
})();
