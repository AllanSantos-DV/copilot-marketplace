/* DESIGN SYSTEM · "figure" — silhueta humana FLAT paramétrica (geral).
   Serve para qualquer tema narrativo/histórico/bíblico/mitológico.
   Composição: cabeça (círculo) + tronco (trapézio) + 2 braços + 2 pernas,
   como silhueta sólida com contorno fino. Desenha em coordenadas de MUNDO,
   centrada em (x,y), escalada por scale.
   params: { x, y, scale, color, stroke, lean, pose, flip, aura, auraColor,
             wound, alpha, label, textColor, info }
     lean  : inclina a figura toda em torno dos pés (rad) — pose de luta.
     pose  : "grapple" (padrão) braços à frente/pra cima; "stand" braços ao lado.
     flip  : espelha na horizontal (adversário encara o outro).
     aura  : 0..1 anel fino chapado atrás/em volta da cabeça (anjo/Deus).
     wound : 0..1 marca no quadril (a ferida do golpe).
     alpha : 0..1 opacidade do corpo (visão/sonho esmaecido).
   parts(): head, hip, center, hand  +  <id>.head/.hip/.center/.hand
            (id-escopadas p/ anotar o quadril de UMA figura sem ambiguidade). */
VXK.register('figure', {
  create(n){ return {}; },

  // geometria local (antes de scale/flip/lean); Y cresce pra baixo
  _G(){
    return {
      pivotY:72, headR:12,
      head:[0,-58], neck:[0,-46], shL:[-17,-43], shR:[17,-43],
      hip:[0,10], hipL:[-8,9], hipR:[8,9], footL:[-14,72], footR:[13,71],
      handG:[54,-44], handG2:[43,-29], center:[0,-22], limbW:8
    };
  },

  // local -> mundo (mesma ordem do draw: lean -> flip -> scale -> translate)
  _tf(n){
    const x=n.x||0, y=n.y||0, s=n.scale||1, fl=!!n.flip, lean=n.lean||0, pv=72;
    const ca=Math.cos(lean), sa=Math.sin(lean);
    return (lx,ly)=>{
      let dx=lx, dy=ly-pv, rx=dx*ca-dy*sa, ry=dx*sa+dy*ca + pv;
      if(fl) rx=-rx;
      return [x+rx*s, y+ry*s];
    };
  },

  pos(n){ return [n.x||0, n.y||0]; },

  parts(n){
    const L=this._tf(n), G=this._G();
    const P={ head:L(G.head[0],G.head[1]), hip:L(G.hipR[0],G.hipR[1]),
      center:L(G.center[0],G.center[1]), hand:L(G.handG[0],G.handG[1]) };
    if(n.id!=null){ P[n.id+'.head']=P.head; P[n.id+'.hip']=P.hip;
      P[n.id+'.center']=P.center; P[n.id+'.hand']=P.hand; }
    return P;
  },

  draw(ctx, inst, n, e, selected){
    const G=this._G(), M=e.mat, s=n.scale||1, x=n.x||0, y=n.y||0;
    const fill=n.color||'#9aa4bb';
    const stroke=n.stroke || M.rgba(M.shade(M.hex2rgb(fill), -0.5), 1);
    const a0=ctx.globalAlpha;                                   // opacidade do nó (reveal)
    const bodyA=(n.alpha==null?1:Math.max(0,Math.min(1,n.alpha)));
    const ow=1.5/(e.zoom*s), lw=1.4/(e.zoom*s);

    ctx.save();
    ctx.translate(x,y); ctx.scale(s,s);
    if(n.flip) ctx.scale(-1,1);
    ctx.translate(0,G.pivotY); ctx.rotate(n.lean||0); ctx.translate(0,-G.pivotY);
    ctx.lineJoin='round'; ctx.lineCap='round';

    // aura: anel fino chapado (atrás)
    const aura=Math.max(0,Math.min(1,n.aura||0));
    if(aura>0.001){
      const ac=M.hex2rgb(n.auraColor||'#f6e7b0');
      ctx.globalAlpha=a0*aura;
      ctx.strokeStyle=M.rgba(ac,1);   ctx.lineWidth=2.6/(e.zoom*s);
      ctx.beginPath(); ctx.arc(0,-40,42,0,6.2832); ctx.stroke();
      ctx.strokeStyle=M.rgba(ac,0.6); ctx.lineWidth=2.0/(e.zoom*s);
      ctx.beginPath(); ctx.arc(G.head[0],G.head[1],19,0,6.2832); ctx.stroke();
    }

    // membros por pose
    const grap=(n.pose!=='stand');
    const armR = grap ? [G.shR,[33,-49],G.handG]  : [G.shR,[22,-14],[18,10]];
    const armL = grap ? [G.shL,[10,-38],G.handG2] : [G.shL,[-22,-14],[-18,10]];
    const legR = [G.hipR,[10,40],G.footR];
    const legL = [G.hipL,[-12,40],G.footL];
    const W=G.limbW;
    const poly=p=>{ ctx.beginPath(); ctx.moveTo(p[0][0],p[0][1]); for(let i=1;i<p.length;i++) ctx.lineTo(p[i][0],p[i][1]); };
    const torso=()=>{ ctx.beginPath(); ctx.moveTo(G.shL[0],G.shL[1]); ctx.lineTo(G.shR[0],G.shR[1]);
      ctx.lineTo(G.hipR[0]+2,G.hipR[1]+2); ctx.lineTo(G.hipL[0]-2,G.hipL[1]+2); ctx.closePath(); };

    ctx.globalAlpha=a0*bodyA;
    // PASSO 1 — subcamada de contorno (silhueta única, sem costuras internas)
    ctx.strokeStyle=stroke; ctx.fillStyle=stroke;
    ctx.lineWidth=W+2*ow;
    poly(legL); ctx.stroke(); poly(legR); ctx.stroke();
    poly(armL); ctx.stroke(); poly(armR); ctx.stroke();
    torso(); ctx.lineWidth=2*ow; ctx.stroke(); ctx.fill();
    ctx.beginPath(); ctx.arc(G.head[0],G.head[1],G.headR+ow,0,6.2832); ctx.fill();
    // PASSO 2 — preenchimento (cor do corpo)
    ctx.strokeStyle=fill; ctx.fillStyle=fill;
    ctx.lineWidth=W;
    poly(legL); ctx.stroke(); poly(legR); ctx.stroke();
    poly(armL); ctx.stroke(); poly(armR); ctx.stroke();
    torso(); ctx.fill();
    ctx.beginPath(); ctx.arc(G.head[0],G.head[1],G.headR,0,6.2832); ctx.fill();

    ctx.globalAlpha=a0;
    if(selected){ ctx.strokeStyle='#ffffff'; ctx.lineWidth=1.8/(e.zoom*s);
      ctx.beginPath(); ctx.arc(G.head[0],G.head[1],G.headR+ow*1.8,0,6.2832); ctx.stroke(); }

    // ferida no quadril (por cima)
    const wound=Math.max(0,Math.min(1,n.wound||0));
    if(wound>0.001){
      const wr=M.hex2rgb('#b3231f');
      ctx.globalAlpha=a0*wound;
      ctx.strokeStyle=M.rgba(wr,0.7); ctx.lineWidth=1.7/(e.zoom*s);
      ctx.beginPath(); ctx.arc(G.hipR[0],G.hipR[1],7.5,0,6.2832); ctx.stroke();
      ctx.fillStyle=M.rgba(wr,0.95);
      ctx.beginPath(); ctx.arc(G.hipR[0],G.hipR[1],4.2,0,6.2832); ctx.fill();
    }
    ctx.restore();

    // rótulo em coordenadas de mundo (acima da cabeça), fonte por 1/zoom
    if(n.label){
      const hp=this._tf(n)(G.head[0], G.head[1]-G.headR-10);
      ctx.globalAlpha=a0; ctx.fillStyle=n.textColor||'#e7ecf6';
      ctx.font='600 '+((((13/e.zoom)|0)||1))+'px Segoe UI';
      ctx.textAlign='center'; ctx.textBaseline='alphabetic';
      ctx.fillText(n.label, hp[0], hp[1]); ctx.globalAlpha=a0;
    }
  },

  hit(inst, n, wx, wy){
    const x=n.x||0, y=n.y||0, s=n.scale||1, fl=!!n.flip, lean=n.lean||0, pv=72;
    let dx=(wx-x)/s, dy=(wy-y)/s;
    if(fl) dx=-dx;
    const ca=Math.cos(-lean), sa=Math.sin(-lean);
    let ux=dx, uy=dy-pv, lx=ux*ca-uy*sa, ly=ux*sa+uy*ca + pv;
    if(lx>=-36 && lx<=54 && ly>=-74 && ly<=80)
      return { label:n.label||'Figura', info:n.info||'', color:n.color };
    return false;
  }
});
