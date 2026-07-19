/* DESIGN SYSTEM · "watercycle" — Ciclo da Água em uma paisagem FLAT.
   Um único escalar semântico (cycle 0..1) destaca evaporação, condensação,
   precipitação e coleta/escoamento sem depender de mudanças no core. */
VXK.register('watercycle', {
  create(n){ return {}; },

  _clamp01(v){ return v<0?0:v>1?1:v; },
  _smooth(v){ v=this._clamp01(v); return v*v*(3-2*v); },
  _state(n){
    const c = this._clamp01(n.cycle == null ? 0 : n.cycle);
    const phase = c >= 1 ? 3 : Math.floor(Math.max(0, c*4 - 1e-6));
    const u = c >= 1 ? 1 : (c - phase*0.25) / 0.25;
    const s = this._smooth(u);
    return {
      c, phase, u:s,
      evap: phase===0 ? 0.36 + 0.64*s : 0.04,
      cond: phase===1 ? 0.38 + 0.62*s : (phase===2 ? 0.92 : 0.34),
      rain: phase===2 ? 0.22 + 0.78*s : (phase===3 ? 0.07 : 0.02),
      flow: phase===3 ? 0.34 + 0.66*s : 0.12
    };
  },

  _round(ctx, x, y, w, h, r, M){ M.roundRectPath(ctx, x, y, w, h, r); },
  _stroke(ctx, color, w){ ctx.strokeStyle=color; ctx.lineWidth=w; ctx.stroke(); },
  _arrow(ctx, x1, y1, x2, y2, color, k, alpha){
    const a = Math.atan2(y2-y1, x2-x1);
    ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.7*k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.quadraticCurveTo((x1+x2)/2, (y1+y2)/2-10, x2,y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2-Math.cos(a-0.55)*10*k, y2-Math.sin(a-0.55)*10*k);
    ctx.lineTo(x2-Math.cos(a+0.55)*10*k, y2-Math.sin(a+0.55)*10*k);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  },

  _drop(ctx, x, y, r){
    ctx.beginPath();
    ctx.moveTo(x, y-r*1.45);
    ctx.bezierCurveTo(x+r*1.05, y-r*.2, x+r*.72, y+r*.9, x, y+r);
    ctx.bezierCurveTo(x-r*.72, y+r*.9, x-r*1.05, y-r*.2, x, y-r*1.45);
    ctx.closePath(); ctx.fill();
  },

  _drawSea(ctx, e, st, k){
    const t=e.t, top=56;
    ctx.beginPath();
    ctx.moveTo(-286, top+3*Math.sin(t*1.4));
    for(let x=-286; x<=46; x+=18){
      const y = top + Math.sin(x*0.045+t*1.8)*4 + Math.sin(x*0.021-t*.9)*2;
      ctx.lineTo(x,y);
    }
    ctx.lineTo(58,168); ctx.lineTo(-286,168); ctx.closePath();
    ctx.fillStyle = '#2f6fb0'; ctx.fill();
    ctx.strokeStyle='rgba(191,227,255,.45)'; ctx.lineWidth=1.4*k; ctx.stroke();

    ctx.strokeStyle='rgba(191,227,255,.34)'; ctx.lineWidth=1.3*k; ctx.lineCap='round';
    for(let j=0;j<4;j++){
      ctx.beginPath();
      for(let x=-260; x<30; x+=18){
        const y=78+j*18 + Math.sin(x*.055+t*(1.2+j*.18))*2.2;
        if(x===-260) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  },

  _drawLand(ctx, e, st, k){
    const M=e.mat;
    ctx.beginPath();
    ctx.moveTo(-18,168); ctx.lineTo(-18,128); ctx.bezierCurveTo(16,112, 24,78, 60,64);
    ctx.lineTo(284,52); ctx.lineTo(284,168); ctx.closePath();
    ctx.fillStyle='#3f6f49'; ctx.fill();
    ctx.strokeStyle='rgba(214,235,203,.28)'; ctx.lineWidth=1.2*k; ctx.stroke();

    ctx.beginPath(); ctx.moveTo(42,66); ctx.lineTo(116,-55); ctx.lineTo(194,68); ctx.closePath();
    ctx.fillStyle='#3a5a44'; ctx.fill(); ctx.strokeStyle='rgba(8,14,18,.45)'; ctx.lineWidth=1.1*k; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(116,-55); ctx.lineTo(139,-18); ctx.lineTo(111,-26); ctx.lineTo(93,-10); ctx.closePath();
    ctx.fillStyle='#d6e6e2'; ctx.fill();

    ctx.beginPath(); ctx.moveTo(118,68); ctx.lineTo(210,-24); ctx.lineTo(286,70); ctx.closePath();
    ctx.fillStyle='#6b7a66'; ctx.fill(); ctx.strokeStyle='rgba(8,14,18,.42)'; ctx.lineWidth=1.1*k; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(210,-24); ctx.lineTo(231,2); ctx.lineTo(207,-2); ctx.lineTo(190,13); ctx.closePath();
    ctx.fillStyle='#e1ece8'; ctx.fill();

    ctx.beginPath(); ctx.moveTo(20,82); ctx.lineTo(78,14); ctx.lineTo(140,82); ctx.closePath();
    ctx.fillStyle='#4f704f'; ctx.fill(); ctx.strokeStyle='rgba(8,14,18,.33)'; ctx.lineWidth=1*k; ctx.stroke();

    ctx.save();
    ctx.globalAlpha=.28+.35*st.flow;
    ctx.beginPath();
    ctx.moveTo(80,134); ctx.bezierCurveTo(124,120, 170,121, 230,137);
    ctx.lineTo(236,149); ctx.bezierCurveTo(174,136, 121,138, 76,151); ctx.closePath();
    ctx.fillStyle='#43608a'; ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha=.28+.58*st.flow;
    ctx.strokeStyle='#bfe3ff'; ctx.fillStyle='#bfe3ff'; ctx.lineWidth=2.2*k; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(146,86); ctx.lineTo(146,127); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(146,127); ctx.lineTo(139,116); ctx.lineTo(153,116); ctx.closePath(); ctx.fill();
    ctx.font=(12*k)+'px Segoe UI, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=3*k; ctx.strokeStyle='rgba(8,13,22,.72)'; ctx.strokeText('Infiltração', 146, 152);
    ctx.fillStyle='#d9f0ff'; ctx.fillText('Infiltração', 146, 152);
    ctx.restore();

    // Textura plana mínima no solo para não parecer um bloco único.
    ctx.strokeStyle='rgba(214,235,203,.18)'; ctx.lineWidth=1*k;
    for(let i=0;i<5;i++){ ctx.beginPath(); ctx.moveTo(42+i*45,104+i%2*12); ctx.lineTo(72+i*42,96+i%2*9); ctx.stroke(); }
  },

  _drawRiver(ctx, e, st, k){
    const t=e.t, w=4 + 16*st.flow;
    ctx.save();
    ctx.globalAlpha=.54+.46*st.flow;
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.strokeStyle='#1f5f9a'; ctx.lineWidth=(w+3)*k; ctx.beginPath();
    ctx.moveTo(158,32); ctx.bezierCurveTo(130,56, 124,72, 98,84); ctx.bezierCurveTo(70,98, 42,116, -30,118); ctx.stroke();
    ctx.strokeStyle='#2f7fbd'; ctx.lineWidth=w*k; ctx.beginPath();
    ctx.moveTo(158,32); ctx.bezierCurveTo(130,56, 124,72, 98,84); ctx.bezierCurveTo(70,98, 42,116, -30,118); ctx.stroke();
    ctx.strokeStyle='rgba(191,227,255,.72)'; ctx.lineWidth=1.7*k;
    for(let i=0;i<7;i++){
      const p=(i/7 + t*.18)%1;
      const x=158*(1-p) + (-30)*p + Math.sin(p*9.5)*22;
      const y=34*(1-p) + 118*p + Math.sin(p*6.2)*7;
      ctx.beginPath(); ctx.moveTo(x-8,y+2); ctx.lineTo(x+8,y-2); ctx.stroke();
    }
    ctx.restore();
  },

  _drawSun(ctx, e, st, k){
    const x=188, y=-113, r=24;
    ctx.save();
    ctx.fillStyle='rgba(255,210,58,.13)'; ctx.beginPath(); ctx.arc(x,y,r*1.8,0,6.2832); ctx.fill();
    ctx.strokeStyle='#ffd23a'; ctx.lineWidth=2*k; ctx.lineCap='round';
    for(let i=0;i<10;i++){
      const a=i*6.2832/10 + Math.sin(e.t*.4)*.03;
      ctx.beginPath(); ctx.moveTo(x+Math.cos(a)*(r+9), y+Math.sin(a)*(r+9));
      ctx.lineTo(x+Math.cos(a)*(r+17), y+Math.sin(a)*(r+17)); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fillStyle='#ffd23a'; ctx.fill();
    ctx.strokeStyle='rgba(90,62,0,.35)'; ctx.lineWidth=1.2*k; ctx.stroke();
    ctx.restore();
  },

  _drawCloud(ctx, e, st, k){
    const M=e.mat, sc=0.86 + 0.34*st.cond + 0.05*st.rain, x=-20, y=-78;
    const dark=Math.max(st.cond, st.rain*.9);
    const col=M.hexLerp('#c9d4e6', '#7e889a', this._clamp01(dark*.92));
    ctx.save(); ctx.translate(x,y); ctx.scale(sc,sc);
    ctx.fillStyle=col; ctx.strokeStyle='rgba(13,19,32,.44)'; ctx.lineWidth=1.3*k/sc;
    this._round(ctx, -58, -5, 132, 34, 17, M); ctx.fill(); ctx.stroke();
    const lobes=[[-40,-6,25],[-13,-25,32],[24,-19,31],[54,-2,23]];
    for(const l of lobes){ ctx.beginPath(); ctx.arc(l[0],l[1],l[2],0,6.2832); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle=col; this._round(ctx,-54,-16,120,42,20,M); ctx.fill();
    ctx.fillStyle='rgba(224,238,255,'+(0.12+0.42*st.cond).toFixed(2)+')';
    for(let i=0;i<9;i++){
      const px=-42+i*13, py=-15+Math.sin(i*1.7+e.t)*9;
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  },

  _drawVapor(ctx, e, st, k){
    const amount=st.evap, t=e.t;
    ctx.save(); ctx.strokeStyle='#bfe3ff'; ctx.fillStyle='#bfe3ff'; ctx.lineCap='round';
    for(let i=0;i<9;i++){
      const x=-196+i*20+Math.sin(t*1.4+i)*4;
      const top=50 + Math.sin(i*.9+t)*3;
      const h=34 + 100*amount;
      const ph=(t*.17+i*.13)%1;
      const y=top - ph*h;
      const a=(0.16 + 0.66*amount) * (1 - Math.max(0, Math.abs(ph-.55)-.36));
      ctx.globalAlpha=this._clamp01(a);
      ctx.lineWidth=1.7*k;
      ctx.beginPath(); ctx.moveTo(x, y+13); ctx.lineTo(x, y-12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y-12); ctx.lineTo(x-5*k, y-5); ctx.lineTo(x+5*k, y-5); ctx.closePath(); ctx.fill();
      this._drop(ctx, x+7*Math.sin(i), y+19, 2.6*k+1.2);
    }
    ctx.restore();
  },

  _drawRain(ctx, e, st, k){
    const amount=st.rain, t=e.t;
    if(amount<0.04) return;
    ctx.save(); ctx.strokeStyle='#7fb3e6'; ctx.lineCap='round'; ctx.lineWidth=(1.8+1.5*amount)*k;
    const count=8+Math.round(10*amount);
    for(let i=0;i<count;i++){
      const x=-46 + i*(142/count) + Math.sin(i*2.1)*5;
      const ph=(t*.34+i*.21)%1;
      const y=-46 + ph*116;
      ctx.globalAlpha=.22 + .68*amount;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x-4, y+14+18*amount); ctx.stroke();
    }
    ctx.restore();
  },

  _drawCycleArrows(ctx, e, st, k){
    this._arrow(ctx, -170,45, -82,-46, '#bfe3ff', k, .23+.28*st.evap);
    this._arrow(ctx, 38,-73, 118,14, '#c9d4e6', k, .18+.24*st.rain);
    this._arrow(ctx, 82,121, -45,123, '#7fb3e6', k, .20+.33*st.flow);
  },

  draw(ctx, inst, n, e, selected){
    const st=this._state(n), S=n.scale||1, ox=n.x||0, oy=n.y||0, k=1/(e.zoom*S);
    ctx.save(); ctx.translate(ox,oy); ctx.scale(S,S);
    this._drawCycleArrows(ctx,e,st,k);
    this._drawSun(ctx,e,st,k);
    this._drawSea(ctx,e,st,k);
    this._drawLand(ctx,e,st,k);
    this._drawRiver(ctx,e,st,k);
    this._drawVapor(ctx,e,st,k);
    this._drawCloud(ctx,e,st,k);
    this._drawRain(ctx,e,st,k);

    if(selected){
      e.mat.roundRectPath(ctx,-286,-150,572,324,18);
      ctx.strokeStyle='#fff'; ctx.lineWidth=2*k; ctx.stroke();
    }
    ctx.restore();
  },

  parts(n, e){
    const S=n.scale||1, ox=n.x||0, oy=n.y||0, W=(x,y)=>[ox+x*S, oy+y*S];
    return {
      sea: W(-174,82),
      sun: W(188,-113),
      cloud: W(-20,-86),
      vapor: W(-138,-26),
      rain: W(22,8),
      river: W(72,96),
      mountains: W(150,18),
      groundwater: W(146,134)
    };
  },

  hit(inst, n, wx, wy, e){
    const P=this.parts(n,e), S=n.scale||1;
    const T={
      sea:['Oceanos e mares','Oceanos e mares guardam a maior parte da água do planeta; o Sol evapora água da superfície.'],
      sun:['Sol','A energia do Sol aquece a água e dá movimento ao ciclo.'],
      cloud:['Nuvem','O vapor esfria nas camadas altas e se condensa em gotinhas, formando nuvens.'],
      vapor:['Evaporação','A água líquida ganha energia, vira vapor e sobe para a atmosfera.'],
      rain:['Precipitação','Quando as gotículas ficam pesadas, a água cai como chuva, neve ou granizo.'],
      river:['Escoamento','Rios e córregos levam a água de volta para lagos, mares e oceanos.'],
      mountains:['Montanhas','O relevo recebe a precipitação e conduz a água por encostas e vales.'],
      groundwater:['Infiltração','Parte da água entra no solo, abastece aquíferos e pode voltar aos rios.']
    };
    let best=null, bestD=Infinity;
    for(const key in P){ const p=P[key], d=Math.hypot(wx-p[0], wy-p[1]); if(d<bestD){ bestD=d; best=key; } }
    if(best && bestD<=34*S) return { label:T[best][0], info:T[best][1] };
    const ox=n.x||0, oy=n.y||0;
    if(wx>=ox-286*S && wx<=ox+286*S && wy>=oy-150*S && wy<=oy+174*S) return true;
    return false;
  }
});
