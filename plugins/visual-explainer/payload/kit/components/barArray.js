/* DESIGN SYSTEM · "barArray" — vetor de barras com animação de ORDENAÇÃO (bubble sort).
   params: { values?|n, x0?, y0(baseline)?, barW, gap, maxH, color, colors?, highlight?, sort:false?, stepEvery(seg/comparação) }
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
  _controlled(n){ return (n.sort===false || n.controlled===true); },
  _values(st, n){
    if(this._controlled(n) && Array.isArray(n.values)) return n.values.slice();
    return st.vals;
  },
  _geom(st, n, vals){
    const N=vals.length, barW=n.barW||26, gap=n.gap||8, maxH=n.maxH||220;
    const totalW=N*(barW+gap)-gap;
    const base=(Array.isArray(n.values)&&this._controlled(n))?n.values:st.init;
    const maxVal=n.maxValue || Math.max.apply(null, base.concat(vals));
    return { N, barW, gap, maxH, maxVal,
      x0:(n.x0!=null?n.x0:-totalW/2), y0:(n.y0!=null?n.y0:130) };
  },
  _barColor(k, st, n, controlled){
    if(Array.isArray(n.colors) && n.colors[k]) return n.colors[k];
    const hi=n.highlight;
    if((Array.isArray(hi) && hi.indexOf(k)>=0) || hi===k) return n.highlightColor || '#ffd36b';
    if(!controlled && k>=st.sortedFrom) return '#5b6577';
    if(!controlled && (k===st.cmp[0]||k===st.cmp[1])) return '#ffd36b';
    return n.color || '#3fddb3';
  },
  pos(n, e){
    const vals=Array.isArray(n.values)?n.values:(new Array(n.n||14)).fill(1);
    const barW=n.barW||26, gap=n.gap||8, maxH=n.maxH||220, totalW=vals.length*(barW+gap)-gap;
    const x0=(n.x0!=null?n.x0:-totalW/2), y0=(n.y0!=null?n.y0:130);
    return [x0+totalW/2, y0-maxH/2];
  },
  draw(ctx, st, n, e, selected){
    const controlled=this._controlled(n);
    if(!controlled) this._sync(st, Math.floor(e.t / (n.stepEvery||0.28)));
    const vals=this._values(st,n), g=this._geom(st,n,vals);
    for(let k=0;k<g.N;k++){
      const h=30 + (vals[k]/g.maxVal)*(g.maxH-30), x=g.x0+k*(g.barW+g.gap), y=g.y0-h;
      const col=this._barColor(k, st, n, controlled);
      ctx.fillStyle=col; ctx.fillRect(x, y, g.barW, h);
      if(k===st.selIdx){ ctx.strokeStyle='#fff'; ctx.lineWidth=2/e.zoom; ctx.strokeRect(x-1, y-1, g.barW+2, h+2); }
      if(n.showValues){
        ctx.fillStyle=n.labelColor||'#eef3ff'; ctx.font=(((11/e.zoom)|0)||1)+'px Segoe UI'; ctx.textAlign='center';
        ctx.fillText(String(vals[k]), x+g.barW/2, y-7/e.zoom);
      }
    }
  },
  hit(st, n, wx, wy, e){
    const controlled=this._controlled(n);
    if(!controlled) this._sync(st, Math.floor(e.t / (n.stepEvery||0.28)));
    const vals=this._values(st,n), g=this._geom(st,n,vals);
    for(let k=0;k<g.N;k++){
      const h=30 + (vals[k]/g.maxVal)*(g.maxH-30), x=g.x0+k*(g.barW+g.gap), y=g.y0-h;
      if(wx>=x && wx<=x+g.barW && wy>=y && wy<=g.y0){ st.selIdx=k;
        return { label:'Barra '+(k+1), color:this._barColor(k, st, n, controlled),
          info:'Valor '+vals[k]+' · posição '+(k+1)+(!controlled&&k>=st.sortedFrom?' (já ordenada)':'') }; }
    }
    return false;
  }
});
