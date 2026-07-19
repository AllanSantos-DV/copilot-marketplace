/* DESIGN SYSTEM · "engine" — motor 4 tempos mecanicamente correto (FLAT).
   Um único nó desenha o conjunto: bloco (paredes + cabeçote + cárter), câmara
   de combustão colorida por tempo, duas válvulas poppet, pistão ligado por
   BIELA a um VIRABREQUIM que gira (cinemática biela-manivela), e vela.
   params: { x, y, scale, cycle(0..1 = 720°), spin(rad/s>0 = giro contínuo),
             label, info }
   Estilo: fills chapados + traços finos. Sem sombra/gradiente 3D/glow.
   Uma escalar semântica (cycle OU spin) governa TUDO — o step engine anima. */
VXK.register('engine', {
  create(n){ return {}; },

  // dimensões fixas locais (escala 1) — ajustadas por iteração visual
  _dims(){ return {
    crankR:34, L:95, cyC:78,          // manivela, biela, centro do virabrequim
    bore:70, wall:12, wallOut:47,     // furo, parede, borda externa (bore/2+wall)
    ceil:-82, wallBot:46,             // teto da câmara / base das paredes
    headTop:-126, headH:44,           // cabeçote
    pistonH:46, pistonW:66,           // pistão
    valveMaxLift:16,
    halfW:58, topY:-126, botY:118     // caixa do conjunto (seleção/hit)
  }; },

  // estado cinemático para o ângulo de manivela θ atual
  _geo(n, e){
    const d = this._dims();
    let th;
    if(n.spin && n.spin > 0) th = e.t * n.spin;        // giro contínuo
    else th = (n.cycle || 0) * 4 * Math.PI;             // 1 cycle = 720° = 2 voltas
    const sinT = Math.sin(th), cosT = Math.cos(th);
    const s = Math.sqrt(Math.max(0, d.L*d.L - (d.crankR*sinT)*(d.crankR*sinT)));
    const yW = d.cyC - d.crankR*cosT - s;               // pino do pistão (θ=0 → TDC)
    const Px = d.crankR*sinT, Py = d.cyC - d.crankR*cosT;  // pino da manivela (consistente c/ yW)
    const four = Math.PI*4;
    let tm = th % four; if(tm < 0) tm += four;
    const sIdx = Math.floor(tm/Math.PI);                // 0 adm · 1 compr · 2 explosão · 3 escape
    const u = (tm - sIdx*Math.PI)/Math.PI;              // 0..1 dentro do tempo
    return { d, th, sinT, cosT, yW, Px, Py, sIdx, u };
  },

  // cor da câmara por tempo, com leve cross-fade nas bordas
  _chamberColor(sIdx, u, M){
    const start = k => { k=((k%4)+4)%4; return k===0?'#3f7fd0':k===1?'#5a54c6':k===2?'#ff7a1a':'#8a8f98'; };
    let c = sIdx===2 ? M.hexLerp('#ff7a1a','#ffd23a', Math.min(1, u*1.6)) : start(sIdx);
    if(u > 0.88) c = M.hexLerp(c, start(sIdx+1), (u-0.88)/0.12);
    return c;
  },

  _valve(ctx, k, x, d, lift, cDisc, cStem){
    const stemTop = d.headTop + 6, discY = d.ceil + lift;   // fechada: no teto; aberta: desce
    ctx.fillStyle = cStem;
    ctx.fillRect(x-2.5, stemTop, 5, discY - stemTop);
    ctx.strokeStyle = 'rgba(10,14,24,.5)'; ctx.lineWidth = 1*k;
    ctx.strokeRect(x-2.5, stemTop, 5, discY - stemTop);
    ctx.strokeStyle = 'rgba(200,210,240,.22)'; ctx.lineWidth = 1*k;    // mola/guia (detalhe)
    for(let i=0;i<3;i++){ const yy=stemTop+9+i*5; ctx.beginPath(); ctx.moveTo(x-4,yy); ctx.lineTo(x+4,yy); ctx.stroke(); }
    ctx.beginPath();                                                    // prato do poppet (trapézio)
    ctx.moveTo(x-4, discY-2); ctx.lineTo(x+4, discY-2);
    ctx.lineTo(x+12, discY+4); ctx.lineTo(x-12, discY+4); ctx.closePath();
    ctx.fillStyle = cDisc; ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,24,.55)'; ctx.lineWidth = 1.1*k; ctx.stroke();
  },

  draw(ctx, inst, n, e, selected){
    const M = e.mat, g = this._geo(n, e), d = g.d;
    const S = n.scale || 1, ox = n.x || 0, oy = n.y || 0;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(S, S);
    const k = 1/(e.zoom*S);                          // 1px de tela em unidades locais
    const rr = (x,y,w,h,r) => M.roundRectPath(ctx, x, y, w, h, r);
    const crown = g.yW - d.pistonH/2;

    // 1) cárter (fundo, atrás do virabrequim)
    rr(-d.halfW+2, d.wallBot-4, (d.halfW-2)*2, d.botY-(d.wallBot-4), 14);
    ctx.fillStyle = '#20263e'; ctx.fill();
    ctx.strokeStyle = 'rgba(85,102,170,.32)'; ctx.lineWidth = 1.2*k; ctx.stroke();

    // 2) interior do cilindro (furo)
    ctx.fillStyle = '#12172a';
    ctx.fillRect(-d.bore/2, d.ceil, d.bore, d.wallBot - d.ceil);

    // 3) paredes do cilindro
    ctx.fillStyle = '#2b3350'; ctx.strokeStyle = 'rgba(85,102,170,.4)'; ctx.lineWidth = 1.2*k;
    rr(-d.wallOut, d.ceil, d.wall, d.wallBot-d.ceil, 4); ctx.fill(); ctx.stroke();
    rr(d.wallOut-d.wall, d.ceil, d.wall, d.wallBot-d.ceil, 4); ctx.fill(); ctx.stroke();

    // 4) cabeçote
    ctx.fillStyle = '#3a4468';
    rr(-d.wallOut-6, d.headTop, (d.wallOut+6)*2, d.headH, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,210,.45)'; ctx.lineWidth = 1.3*k; ctx.stroke();

    // 5) câmara de combustão (entre teto e coroa do pistão)
    if(crown > d.ceil + 0.5){
      ctx.fillStyle = this._chamberColor(g.sIdx, g.u, M);
      ctx.fillRect(-d.bore/2+1, d.ceil, d.bore-2, crown - d.ceil);
    }

    // 6) válvulas — admissão (esq, verde) abre no tempo 0; escape (dir, laranja) no tempo 3
    const inLift = g.sIdx===0 ? Math.sin(g.u*Math.PI)*d.valveMaxLift : 0;
    const exLift = g.sIdx===3 ? Math.sin(g.u*Math.PI)*d.valveMaxLift : 0;
    this._valve(ctx, k, -19, d, inLift, '#57c98a', '#3f9e6d');
    this._valve(ctx, k,  19, d, exLift, '#e07a4a', '#b25b34');

    // 7) pontinhos de carga entrando na admissão
    if(g.sIdx===0 && crown > d.ceil+10){
      ctx.fillStyle = 'rgba(127,179,232,.7)';
      for(let i=0;i<5;i++){ const ph=(e.t*0.8 + i*0.37)%1;
        const dx=-16+i*7, dy=d.ceil+6 + ph*(crown-d.ceil-8);
        ctx.beginPath(); ctx.arc(dx, dy, 2.4, 0, 6.2832); ctx.fill(); }
    }

    // 8) virabrequim — contrapeso + braço (web) + mancal; gira com θ (atrás da biela)
    const cy0 = d.cyC;
    const cwx = -g.sinT*10, cwy = cy0 + g.cosT*10;                      // contrapeso oposto ao pino
    ctx.beginPath(); ctx.arc(cwx, cwy, 26, 0, 6.2832);
    ctx.fillStyle = '#6b7aa8'; ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,44,.55)'; ctx.lineWidth = 1.2*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(cwx, cwy, 4, 0, 6.2832); ctx.fillStyle='#586694'; ctx.fill();
    const wdx=g.sinT, wdy=-g.cosT, hw=8;                                // braço do centro ao pino
    ctx.beginPath();
    ctx.moveTo(0 - wdy*hw, cy0 + wdx*hw); ctx.lineTo(g.Px - wdy*hw, g.Py + wdx*hw);
    ctx.lineTo(g.Px + wdy*hw, g.Py - wdx*hw); ctx.lineTo(0 + wdy*hw, cy0 - wdx*hw); ctx.closePath();
    ctx.fillStyle = '#8592bf'; ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,44,.5)'; ctx.lineWidth = 1*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, cy0, 15, 0, 6.2832); ctx.fillStyle='#8592bf'; ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,44,.6)'; ctx.lineWidth = 1.3*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, cy0, 4, 0, 6.2832); ctx.fillStyle='#5a6690'; ctx.fill();

    // 9) pistão
    const pTop = g.yW - d.pistonH/2;
    ctx.fillStyle = '#9fb4e0';
    rr(-d.pistonW/2, pTop, d.pistonW, d.pistonH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,44,.5)'; ctx.lineWidth = 1.2*k; ctx.stroke();
    ctx.strokeStyle = 'rgba(40,50,80,.7)'; ctx.lineWidth = 1.4*k;      // anéis
    for(let i=0;i<3;i++){ const yy=pTop+7+i*5; ctx.beginPath(); ctx.moveTo(-d.pistonW/2+3,yy); ctx.lineTo(d.pistonW/2-3,yy); ctx.stroke(); }

    // 10) biela — do pino do pistão ao pino da manivela (O ELO que faz ler como motor)
    const wx=0, wy=g.yW, px=g.Px, py=g.Py;
    const rdx=px-wx, rdy=py-wy, rlen=Math.hypot(rdx,rdy)||1;
    const nx=-rdy/rlen, ny=rdx/rlen, wS=5, wB=9;
    ctx.beginPath();
    ctx.moveTo(wx+nx*wS, wy+ny*wS); ctx.lineTo(px+nx*wB, py+ny*wB);
    ctx.lineTo(px-nx*wB, py-ny*wB); ctx.lineTo(wx-nx*wS, wy-ny*wS); ctx.closePath();
    ctx.fillStyle = '#7a86b0'; ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,44,.6)'; ctx.lineWidth = 1.2*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(wx, wy, 8, 0, 6.2832); ctx.fillStyle='#7a86b0'; ctx.fill();
    ctx.strokeStyle='rgba(20,26,44,.6)'; ctx.lineWidth=1.2*k; ctx.stroke();
    ctx.beginPath(); ctx.arc(wx, wy, 6, 0, 6.2832); ctx.fillStyle='#5a6690'; ctx.fill();  // pino do pulso
    ctx.beginPath(); ctx.arc(px, py, 13, 0, 6.2832); ctx.fillStyle='#7a86b0'; ctx.fill();
    ctx.strokeStyle='rgba(20,26,44,.6)'; ctx.lineWidth=1.3*k; ctx.stroke();

    // 11) pino da manivela por cima da cabeça da biela (a biela "monta" no pino)
    ctx.beginPath(); ctx.arc(px, py, 7, 0, 6.2832); ctx.fillStyle='#aab6e0'; ctx.fill();
    ctx.strokeStyle='rgba(20,26,44,.6)'; ctx.lineWidth=1*k; ctx.stroke();

    // 12) vela + faísca (branco/amarelo chapado, sem glow) logo após entrar na explosão
    ctx.fillStyle='#b7bfd0'; ctx.fillRect(-5, d.headTop+2, 10, 15);
    ctx.fillStyle='#8b93a6'; ctx.fillRect(-7, d.headTop+15, 14, 8);
    ctx.fillStyle='#6b7080'; ctx.fillRect(-3, d.headTop+23, 6, 15);
    ctx.strokeStyle='rgba(20,26,44,.5)'; ctx.lineWidth=1*k; ctx.strokeRect(-5, d.headTop+2, 10, 15);
    const elecY = d.ceil-2;
    if(g.sIdx===2 && g.u<0.18){
      const fa = 1-(g.u/0.18);
      ctx.fillStyle='rgba(255,255,255,'+(0.92*fa).toFixed(2)+')';
      ctx.beginPath(); ctx.arc(0, elecY, 7.5, 0, 6.2832); ctx.fill();
      ctx.fillStyle='rgba(255,224,102,'+(0.85*fa).toFixed(2)+')';
      ctx.beginPath(); ctx.arc(0, elecY, 4, 0, 6.2832); ctx.fill();
      ctx.strokeStyle='rgba(255,240,180,'+(0.9*fa).toFixed(2)+')'; ctx.lineWidth=1.7*k;
      for(let i=0;i<6;i++){ const a=i*Math.PI/3 + g.th;
        ctx.beginPath(); ctx.moveTo(Math.cos(a)*4, elecY+Math.sin(a)*4); ctx.lineTo(Math.cos(a)*12, elecY+Math.sin(a)*12); ctx.stroke(); }
    } else {
      ctx.fillStyle='rgba(180,190,210,.5)'; ctx.beginPath(); ctx.arc(0, elecY, 2.2, 0, 6.2832); ctx.fill();
    }

    // 13) contorno de seleção
    if(selected){ ctx.strokeStyle='#fff'; ctx.lineWidth=2*k;
      rr(-d.halfW-4, d.topY-4, (d.halfW+4)*2, (d.botY-d.topY)+8, 16); ctx.stroke(); }

    ctx.restore();
  },

  // âncoras WORLD das sub-peças (para anotações e hit-testing)
  parts(n, e){
    const g = this._geo(n, e), d = g.d;
    const S = n.scale || 1, ox = n.x || 0, oy = n.y || 0;
    const W = (lx, ly) => [ ox + lx*S, oy + ly*S ];
    const crown = g.yW - d.pistonH/2;
    return {
      piston:  W(0, g.yW),
      rod:     W(g.Px*0.5, (g.yW + g.Py)/2),
      crank:   W(0, d.cyC),
      intake:  W(-19, d.ceil - 3),
      exhaust: W(19, d.ceil - 3),
      spark:   W(0, d.headTop + 10),
      chamber: W(0, (d.ceil + crown)/2),
      cylinder:W(-d.wallOut + 4, -18)
    };
  },

  hit(inst, n, wx, wy, e){
    const P = this.parts(n, e), S = n.scale || 1;
    const T = {
      piston:  ['Pistão', 'Sobe e desce no cilindro; a explosão o empurra e ele transmite a força à biela.'],
      rod:     ['Biela', 'Liga o pistão ao virabrequim, convertendo o movimento linear em rotação.'],
      crank:   ['Virabrequim', 'Recebe a força pela biela e gira. Cada ciclo completo são duas voltas.'],
      intake:  ['Válvula de admissão', 'Abre no 1º tempo para entrar a mistura de ar e combustível.'],
      exhaust: ['Válvula de escape', 'Abre no 4º tempo para expulsar os gases queimados.'],
      spark:   ['Vela de ignição', 'Solta a faísca que inflama a mistura comprimida no 3º tempo.'],
      chamber: ['Câmara de combustão', 'Onde a mistura queima. A cor mostra o tempo: azul, índigo, fogo e cinza.'],
      cylinder:['Cilindro', 'O tubo onde o pistão desliza; paredes e cabeçote formam o bloco.']
    };
    let best=null, bestD=Infinity;
    for(const key in P){ const p=P[key], dd=Math.hypot(wx-p[0], wy-p[1]); if(dd<bestD){ bestD=dd; best=key; } }
    if(best && bestD <= 26*S) return { label:T[best][0], info:T[best][1] };
    const d = this._dims(), ox = n.x||0, oy = n.y||0;
    if(wx>=ox+(-d.halfW-6)*S && wx<=ox+(d.halfW+6)*S && wy>=oy+(d.topY-6)*S && wy<=oy+(d.botY+6)*S)
      return { label:n.label, info:n.info };
    return false;
  }
});
