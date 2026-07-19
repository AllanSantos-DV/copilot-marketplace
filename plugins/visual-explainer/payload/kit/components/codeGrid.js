/* DESIGN SYSTEM · "codeGrid" — QUADRO DE REFERÊNCIA de códigos HTTP em colunas por
   família (1xx..5xx). Cada coluna tem um cabeçalho colorido (tag + nome) e uma pilha
   de chips de código; CADA chip é clicável -> painel lateral com definição/analogia.
   Revelação progressiva de colunas por `shown` (nº de famílias visíveis, fracionário
   faz fade). É o "board de tela cheia" do final. FLAT: fills sólidos, borda fina.
   params: { x, y (centro), w, title, colGap, shown,
             families:[{ tag, name, color, note?, codes:[{ n, name, info }] }] } */
VXK.register('codeGrid', {
  create(n){ return { cells:[] }; },
  pos(n){ return [n.x||0, n.y||0]; },
  draw(ctx, inst, n, e, selected){
    const M=e.mat, k=1/e.zoom, x=n.x||0, y=n.y||0;
    const fams=n.families||[];
    if(!fams.length){ inst.cells.length=0; return; }
    const cols=fams.length;
    const W=(n.w!=null?n.w:960);
    const gap=(n.colGap!=null?n.colGap:16);
    const colW=(W-gap*(cols-1))/cols;
    const x0=x-W/2;
    const shownVal=(n.shown!=null?n.shown:cols);
    const titleH=n.title?30:0;
    const headH=40, codeH=32, codeGap=8;
    let maxCodes=0; for(const f of fams) maxCodes=Math.max(maxCodes,(f.codes||[]).length);
    const boardH=titleH+headH+10+maxCodes*(codeH+codeGap);
    const topY=y-boardH/2;
    inst.cells.length=0;

    ctx.save();
    const baseAlpha=ctx.globalAlpha;
    if(n.title){
      ctx.fillStyle='#eaf1ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font='800 '+(((15/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillText(n.title, x, topY+titleH/2);
    }
    const colTop=topY+titleH+6;
    for(let fi=0; fi<cols; fi++){
      const alpha=Math.max(0,Math.min(1, shownVal-fi));
      if(alpha<=0.01) continue;
      const f=fams[fi], col=f.color||'#5b8cff', rgb=M.hex2rgb(col);
      const cx=x0+fi*(colW+gap), ccx=cx+colW/2;
      ctx.globalAlpha=baseAlpha*alpha;

      // cabeçalho da família
      M.roundRectPath(ctx,cx,colTop,colW,headH,9*k);
      ctx.fillStyle=M.rgba(rgb,0.18); ctx.fill();
      M.roundRectPath(ctx,cx,colTop,colW,headH,9*k);
      ctx.strokeStyle=M.rgba(rgb,0.55); ctx.lineWidth=1.3*k; ctx.stroke();
      // ponto + tag + nome
      ctx.beginPath(); ctx.arc(cx+15*k,colTop+headH/2,4*k,0,6.2832); ctx.fillStyle=col; ctx.fill();
      ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillStyle=col; ctx.font='800 '+(((14/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillText(f.tag||'', cx+26*k, colTop+headH/2-6*k);
      ctx.fillStyle=M.rgba([230,238,252],0.82); ctx.font='600 '+(((10.5/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
      ctx.fillText(f.name||'', cx+26*k, colTop+headH/2+8*k);

      // chips de código
      const codes=f.codes||[], chipTop=colTop+headH+10;
      for(let ci=0; ci<codes.length; ci++){
        const cd=codes[ci], chY=chipTop+ci*(codeH+codeGap);
        M.roundRectPath(ctx,cx,chY,colW,codeH,8*k);
        ctx.fillStyle=M.rgba(rgb,0.09); ctx.fill();
        M.roundRectPath(ctx,cx,chY,colW,codeH,8*k);
        ctx.strokeStyle=selected?'#ffffff':M.rgba(rgb,0.34); ctx.lineWidth=1.1*k; ctx.stroke();
        // marca colorida
        M.roundRectPath(ctx,cx+9*k,chY+codeH/2-7*k,3.4*k,14*k,1.6*k); ctx.fillStyle=col; ctx.fill();
        // número + nome
        ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.fillStyle='#eef3ff'; ctx.font='800 '+(((13/e.zoom)|0)||1)+'px "Consolas",ui-monospace,monospace';
        ctx.fillText(cd.n||'', cx+18*k, chY+codeH/2+0.5*k);
        const numW=ctx.measureText(cd.n||'').width;
        ctx.fillStyle=M.rgba([210,221,242],0.78); ctx.font='600 '+(((11/e.zoom)|0)||1)+'px "Segoe UI",system-ui,sans-serif';
        const nmX=cx+18*k+numW+8*k, nmMax=colW-(numW+18+12);
        ctx.fillText(cd.name||'', nmX, chY+codeH/2+0.5*k, nmMax>0?nmMax:undefined);
        if(alpha>0.5) inst.cells.push({x0:cx,x1:cx+colW,y0:chY,y1:chY+codeH,fi:fi,ci:ci});
      }
      ctx.globalAlpha=baseAlpha;
    }
    ctx.restore();
  },
  hit(inst,n,wx,wy){
    const fams=n.families||[];
    for(const c of inst.cells){
      if(wx>=c.x0&&wx<=c.x1&&wy>=c.y0&&wy<=c.y1){
        const f=fams[c.fi]||{}, cd=(f.codes||[])[c.ci]||{};
        return { label:(cd.n||'')+' · '+(cd.name||''), info:cd.info||'', color:f.color||'#5b8cff' };
      }
    }
    return false;
  },
  bounds(n){
    const fams=n.families||[], W=(n.w!=null?n.w:960);
    let maxCodes=0; for(const f of fams) maxCodes=Math.max(maxCodes,(f.codes||[]).length);
    const titleH=n.title?30:0, headH=40, codeH=32, codeGap=8;
    const boardH=titleH+headH+10+maxCodes*(codeH+codeGap);
    const x=n.x||0, y=n.y||0;
    return [x-W/2, y-boardH/2, x+W/2, y+boardH/2];
  }
});
