/* =====================================================================
   VXK · adapter Konva — motor para GRAFOS / interação pesada.
   Mesmo shell/visual do VXK-core, mas a cena é um grafo:
   nós arrastáveis + arestas que seguem + clique->info + zoom/pan + reorganizar.
   Spec: { engine:"konva", nodes:[{id,label,x?,y?,r?,color,info}], edges:[{from,to,label?}] }
   API: VXKKonva.mount(spec, mountSel)
   ===================================================================== */
window.VXKKonva = (function(){
  "use strict";
  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function shell(root, spec){
    root.innerHTML =
      '<div class="vxk-wrap">' +
        '<header class="vxk-header"><h1>'+esc(spec.title||'Grafo')+'</h1>' +
          '<span class="vxk-tag">'+esc(spec.badge||'Konva')+'</span></header>' +
        '<main class="vxk-main">' +
          '<div class="vxk-stage">' +
            '<div class="vxk-hint">'+esc(spec.hint||'Arraste os nós · roda = zoom · clique num nó')+'</div>' +
            '<div data-vxk="stage" style="position:absolute;inset:0;cursor:grab"></div>' +
          '</div>' +
          '<aside class="vxk-aside"><h2><span class="vxk-sw" data-vxk="sw"></span><span data-vxk="ittl">Info</span></h2><p data-vxk="itxt"></p></aside>' +
        '</main>' +
        '<footer class="vxk-footer">' +
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
    Konva.pixelRatio = lite ? 1 : Math.min(1.5, window.devicePixelRatio || 1);

    const W = host.clientWidth || 800, H = host.clientHeight || 600;
    const stage = new Konva.Stage({ container: host, width: W, height: H, draggable: true });
    const layer = new Konva.Layer(); stage.add(layer);
    const world = new Konva.Group({ x: stage.width()/2, y: stage.height()/2 }); layer.add(world);

    const iTtl=q('ittl'), iTxt=q('itxt'), sw=q('sw');
    function showInfo(n){
      if(n){ iTtl.textContent=n.label||n.id; iTxt.textContent=n.info||''; sw.style.background=n.color||'var(--vxk-accent)'; }
      else { iTtl.textContent=spec.title||'Info'; iTxt.textContent=spec.intro||'Clique num nó para ver detalhes.'; sw.style.background='var(--vxk-accent)'; }
    }
    showInfo(null);

    const specNodes = spec.nodes || [];
    function circular(useFixed){
      const R = Math.min(stage.width(), stage.height()) * 0.34, N = Math.max(1, specNodes.length);
      specNodes.forEach((n,i) => {
        const a = -Math.PI/2 + i/N * 2*Math.PI;
        n._x = (useFixed && n.x!=null) ? n.x : Math.cos(a)*R;
        n._y = (useFixed && n.y!=null) ? n.y : Math.sin(a)*R;
      });
    }
    circular(true);

    const edges = [];
    (spec.edges||[]).forEach(e => {
      const line = new Konva.Line({ points:[0,0,0,0], stroke:'rgba(150,170,200,.45)', strokeWidth:2, listening:false });
      world.add(line);
      let lbl = null;
      if(e.label){ lbl = new Konva.Text({ text:e.label, fontSize:11, fill:'#9aa7c2', fontFamily:'Segoe UI', listening:false }); world.add(lbl); }
      edges.push({ e, line, lbl });
    });

    const nodeMap = {};
    specNodes.forEach(n => {
      const g = new Konva.Group({ x:n._x, y:n._y, draggable:true });
      const r = n.r || 24;
      const circle = new Konva.Circle({ radius:r, fill:n.color||'#5b8cff', stroke:'#0b0f1a', strokeWidth:2, shadowForStrokeEnabled:false });
      const label = new Konva.Text({ text:n.label||n.id, fontSize:12, fontFamily:'Segoe UI', fill:'#eaf0ff' });
      label.offsetX(label.width()/2); label.y(r + 4);
      g.add(circle); g.add(label); world.add(g);
      nodeMap[n.id] = { g, circle }; g._n = n;
      g.on('click tap', () => { select(n.id); showInfo(n); });
      g.on('mouseenter', () => host.style.cursor='pointer');
      g.on('mouseleave', () => host.style.cursor='grab');
      g.on('dragmove', redrawEdges);
    });

    let selId = null;
    function select(id){
      if(selId && nodeMap[selId]){ nodeMap[selId].circle.stroke('#0b0f1a').strokeWidth(2); }
      selId = id;
      if(id && nodeMap[id]){ nodeMap[id].circle.stroke('#ffffff').strokeWidth(4); }
      layer.batchDraw();
    }
    function redrawEdges(){
      edges.forEach(o => {
        const a = nodeMap[o.e.from], b = nodeMap[o.e.to];
        if(!a || !b) return;
        const ax=a.g.x(), ay=a.g.y(), bx=b.g.x(), by=b.g.y();
        o.line.points([ax,ay,bx,by]);
        if(o.lbl){ o.lbl.position({ x:(ax+bx)/2 - o.lbl.width()/2, y:(ay+by)/2 - 8 }); }
      });
      layer.batchDraw();
    }
    redrawEdges(); layer.draw();

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

    new ResizeObserver(() => {
      stage.width(host.clientWidth); stage.height(host.clientHeight);
      world.position({ x:stage.width()/2, y:stage.height()/2 }); layer.batchDraw();
    }).observe(host);

    return { stage };
  }

  return { mount };
})();
