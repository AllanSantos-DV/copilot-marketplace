/* =====================================================================
   VXK · adapter Konva — motor para GRAFOS / interação pesada.
   Mesmo shell/visual do VXK-core, mas a cena é um grafo:
   nós arrastáveis + arestas que seguem + clique->info + zoom/pan + reorganizar.
   Spec: { engine:"konva", nodes:[{id,label,sublabel?,icon?,x?,y?,r?,color,info,narration?}],
           edges:[{from,to,label?}] }
   Cada nó mostra o PAPEL dele (ícone Lucide + subtítulo) e cada aresta o que trafega
   (rótulo + pacote correndo na direção). Selecionar um nó (clique ou tour) acende ele
   e os vizinhos, esmaece o resto e lista na lateral com quem ele fala.
   Narração assada (spec._audio): botão "Narrar" (tour) + clique no nó toca a dele.
   API: VXKKonva.mount(spec, mountSel)
   ===================================================================== */
window.VXKKonva = (function(){
  "use strict";
  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function hex2rgb(h){ h=String(h||'#5b8cff').replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); const n=parseInt(h.slice(0,6),16)||0; return [(n>>16)&255,(n>>8)&255,n&255]; }
  const rgba = (h,a) => { const c=hex2rgb(h); return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; };
  const DIM = 0.16;                                   // opacidade do que NÃO está em foco (spotlight)

  function shell(root, spec){
    root.innerHTML =
      '<div class="vxk-wrap">' +
        '<header class="vxk-header"><h1>'+esc(spec.title||'Grafo')+'</h1>' +
          '<span class="vxk-tag">'+esc(spec.badge||'Konva')+'</span></header>' +
        '<main class="vxk-main">' +
          '<div class="vxk-stage">' +
            '<div class="vxk-hint">'+esc(spec.hint||'Clique num nó para ver o papel dele · arraste para reorganizar · roda = zoom')+'</div>' +
            '<div data-vxk="stage" style="position:absolute;inset:0;cursor:grab"></div>' +
          '</div>' +
          '<aside class="vxk-aside"><h2><span class="vxk-sw" data-vxk="sw"></span><span data-vxk="ittl">Info</span></h2><p data-vxk="itxt"></p><div data-vxk="ilinks" class="vxk-links"></div></aside>' +
        '</main>' +
        '<footer class="vxk-footer">' +
          (spec._audio ? '<button data-vxk="narrate">🔊 Narrar</button>' : '') +
          '<button data-vxk="reorg">⟳ Reorganizar</button>' +
          '<button class="ghost" data-vxk="fit">⊡ Ajustar</button>' +
          '<button class="ghost" data-vxk="zin">＋</button>' +
          '<button class="ghost" data-vxk="zout">－</button>' +
        '</footer>' +
      '</div>';
  }

  function mount(spec, mountSel){
    const root = document.querySelector(mountSel || '#vxk-root') || document.body;
    if(spec.accent) document.documentElement.style.setProperty('--vxk-accent', spec.accent);
    shell(root, spec);
    const q = s => root.querySelector('[data-vxk="'+s+'"]');
    const host = q('stage');
    const lite = ((navigator.hardwareConcurrency||8)<=4) || ((navigator.deviceMemory||8)<=4);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    Konva.pixelRatio = lite ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
    const icons = window.VXK && window.VXK.drawIcon ? window.VXK : null;

    const W = host.clientWidth || 800, H = host.clientHeight || 600;
    const stage = new Konva.Stage({ container: host, width: W, height: H, draggable: true });
    const layer = new Konva.Layer(); stage.add(layer);
    const world = new Konva.Group({ x: stage.width()/2, y: stage.height()/2 }); layer.add(world);
    const edgeLayer = new Konva.Group(); world.add(edgeLayer);   // arestas por baixo dos nós

    const specNodes = spec.nodes || [];
    const byId = {}; specNodes.forEach(n => { byId[n.id] = n; });
    const specEdges = (spec.edges||[]).filter(e => byId[e.from] && byId[e.to]);

    // ---- lateral: papel do nó + com quem ele fala (derivado das arestas) ----
    const iTtl=q('ittl'), iTxt=q('itxt'), sw=q('sw'), links=q('ilinks');
    function showInfo(n){
      links.textContent='';
      if(!n){ iTtl.textContent=spec.title||'Info'; iTxt.textContent=spec.intro||'Clique num nó para ver detalhes.'; sw.style.background='var(--vxk-accent)'; return; }
      iTtl.textContent=n.label||n.id; iTxt.textContent=n.narration||n.info||''; sw.style.background=n.color||'var(--vxk-accent)';
      const rows=[];
      for(const e of specEdges){
        if(e.from===n.id) rows.push(['→', byId[e.to], e.label]);
        else if(e.to===n.id) rows.push(['←', byId[e.from], e.label]);
      }
      if(!rows.length) return;
      const h=document.createElement('div'); h.className='vxk-links-h'; h.textContent='Conexões'; links.appendChild(h);
      for(const [dir, o, lbl] of rows){
        const row=document.createElement('button'); row.type='button'; row.className='vxk-link';
        const dot=document.createElement('span'); dot.className='vxk-link-dot'; dot.style.background=o.color||'var(--vxk-accent)';
        const t=document.createElement('span'); t.textContent=dir+' '+(o.label||o.id)+(lbl?' · '+lbl:'');
        row.append(dot, t); row.onclick=()=>{ select(o.id); showInfo(o); if(narrate) narrate.playNode(specNodes.indexOf(o)); };
        links.appendChild(row);
      }
    }
    showInfo(null);

    function circular(useFixed){
      const R = Math.min(stage.width(), stage.height()) * 0.34, N = Math.max(1, specNodes.length);
      specNodes.forEach((n,i) => {
        const a = -Math.PI/2 + i/N * 2*Math.PI;
        n._x = (useFixed && n.x!=null) ? n.x : Math.cos(a)*R;
        n._y = (useFixed && n.y!=null) ? n.y : Math.sin(a)*R;
      });
    }
    circular(true);

    // ---- arestas: seta + rótulo em pílula + pacote correndo na direção ----
    const edges = specEdges.map(e => {
      const col = (byId[e.from].color) || '#8ab4ff';
      const line = new Konva.Arrow({ points:[0,0,0,0], stroke:rgba(col,.7), fill:rgba(col,.9), strokeWidth:2.2,
        pointerLength:9, pointerWidth:9, listening:false });
      edgeLayer.add(line);
      let lbl = null;
      if(e.label){
        lbl = new Konva.Label({ listening:false });
        lbl.add(new Konva.Tag({ fill:'rgba(10,14,24,.92)', stroke:rgba(col,.8), strokeWidth:1, cornerRadius:9 }));
        lbl.add(new Konva.Text({ text:e.label, fontSize:11, fontStyle:'600', fontFamily:'Segoe UI', fill:'#eaf0ff', padding:5 }));
        edgeLayer.add(lbl);
      }
      const tok = (lite||reduce) ? null : new Konva.Circle({ radius:3.4, fill:'#ffffff', opacity:.9, listening:false });
      if(tok) edgeLayer.add(tok);
      return { e, line, lbl, tok, ax:0, ay:0, bx:0, by:0 };
    });

    // ---- nós: halo (foco) + disco com o ícone do papel + rótulo/subtítulo ----
    const nodeMap = {};
    specNodes.forEach(n => {
      const r = n.r || 30, col = n.color || '#5b8cff';
      const g = new Konva.Group({ x:n._x, y:n._y, draggable:true });
      const halo = new Konva.Circle({ radius:r+9, stroke:col, strokeWidth:2, opacity:0, listening:false });
      const disc = new Konva.Circle({ radius:r, fill:rgba(col,.2), stroke:col, strokeWidth:2.2, shadowForStrokeEnabled:false });
      g.add(halo); g.add(disc);
      if(icons && n.icon && icons.hasIcon(n.icon)){
        g.add(new Konva.Shape({ listening:false, sceneFunc(ctx){ icons.drawIcon(ctx._context, n.icon, 0, 0, r*1.05, '#f2f6ff', 1.9); } }));
      } else {
        g.add(new Konva.Text({ text:String(n.label||n.id).slice(0,2).toUpperCase(), fontSize:r*0.62, fontStyle:'700', fontFamily:'Segoe UI',
          fill:'#f2f6ff', width:r*2, offsetX:r, offsetY:r*0.34, align:'center', listening:false }));
      }
      const label = new Konva.Text({ text:n.label||n.id, fontSize:13, fontStyle:'700', fontFamily:'Segoe UI', fill:'#eef3ff' });
      label.offsetX(label.width()/2); label.y(r + 7); g.add(label);
      if(n.sublabel){ const sub = new Konva.Text({ text:n.sublabel, fontSize:11, fontFamily:'Segoe UI', fill:'#9aa7c2' });
        sub.offsetX(sub.width()/2); sub.y(r + 24); g.add(sub); }
      world.add(g);
      nodeMap[n.id] = { g, halo, disc, r }; g._n = n;
      g.on('click tap', () => { select(n.id); showInfo(n); if(narrate) narrate.playNode(specNodes.indexOf(n)); });
      g.on('mouseenter', () => host.style.cursor='pointer');
      g.on('mouseleave', () => host.style.cursor='grab');
      g.on('dragmove', redrawEdges);
    });

    // ---- seleção: acende o nó + vizinhos, esmaece o resto ----
    let selId = null;
    function select(id){
      selId = (id && nodeMap[id]) ? id : null;
      const near = new Set(selId ? [selId] : []);
      if(selId) for(const o of edges){ if(o.e.from===selId) near.add(o.e.to); if(o.e.to===selId) near.add(o.e.from); }
      for(const nid in nodeMap){ const m=nodeMap[nid];
        m.g.opacity(!selId || near.has(nid) ? 1 : DIM);
        m.halo.opacity(nid===selId ? 0.9 : 0); m.disc.strokeWidth(nid===selId ? 3.2 : 2.2); }
      for(const o of edges){ const on = !selId || o.e.from===selId || o.e.to===selId;
        o.line.opacity(on ? 1 : DIM*0.8); o.line.strokeWidth(selId && on ? 3.4 : 2.2);
        if(o.lbl) o.lbl.opacity(on ? 1 : DIM); if(o.tok) o.tok.opacity(on ? .95 : 0); }
      if(selId) nodeMap[selId].g.moveToTop();
      layer.batchDraw();
    }
    stage.on('click tap', ev => { if(ev.target === stage){ select(null); showInfo(null); } });

    function redrawEdges(){
      edges.forEach(o => {
        const a = nodeMap[o.e.from], b = nodeMap[o.e.to];
        const ax=a.g.x(), ay=a.g.y(), bx=b.g.x(), by=b.g.y(), d=Math.hypot(bx-ax,by-ay)||1, ux=(bx-ax)/d, uy=(by-ay)/d;
        o.ax=ax+ux*(a.r+4); o.ay=ay+uy*(a.r+4); o.bx=bx-ux*(b.r+6); o.by=by-uy*(b.r+6);   // borda a borda: a ponta não some dentro do disco
        o.line.points([o.ax,o.ay,o.bx,o.by]);
        if(o.lbl) o.lbl.position({ x:(o.ax+o.bx)/2 - o.lbl.width()/2, y:(o.ay+o.by)/2 - o.lbl.height()/2 });
      });
      layer.batchDraw();
    }
    redrawEdges(); layer.draw();

    // pacotes correndo pelas arestas (direção do fluxo); para em aba oculta (Konva.Animation usa rAF)
    if(!lite && !reduce && edges.length){
      new Konva.Animation(frame => {
        const t = (frame.time/1000) * 0.55;
        for(let i=0;i<edges.length;i++){ const o=edges[i]; if(!o.tok) continue;
          const f = (t + i*0.37) % 1; o.tok.position({ x:o.ax+(o.bx-o.ax)*f, y:o.ay+(o.by-o.ay)*f }); }
      }, edgeLayer.getLayer()).start();
    }

    // controles
    q('reorg').onclick = () => {
      circular(false);
      specNodes.forEach(n => { const nm=nodeMap[n.id]; if(!nm) return;
        new Konva.Tween({ node:nm.g, x:n._x, y:n._y, duration:0.5, easing:Konva.Easings.EaseInOut, onUpdate:redrawEdges }).play(); });
    };
    function zoomBy(f){ const s=Math.max(.4, Math.min(3, stage.scaleX()*f)); stage.scale({x:s,y:s}); layer.batchDraw(); }
    q('zin').onclick = () => zoomBy(1.2);
    q('zout').onclick = () => zoomBy(1/1.2);
    q('fit').onclick = () => { stage.scale({x:1,y:1}); stage.position({x:0,y:0}); layer.batchDraw(); };
    stage.on('wheel', e => {
      e.evt.preventDefault();
      const f = e.evt.deltaY<0 ? 1.1 : 1/1.1;
      const p = stage.getPointerPosition(), s = stage.scaleX(), ns = Math.max(.4, Math.min(3, s*f));
      const mx = (p.x - stage.x())/s, my = (p.y - stage.y())/s;
      stage.scale({x:ns,y:ns}); stage.position({ x:p.x - mx*ns, y:p.y - my*ns }); layer.batchDraw();
    });

    // ---- narração assada (spec._audio): tour guiado + clique-pra-ouvir ----
    // Mesmo contrato do vxk-core: o builder embute intro + um clipe por nó (na
    // ordem de spec.nodes). "Narrar" fala a intro e percorre cada nó destacando-o;
    // clicar num nó toca a narração dele. Áudio que não toca é ERRO visível.
    function mountNarration(A){
      const au = new Audio(), btn = q('narrate');
      let touring = false;
      const setBtn = txt => { if(btn) btn.textContent = txt; };
      function stop(){ touring=false; au.onended=null; au.onerror=null; try{ au.pause(); }catch(e){} setBtn('🔊 Narrar'); }
      function fail(err){
        const m='⚠ áudio da narração falhou: '+((err&&(err.message||err.name))||'erro de mídia');
        console.error('[VXK konva] '+m, err); stop(); setBtn('⚠ Áudio falhou'); iTxt.textContent=m;
      }
      const playURI = uri => new Promise(res => {
        if(!uri){ res(); return; }
        au.onended = () => res();
        au.onerror = () => fail(au.error);
        au.src = uri; const p = au.play(); if(p && p.catch) p.catch(fail);
      });
      async function tour(){
        touring=true; setBtn('⏹ Parar');
        select(null); showInfo(null);
        if(A.intro){ await playURI(A.intro); if(!touring) return; }
        for(let i=0;i<specNodes.length;i++){
          if(!touring) return;
          const n = specNodes[i]; select(n.id); showInfo(n);
          if(A.nodes && A.nodes[i]) await playURI(A.nodes[i]);
        }
        select(null); stop();
      }
      function playNode(i){
        const uri = A.nodes && A.nodes[i]; if(!uri) return false;
        stop(); playURI(uri); return true;              // clique interrompe o tour
      }
      if(btn) btn.onclick = () => { if(touring) stop(); else tour(); };
      return { playNode };
    }
    const narrate = spec._audio ? mountNarration(spec._audio) : null;

    new ResizeObserver(() => {
      stage.width(host.clientWidth); stage.height(host.clientHeight);
      world.position({ x:stage.width()/2, y:stage.height()/2 }); layer.batchDraw();
    }).observe(host);

    return { stage, select };
  }

  return { mount };
})();
