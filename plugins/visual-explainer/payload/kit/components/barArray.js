/* DESIGN SYSTEM · "barArray" — vetor de barras com animação de ORDENAÇÃO (bubble sort).
   params: { values?|n, x0?, y0(baseline)?, barW, gap, maxH, color, stepEvery(seg/comparação) }
   Clique numa barra -> valor/posição/estado. Determinístico por e.t (reset em t=0 reinicia). */
VXK.register('barArray', {
  create(n){
    let vals;
    if(n.values){ vals = n.values.slice(); }
    else { const N=n.n||14; vals=[]; for(let k=1;k<=N;k++) vals.push(k);
      for(let k=N-1;k>0;k--){ const r=(Math.random()*(k+1))|0, t=vals[k]; vals[k]=vals[r]; vals[r]=t; } }
    return { init: vals.slice(), vals: vals.slice(), steps:0, i:0, j:0, sortedFrom: vals.length, done:false, cmp:[-1,-1], selIdx:-1 };
  },
  _one(st){
    if(st.done) return;
    if(st.j >= st.sortedFrom-1){ st.j=0; st.i++; st.sortedFrom--; if(st.sortedFrom<=1){ st.done=true; st.cmp=[-1,-1]; return; } }
    const j=st.j; st.cmp=[j,j+1];
    if(st.vals[j] > st.vals[j+1]){ const t=st.vals[j]; st.vals[j]=st.vals[j+1]; st.vals[j+1]=t; }
    st.j++;
  },
  _sync(st, target){
    if(target < st.steps){ st.vals=st.init.slice(); st.steps=0; st.i=0; st.j=0; st.sortedFrom=st.vals.length; st.done=false; st.cmp=[-1,-1]; }
    let guard=0;
    while(st.steps < target && !st.done && guard++ < 100000){ this._one(st); st.steps++; }
  },
  _geom(st, n){
    const N=st.vals.length, barW=n.barW||26, gap=n.gap||8, maxH=n.maxH||220;
    const totalW=N*(barW+gap)-gap;
    return { N, barW, gap, maxH, maxVal:Math.max.apply(null, st.init),
      x0:(n.x0!=null?n.x0:-totalW/2), y0:(n.y0!=null?n.y0:130) };
  },
  draw(ctx, st, n, e, selected){
    this._sync(st, Math.floor(e.t / (n.stepEvery||0.28)));
    const g=this._geom(st,n);
    for(let k=0;k<g.N;k++){
      const h=30 + (st.vals[k]/g.maxVal)*(g.maxH-30), x=g.x0+k*(g.barW+g.gap), y=g.y0-h;
      let col = n.color || '#3fddb3';
      if(k>=st.sortedFrom) col='#5b6577';
      else if(k===st.cmp[0]||k===st.cmp[1]) col='#ffd36b';
      ctx.fillStyle=col; ctx.fillRect(x, y, g.barW, h);
      if(k===st.selIdx){ ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.strokeRect(x-1, y-1, g.barW+2, h+2); }
    }
  },
  hit(st, n, wx, wy, e){
    const g=this._geom(st,n);
    for(let k=0;k<g.N;k++){
      const h=30 + (st.vals[k]/g.maxVal)*(g.maxH-30), x=g.x0+k*(g.barW+g.gap), y=g.y0-h;
      if(wx>=x && wx<=x+g.barW && wy>=y && wy<=g.y0){ st.selIdx=k;
        return { label:'Barra '+(k+1), color:(k>=st.sortedFrom?'#5b6577':(n.color||'#3fddb3')),
          info:'Valor '+st.vals[k]+' · posição '+(k+1)+(k>=st.sortedFrom?' (já ordenada)':'') }; }
    }
    return false;
  }
});
