/* =====================================================================
   VXK — Visual Explainer Kit · runtime próprio (leve)
   Shell auto-montado + engine: loop ~30 FPS (dt), DPR<=1.5, pausa em aba
   oculta, zoom/pan, hit-testing. O agente NUNCA reescreve isto.
   API: VXK.register(type, def) · VXK.mount(spec, mountSel)
   ===================================================================== */
(function(){
  "use strict";
  const registry = {};
  function register(type, def){ registry[type] = def; }

  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function buildShell(root, spec){
    root.innerHTML =
      '<div class="vxk-wrap">' +
        '<header class="vxk-header"><h1 data-vxk="ttl">'+esc(spec.title||'Explicação')+'</h1>' +
          (spec.badge ? '<span class="vxk-tag">'+esc(spec.badge)+'</span>' : '') +
        '</header>' +
        '<main class="vxk-main">' +
          '<div class="vxk-stage">' +
            '<div class="vxk-hint">'+esc(spec.hint||'Arraste = mover · roda = zoom · clique num elemento')+'</div>' +
            '<canvas data-vxk="cv"></canvas>' +
          '</div>' +
          '<aside class="vxk-aside"><h2><span class="vxk-sw" data-vxk="sw"></span><span data-vxk="ittl">Info</span></h2><p data-vxk="itxt"></p></aside>' +
        '</main>' +
        '<footer class="vxk-footer">' +
          '<button data-vxk="play">⏸ Pausar</button>' +
          '<button class="ghost" data-vxk="reset">↺ Reiniciar</button>' +
          '<div class="vxk-ctl">Velocidade <input type="range" data-vxk="spd" min="0.2" max="3" step="0.1" value="1"><span data-vxk="spdv">1.0×</span></div>' +
          '<button class="ghost" data-vxk="zin">＋</button>' +
          '<button class="ghost" data-vxk="zout">－</button>' +
        '</footer>' +
      '</div>';
  }

  function mount(spec, mountSel){
    const root = document.querySelector(mountSel || '#vxk-root') || document.body;
    if(spec.accent) document.documentElement.style.setProperty('--vxk-accent', spec.accent);
    buildShell(root, spec);
    const q = s => root.querySelector('[data-vxk="'+s+'"]');
    const cv = q('cv'), ctx = cv.getContext('2d');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lite = ((navigator.hardwareConcurrency||8)<=4) || ((navigator.deviceMemory||8)<=4);

    let dpr=1, cssW=0, cssH=0, cx=0, cy=0;
    let t=0, playing=!reduce, speed=1, zoom=1, panX=0, panY=0, sel=null;

    const nodes = (spec.nodes||[]).map(n => ({ ...n, _inst: (registry[n.type] && registry[n.type].create ? registry[n.type].create(n) : {}) }));

    const iTtl=q('ittl'), iTxt=q('itxt'), sw=q('sw');
    function showInfo(node){
      if(node){ iTtl.textContent=node.label||''; iTxt.textContent=node.info||''; sw.style.background=node.color||'var(--vxk-accent)'; }
      else { iTtl.textContent=spec.title||'Info'; iTxt.textContent=spec.intro||'Clique num elemento para ver detalhes.'; sw.style.background='var(--vxk-accent)'; }
    }
    showInfo(null);
    if(reduce){ const p=q('play'); if(p) p.textContent='▶ Tocar'; }

    function resize(){
      dpr = lite ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
      const r = cv.getBoundingClientRect(); cssW=r.width; cssH=r.height; cx=cssW/2; cy=cssH/2;
      cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr);
    }
    new ResizeObserver(()=>resize()).observe(cv); resize();

    const env = () => ({ ctx, t, zoom, cx, cy, panX, panY, lite, cssW, cssH });

    function draw(){
      ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,cv.width,cv.height);
      ctx.setTransform(dpr,0,0,dpr,0,0); ctx.translate(cx+panX, cy+panY); ctx.scale(zoom,zoom);
      const e = env();
      for(const n of nodes){ const c=registry[n.type]; if(c && c.draw) c.draw(ctx, n._inst, n, e, n===sel); }
    }

    // loop com teto de ~30 FPS + pausa em aba oculta
    const FRAME=1/30; let last=0, acc=0;
    function tick(ts){
      requestAnimationFrame(tick);
      if(document.hidden){ last=ts; return; }
      if(!last) last=ts;
      const dt=Math.min(0.05,(ts-last)/1000); last=ts; acc+=dt;
      if(acc<FRAME) return;
      const stepT=acc; acc=0;
      if(playing) t += stepT*speed;
      draw();
    }
    requestAnimationFrame(tick);

    // interação
    function toWorld(mx,my){ return [ (mx-(cx+panX))/zoom, (my-(cy+panY))/zoom ]; }
    let drag=null;
    cv.addEventListener('pointerdown', ev=>{
      const r=cv.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
      const [wx,wy]=toWorld(mx,my); const e=env();
      for(const n of nodes){ const c=registry[n.type]; if(!c || !c.hit) continue; const hr=c.hit(n._inst, n, wx, wy, e); if(hr){ sel=n; showInfo(hr===true ? n : hr); return; } }
      drag={x:mx-panX,y:my-panY}; cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', ev=>{ if(!drag) return; const r=cv.getBoundingClientRect(); panX=(ev.clientX-r.left)-drag.x; panY=(ev.clientY-r.top)-drag.y; });
    cv.addEventListener('pointerup', ()=>drag=null);
    cv.addEventListener('wheel', ev=>{ ev.preventDefault(); const f=ev.deltaY<0?1.1:1/1.1;
      const r=cv.getBoundingClientRect(), mx=ev.clientX-r.left-cx, my=ev.clientY-r.top-cy;
      panX=mx-(mx-panX)*f; panY=my-(my-panY)*f; zoom=Math.max(.4,Math.min(3,zoom*f)); },{passive:false});

    q('play').onclick=e=>{ playing=!playing; e.target.textContent=playing?'⏸ Pausar':'▶ Tocar'; };
    q('reset').onclick=()=>{ t=0; sel=null; zoom=1; panX=0; panY=0; showInfo(null); };
    q('spd').oninput=e=>{ speed=+e.target.value; q('spdv').textContent=speed.toFixed(1)+'×'; };
    q('zin').onclick=()=>{ zoom=Math.min(3,zoom*1.2); };
    q('zout').onclick=()=>{ zoom=Math.max(.4,zoom/1.2); };
    document.addEventListener('visibilitychange', ()=>{ last=0; acc=0; });

    return { get selection(){ return sel; }, get time(){ return t; } };
  }

  window.VXK = { register, mount, version: '0.1.0' };
})();
