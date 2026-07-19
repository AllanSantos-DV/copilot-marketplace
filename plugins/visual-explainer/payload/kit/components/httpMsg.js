/* DESIGN SYSTEM · "httpMsg" — cartão de ANATOMIA de uma mensagem HTTP (requisição
   ou resposta) em formato-de-fio (wire format), monoespaçado. A primeira linha
   (request-line / status-line) é destacada. CADA LINHA é clicável -> painel lateral
   com o significado do campo. Revelação progressiva por `shown` (nº de linhas).
   FLAT: fills sólidos, borda fina, sem sombra/3D.
   params: { x, y (centro), w, kind('request'|'response'), title, accent,
             lines:[{ text, label, info, family? }], shown } */
VXK.register('httpMsg', {
  create(n){ return { rows:[], L:0, R:0 }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, k=1/e.zoom, x=n.x||0, y=n.y||0;
    const W=(n.w!=null?n.w:470);
    const lines=n.lines||[];
    const N=lines.length;
    const shownN=Math.max(0,Math.min(N, n.shown!=null?n.shown:N));
    const acc=n.accent||(n.kind==='response'?'#52bf63':'#5b8cff');
    const accRgb=M.hex2rgb(acc);
    const headerH=32, lineH=25, padX=16;
    const bodyH=N*lineH+14, H=headerH+bodyH;
    const L=x-W/2, T=y-H/2, rad=13;
    inst.L=L; inst.R=L+W; inst.rows.length=0;

    ctx.save();
    // corpo
    M.roundRectPath(ctx,L,T,W,H,rad); ctx.fillStyle='#111a2b'; ctx.fill();
    M.roundRectPath(ctx,L,T,W,H,rad);
    ctx.strokeStyle=selected?'#ffffff':M.rgba([238,243,255],0.20);
    ctx.lineWidth=(selected?2:1.3)*k; ctx.stroke();

    // header
    ctx.save();
    M.roundRectPath(ctx,L,T,W,headerH,rad); ctx.clip();
    ctx.fillStyle=M.rgba(accRgb,0.18); ctx.fillRect(L,T,W,headerH);
    ctx.fillStyle=acc; ctx.fillRect(L,T,4*k,headerH);
    ctx.restore();
    const ttl=n.title||(n.kind==='response'?'Resposta HTTP':'Requisição HTTP');
    ctx.fillStyle='#eaf1ff'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.font='700 '+(((13/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillText(ttl, L+padX, T+headerH/2+0.5*k);
    // dica de clique à direita
    ctx.fillStyle=M.rgba(accRgb,0.85); ctx.textAlign='right';
    ctx.font='600 '+(((10.5/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
    ctx.fillText('clique numa linha', L+W-padX, T+headerH/2+0.5*k);

    // linhas
    const mono='"Consolas","SF Mono",ui-monospace,monospace';
    const fs=((13/e.zoom)|0)||1, fsTag=((10/e.zoom)|0)||1;
    const bodyTop=T+headerH+7;
    for(let i=0;i<N;i++){
      if(i>=shownN) break;
      const ln=lines[i], rowY=bodyTop+i*lineH, cy=rowY+lineH/2;
      inst.rows.push({y0:rowY,y1:rowY+lineH,idx:i});
      const isFirst=(i===0);
      const sel = selected && false;
      if(isFirst){
        M.roundRectPath(ctx,L+7*k,rowY+2*k,W-14*k,lineH-4*k,6*k);
        ctx.fillStyle=M.rgba(accRgb,0.13); ctx.fill();
      }
      // texto mono
      const famCol = ln.family ? ln.family : null;
      ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.font=(isFirst?'700 ':'')+fs+'px '+mono;
      ctx.fillStyle = isFirst ? (famCol||acc) : (ln.family|| '#cdd9ef');
      const maxTextW=W-padX*2-(ln.label?86*k:0);
      ctx.fillText(ln.text||'', L+padX, cy, maxTextW>0?maxTextW:undefined);
      // etiqueta do campo à direita
      if(ln.label){
        ctx.textAlign='right'; ctx.fillStyle=M.rgba([150,166,196],0.9);
        ctx.font='600 '+fsTag+'px "Segoe UI",system-ui,sans-serif';
        ctx.fillText(ln.label, L+W-padX, cy+0.5*k);
      }
      // separador fino
      if(i<shownN-1){
        ctx.strokeStyle=M.rgba([238,243,255],0.06); ctx.lineWidth=1*k;
        ctx.beginPath(); ctx.moveTo(L+padX,rowY+lineH); ctx.lineTo(L+W-padX,rowY+lineH); ctx.stroke();
      }
    }
    ctx.restore();
  },
  hit(inst,n,wx,wy){
    const lines=n.lines||[], N=lines.length;
    const shownN=Math.max(0,Math.min(N, n.shown!=null?n.shown:N));
    if(wx<inst.L||wx>inst.R) return false;
    for(const r of inst.rows){
      if(r.idx>=shownN) continue;
      if(wy>=r.y0&&wy<=r.y1){
        const ln=lines[r.idx]||{};
        return { label: ln.label? (ln.label+' — '+(ln.text||'')) : (ln.text||''),
                 info: ln.info||'', color:n.accent||(n.kind==='response'?'#52bf63':'#5b8cff') };
      }
    }
    return false;
  },
  parts(n){
    const W=(n.w!=null?n.w:470), lines=n.lines||[], N=lines.length;
    const H=32+(N*25+14), x=n.x||0, y=n.y||0;
    return { center:[x,y], top:[x,y-H/2], bottom:[x,y+H/2], left:[x-W/2,y], right:[x+W/2,y] };
  },
  bounds(n){
    const W=(n.w!=null?n.w:470), N=(n.lines||[]).length, H=32+(N*25+14), x=n.x||0, y=n.y||0;
    return [x-W/2, y-H/2, x+W/2, y+H/2];
  }
});
