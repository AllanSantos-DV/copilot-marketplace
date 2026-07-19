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

  /* =====================================================================
     Profundidade — cor + luz + MATERIAIS compartilhados (VXK.mat).
     Os componentes desenham com volume chamando estes helpers em vez de
     um fill chapado: esfera com luz/terminador/specular, slab com gradiente
     e sombra, sombra de contato e glow emissivo. Uma direção de luz ÚNICA
     (canto superior-esquerdo) mantém a cena coerente. Respeita e.lite
     (hardware fraco) caindo para versões baratas.
     ===================================================================== */
  const LIGHT = { x:-0.5, y:-0.62 };            // direção da luz, normalizada aprox.
  function hex2rgb(h){ h=String(h==null?'#888':h).replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); const n=parseInt(h.slice(0,6),16)||0; return [ (n>>16)&255, (n>>8)&255, n&255 ]; }
  function clamp8(v){ return v<0?0:v>255?255:v|0; }
  function rgba(rgb,a){ return 'rgba('+(rgb[0]|0)+','+(rgb[1]|0)+','+(rgb[2]|0)+','+a+')'; }
  function shade(rgb,f){ const t=Math.abs(f), to=f>=0?255:0; return [ clamp8(rgb[0]+(to-rgb[0])*t), clamp8(rgb[1]+(to-rgb[1])*t), clamp8(rgb[2]+(to-rgb[2])*t) ]; }
  function hexLerp(a,b,p){ const A=hex2rgb(a), B=hex2rgb(b); const c=i=>clamp8(Math.round(A[i]+(B[i]-A[i])*p)).toString(16).padStart(2,'0'); return '#'+c(0)+c(1)+c(2); }

  // easing por PROPÓSITO (pesquisa de design: nunca linear em UI). cubic-bezier CSS.
  function cubicBezier(x1,y1,x2,y2){
    const cx=3*x1, bx=3*(x2-x1)-cx, ax=1-cx-bx, cy=3*y1, by=3*(y2-y1)-cy, ay=1-cy-by;
    const fx=t=>((ax*t+bx)*t+cx)*t, dfx=t=>(3*ax*t+2*bx)*t+cx, fy=t=>((ay*t+by)*t+cy)*t;
    return p=>{ if(p<=0)return 0; if(p>=1)return 1;
      let lo=0, hi=1, t=p;                                   // Newton com bracket + fallback de bisseção (robusto p/ qualquer curva válida)
      for(let i=0;i<8;i++){ const x=fx(t)-p; if(Math.abs(x)<1e-5) break; if(x>0) hi=t; else lo=t;
        const d=dfx(t); let nt = d>1e-6 ? t-x/d : (lo+hi)/2; if(nt<=lo||nt>=hi) nt=(lo+hi)/2; t=nt; }
      return fy(t); };
  }
  const EASE = { ENTER:cubicBezier(0.2,0,0,1), MOVE:cubicBezier(0.4,0,0.2,1), POP:cubicBezier(0.2,0,0.38,0.9), EXIT:cubicBezier(0.3,0,0.8,0.15) };

  function roundRectPath(ctx,L,T,w,h,r){ ctx.beginPath(); ctx.moveTo(L+r,T); ctx.arcTo(L+w,T,L+w,T+h,r); ctx.arcTo(L+w,T+h,L,T+h,r); ctx.arcTo(L,T+h,L,T,r); ctx.arcTo(L,T,L+w,T,r); ctx.closePath(); }

  const mat = {
    light: LIGHT, hex2rgb, shade, rgba, hexLerp,
    // sombra de contato macia (elipse achatada) sob um objeto no "chão" da cena
    contactShadow(ctx, x, y, rx, ry, a){
      const g=ctx.createRadialGradient(0,0,0,0,0,rx); g.addColorStop(0,'rgba(4,6,12,'+(a==null?0.34:a)+')'); g.addColorStop(1,'rgba(4,6,12,0)');
      ctx.save(); ctx.translate(x,y); ctx.scale(1, ry/rx); ctx.beginPath(); ctx.arc(0,0,rx,0,6.2832); ctx.fillStyle=g; ctx.fill(); ctx.restore();
    },
    // esfera CHAPADA: círculo preenchido, sem gradiente/sombra/rim (visual limpo)
    sphere(ctx, x, y, r, color, e){
      ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fillStyle=color; ctx.fill();
    },
    // halo emissivo (estrela, partícula quente)
    glow(ctx, x, y, r, color, k){
      const rgb=hex2rgb(color), R=r*(k||3);
      const g=ctx.createRadialGradient(x,y,r*0.2,x,y,R); g.addColorStop(0,rgba(rgb,0.5)); g.addColorStop(0.4,rgba(rgb,0.16)); g.addColorStop(1,rgba(rgb,0));
      ctx.beginPath(); ctx.arc(x,y,R,0,6.2832); ctx.fillStyle=g; ctx.fill();
    },
    // slab CHAPADO: retângulo arredondado preenchido + borda fina (sem sombra/gradiente/realce)
    slab(ctx, x, y, w, h, r, color, e, selected){
      const zoom=(e&&e.zoom)||1, L=x-w/2, T=y-h/2;
      roundRectPath(ctx, L, T, w, h, r); ctx.fillStyle=color; ctx.fill();
      roundRectPath(ctx, L, T, w, h, r); ctx.strokeStyle= selected ? '#fff' : 'rgba(255,255,255,.20)'; ctx.lineWidth=(selected?2:1)/zoom; ctx.stroke();
    },
    // ---- DESIGN SYSTEM (pesquisa: tipografia + superfície + easing) ----
    ease: EASE, bez: cubicBezier,
    ds: {
      text:   { primary:'#eef3ff', secondary:'rgba(228,236,251,.64)', muted:'rgba(228,236,251,.40)' },
      hairline:'rgba(238,243,255,.14)', cardIdle:'#182338', cardSel:'#20304e', radius:9,
      // papéis tipográficos: [px de TELA, weight, letter-spacing px, UPPERCASE?]
      roles:{ stepTitle:[20,700,-0.4,0], cardTitle:[14,700,-0.28,0], cardBody:[11.5,400,0,0],
              sublabel:[11,500,0,0], chip:[12,650,0,0], micro:[10,800,0.6,1], value:[13,700,-0.2,0] }
    },
    // define ctx.font + letterSpacing p/ um papel (tamanho constante em px de TELA via 1/zoom)
    type(ctx, role, zoom){
      const r=(this.ds.roles[role]||this.ds.roles.cardBody), k=1/(zoom||1), px=Math.max(1,(r[0]*k)|0);
      ctx.font=r[1]+' '+px+'px "Segoe UI",system-ui,sans-serif';
      ctx.letterSpacing=(r[2]*k)+'px'; return r;
    },
    label(s, role){ const r=this.ds.roles[role]; return (r&&r[3]) ? String(s==null?'':s).toUpperCase() : (s==null?'':String(s)); },
    // CARD canônico FLAT: tint 1 passo acima do fundo + hairline + radius (+ barra de accent + selecionado)
    card(ctx, L, T, w, h, o){
      o=o||{}; const zoom=o.zoom||1, k=1/zoom, r=(o.radius!=null?o.radius:this.ds.radius);
      const base=ctx.globalAlpha;                          // preserva a opacidade de entrada (reveal) — não a atropela
      const fill=o.fill||(o.selected?this.ds.cardSel:this.ds.cardIdle);
      roundRectPath(ctx,L,T,w,h,r); ctx.fillStyle=fill; ctx.fill();
      if(o.accent && o.accentBar){                          // barra de accent na borda esquerda (inset no radius, sem clip)
        ctx.globalAlpha=base*(o.selected?1:.92); ctx.fillStyle=o.accent; ctx.fillRect(L, T+r, 3.5*k, h-2*r); ctx.globalAlpha=base; }
      if(o.accent && o.accentTop){                          // faixa de accent no topo (inset no radius)
        ctx.globalAlpha=base*.9; ctx.fillStyle=o.accent; ctx.fillRect(L+r, T, w-2*r, 3*k); ctx.globalAlpha=base; }
      roundRectPath(ctx,L,T,w,h,r);
      ctx.strokeStyle=o.selected?'#ffffff':(o.stroke||this.ds.hairline);
      ctx.lineWidth=(o.selected?1.8:1.1)*k; ctx.stroke();
    },
    // ÍCONE em container arredondado tintado + stroke consistente (~1.5px de tela)
    iconChip(ctx, cx, cy, size, icon, accent, zoom){
      const k=1/(zoom||1), pad=size*0.36, box=size+pad, r=6*k, rgb=hex2rgb(accent||'#5b8cff');
      roundRectPath(ctx, cx-box/2, cy-box/2, box, box, r); ctx.fillStyle=rgba(rgb,0.15); ctx.fill();
      roundRectPath(ctx, cx-box/2, cy-box/2, box, box, r); ctx.strokeStyle=rgba(rgb,0.32); ctx.lineWidth=1*k; ctx.stroke();
      if(typeof VXK!=='undefined' && VXK.drawIcon && VXK.hasIcon && VXK.hasIcon(icon)) VXK.drawIcon(ctx, icon, cx, cy, size, accent, 1.5*k);
    },
    roundRectPath
  };

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
          (spec._audio && !(spec.scenes && spec.scenes.length) ? '<button data-vxk="narrate">🔊 Narrar</button>' : '') +
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
    let t=0, playing=true, speed=1, zoom=1, panX=0, panY=0, rot=0, sel=null;   // relógio AMBIENTE sempre roda (fluxo/partículas são o conteúdo); reduced-motion só suaviza as transições (RM)
    let narrate=null;   // atribuído adiante se houver spec._audio (narração assada)
    let step=null;      // engine de passos (spec.scenes) — dorme se ausente (zero efeito)

    const nodes = (spec.nodes||[]).map(n => ({ ...n, _inst: (registry[n.type] && registry[n.type].create ? registry[n.type].create(n) : {}) }));

    const iTtl=q('ittl'), iTxt=q('itxt'), sw=q('sw');
    function showInfo(node){
      if(node){ iTtl.textContent=node.label||''; iTxt.textContent=node.info||''; sw.style.background=node.color||'var(--vxk-accent)'; }
      else { iTtl.textContent=spec.title||'Info'; iTxt.textContent=spec.intro||'Clique num elemento para ver detalhes.'; sw.style.background='var(--vxk-accent)'; }
    }
    showInfo(null);

    function resize(){
      dpr = lite ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
      const r = cv.getBoundingClientRect(); cssW=r.width; cssH=r.height; cx=cssW/2; cy=cssH/2;
      cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr);
    }
    new ResizeObserver(()=>resize()).observe(cv); resize();

    const env = () => ({ ctx, t, zoom, cx, cy, panX, panY, rot, lite, cssW, cssH, light: LIGHT, mat });

    function draw(){
      ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,cv.width,cv.height);
      ctx.setTransform(dpr,0,0,dpr,0,0); ctx.translate(cx+panX, cy+panY); ctx.rotate(rot); ctx.scale(zoom,zoom);
      const e = env();
      for(const n of nodes){
        const c=registry[n.type]; if(!(c && c.draw)) continue;
        const op = step ? step.opacityOf(n) : 1;
        if(op<=0.004) continue;                                   // reveal/hide: nó oculto
        ctx.letterSpacing='0px';                                  // guarda: nenhum componente vaza tracking p/ o próximo
        const hasCenter = !!c.pos || (Number.isFinite(n.x) && Number.isFinite(n.y));   // conectores (x0/x1) não têm centro → sem pop
        const sc = (hasCenter && step && step.entryScaleOf) ? step.entryScaleOf(n) : 1;  // scale-pop de entrada (pesquisa)
        if(sc!==1){ const ctr=(c.pos?c.pos(n,e):[n.x||0,n.y||0]);
          ctx.save(); if(op<1) ctx.globalAlpha=op; ctx.translate(ctr[0],ctr[1]); ctx.scale(sc,sc); ctx.translate(-ctr[0],-ctr[1]); c.draw(ctx, n._inst, n, e, n===sel); ctx.restore(); }
        else if(op<1){ ctx.save(); ctx.globalAlpha=op; c.draw(ctx, n._inst, n, e, n===sel); ctx.restore(); }
        else c.draw(ctx, n._inst, n, e, n===sel);
      }
      if(step) step.drawOverlay(e);                               // dim+foco, anotações, sobre os nós
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
      if(step) step.tick(stepT);
      draw();
    }
    requestAnimationFrame(tick);

    // interação
    function toWorld(mx,my){ const dx=(mx-(cx+panX))/zoom, dy=(my-(cy+panY))/zoom, c=Math.cos(rot), s=Math.sin(rot); return [ dx*c+dy*s, -dx*s+dy*c ]; }
    let drag=null;
    cv.addEventListener('pointerdown', ev=>{
      const r=cv.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
      const [wx,wy]=toWorld(mx,my); const e=env();
      // ordem de acerto: nó(s) EM FOCO primeiro (estão em destaque), depois TOPO-pintado (último desenhado) — clique certeiro em sobreposição
      const foc = step && step.focusSet ? step.focusSet() : null;
      const order = nodes.slice().reverse();
      if(foc && foc.size) order.sort((a,b)=> ((foc.has(b.id)?1:0)-(foc.has(a.id)?1:0)));
      for(const n of order){ const c=registry[n.type]; if(!c || !c.hit) continue; if(step && step.opacityOf(n)<=0.02) continue; const hr=c.hit(n._inst, n, wx, wy, e); if(hr){ sel=n; showInfo(hr===true ? n : hr); if(narrate){ narrate.playNode(nodes.indexOf(n)); } return; } }
      drag={x:mx-panX,y:my-panY}; cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', ev=>{ if(!drag) return; const r=cv.getBoundingClientRect(); panX=(ev.clientX-r.left)-drag.x; panY=(ev.clientY-r.top)-drag.y; });
    cv.addEventListener('pointerup', ()=>drag=null);
    cv.addEventListener('wheel', ev=>{ ev.preventDefault(); const f=ev.deltaY<0?1.1:1/1.1;
      const r=cv.getBoundingClientRect(), mx=ev.clientX-r.left-cx, my=ev.clientY-r.top-cy;
      panX=mx-(mx-panX)*f; panY=my-(my-panY)*f; zoom=Math.max(.4,Math.min(3,zoom*f)); },{passive:false});

    q('play').onclick=e=>{ playing=!playing; e.target.textContent=playing?'⏸ Pausar':'▶ Tocar'; };
    q('reset').onclick=()=>{ t=0; sel=null; showInfo(null); if(step){ step.reset(); } else { zoom=1; panX=0; panY=0; rot=0; } };
    q('spd').oninput=e=>{ speed=+e.target.value; q('spdv').textContent=speed.toFixed(1)+'×'; };
    q('zin').onclick=()=>{ zoom=Math.min(3,zoom*1.2); };
    q('zout').onclick=()=>{ zoom=Math.max(.4,zoom/1.2); };
    document.addEventListener('visibilitychange', ()=>{ last=0; acc=0; });

    // ---- narração assada (spec._audio): tour guiado + clique-pra-ouvir ----
    // O áudio é embutido em base64 pelo builder (motor único vox-engine). O
    // "Narrar" percorre intro + cada nó EM ORDEM, destacando (sel) e mostrando
    // a info de cada um enquanto fala; ao terminar um trecho, avança sozinho —
    // é a experiência "videoclipe". Clicar num nó toca a narração dele (no
    // pointerdown, quando o hit-test acerta o nó — nunca ao arrastar o fundo).
    const A = spec._audio;
    if(A){
      const au = new Audio();
      let touring = false;
      const nbtn = () => q('narrate');
      const setBtn = txt => { const b=nbtn(); if(b) b.textContent=txt; };
      function stopNarr(){ touring=false; au.onended=null; try{ au.pause(); }catch(e){} setBtn('🔊 Narrar'); }
      const playURI = uri => new Promise(res => {
        if(!uri){ res(); return; }
        au.onended = () => res(); au.onerror = () => res();
        au.src = uri; const p = au.play(); if(p && p.catch) p.catch(()=>res());
      });
      async function tourRun(){
        touring=true; setBtn('⏹ Parar');
        playing=true;                                   // narrar toca a animação junto
        { const pb=q('play'); if(pb) pb.textContent='⏸ Pausar'; }
        sel=null; showInfo(null);
        if(A.intro){ await playURI(A.intro); if(!touring) return; }
        for(let i=0;i<nodes.length;i++){
          if(!touring) return;
          const uri = A.nodes && A.nodes[i];
          sel = nodes[i]; showInfo(nodes[i]);
          if(uri) await playURI(uri);
        }
        stopNarr();
      }
      function playNode(i){
        const uri = A.nodes && A.nodes[i]; if(!uri) return false;
        touring=false; au.onended=null;   // clique interrompe o tour
        setBtn('🔊 Narrar');
        au.src = uri; const p = au.play(); if(p && p.catch) p.catch(()=>{});
        return true;
      }
      const nb = nbtn(); if(nb) nb.onclick = () => { if(touring) stopNarr(); else tourRun(); };
      narrate = { playNode };
    }

    // =================================================================
    //  STEP ENGINE — coreografia de passos (ADITIVO; só acorda com
    //  spec.scenes). Roda por cima do relógio contínuo: câmera, reveal/
    //  hide, foco (dim + re-desenho), anotações espaciais e narração por
    //  passo. Os componentes NÃO mudam — são desenhados normalmente e, no
    //  foco, de novo sobre o escurecimento. Tudo interpola no mesmo loop.
    // =================================================================
    function mountStepEngine(){
      const steps = [];
      for(const sc of spec.scenes){ for(const st of (sc.steps||[])) steps.push(st); }
      if(!steps.length) return null;
      const N = steps.length, byId = {};
      for(const n of nodes){ if(n.id!=null) byId[n.id]=n; }

      const easeOut = p => p<=0?0 : p>=1?1 : 1-Math.pow(1-p,3);   // ease-out cúbico
      const clamp01 = p => p<0?0 : p>1?1 : p;
      const RM = reduce ? 0.4 : 1;                                // encurta se prefers-reduced-motion
      const easeMove = EASE.MOVE, easeEnter = EASE.ENTER;         // câmera = ease-in-out; reveal = enter (pesquisa de design)

      let cur = 0, elapsed = 0, maxDur = 0, transitioning = false;
      let animFrom = {}, animTo = {}, animDur = 0.6;
      let camFrom = {zoom, panX, panY, rot}, camTo = {zoom, panX, panY, rot}, camDur = 0.5;
      let sigDur = 0.5, dimAlpha = 0, dimFrom = 0, dimTarget = 0;
      let activeFocus = null, annList = [], annAlpha = 0;
      const opCur = {}, opTarget = {}, opFrom = {};
      for(const id in byId){ opCur[id]=0; opTarget[id]=0; opFrom[id]=0; }   // tudo oculto até reveal
      const entryAt = {};                                                  // uiClock em que o pop de entrada de cada nó começa
      let uiClock = 0;                                                      // relógio de UI SEMPRE avança (independe de playing) — pop nunca congela
      // baseline das props que QUALQUER passo anima (p/ reset determinístico ao retroceder/reiniciar)
      const animBase = {};
      for(const st of steps){ const a=st.animate||{}; for(const id in a){ if(id==='duration') continue; const n=byId[id]; if(!n) continue;
        animBase[id]=animBase[id]||{}; for(const k in a[id]){ if(!(k in animBase[id])) animBase[id][k]=(n[k]!=null?n[k]:a[id][k]); } } }
      function visibleAt(i){ const vis=new Set();                          // visibilidade cumulativa dos passos 0..i (reveal soma, hide tira)
        for(let s=0;s<=i;s++){ const st=steps[s]; if(st.freeRun) continue; if(st.reveal) for(const id of st.reveal) vis.add(id); if(st.hide) for(const id of st.hide) vis.delete(id); } return vis; }
      function applyEntryProps(i){                                         // estado das props no INÍCIO do passo i = baseline + fins commitados de 0..i-1
        for(const id in animBase){ const n=byId[id]; if(n) for(const k in animBase[id]) n[k]=animBase[id][k]; }
        for(let s=0;s<i;s++){ const a=steps[s].animate||{}; for(const id in a){ if(id==='duration') continue; const n=byId[id]; if(!n) continue; for(const k in a[id]) n[k]=a[id][k]; } } }
      function registerEntries(i){                                         // marca o pop dos nós REVELADOS de novo no passo i (stagger em ordem de leitura)
        if(reduce) return; const vis=visibleAt(i), prev=i>0?visibleAt(i-1):new Set();
        const fresh=[]; if(steps[i] && steps[i].reveal) for(const id of steps[i].reveal){ if(vis.has(id) && !prev.has(id) && byId[id]) fresh.push(id); }
        let k=0; for(const id of fresh){ entryAt[id]= uiClock + (k++)*0.045; }    // 45ms de atraso por elemento
      }
      function clearEntries(){ for(const id in entryAt) delete entryAt[id]; }     // reset/instant: nenhum pop pendente (evita nó preso em 0.9)
      function entryScaleOf(id){                                           // 0.9 → ~1.03 → 1.0 (o card "aterrissa")
        const t0=entryAt[id]; if(t0==null||reduce) return 1;
        const p=(uiClock - t0)/0.24; if(p>=1){ delete entryAt[id]; return 1; } if(p<=0) return 0.9;
        return 0.9 + 0.1*EASE.POP(p) + 0.035*Math.sin(Math.PI*p);
      }
      // ---- AUTO-ENQUADRAMENTO: preenche a tela com o conteúdo visível (aproveita o zoom) ----
      const fin = Number.isFinite;
      function nodeBounds(n){                                              // bbox de MUNDO de um nó (usa bounds() do componente, senão estima)
        const c=registry[n.type]; if(c && c.bounds){ const b=c.bounds(n, env()); if(b) return b; }
        if(fin(n.x0)&&fin(n.y0)&&fin(n.x1)&&fin(n.y1)) return [Math.min(n.x0,n.x1),Math.min(n.y0,n.y1),Math.max(n.x0,n.x1),Math.max(n.y0,n.y1)];
        if(fin(n.x)&&fin(n.y)){
          if(fin(n.r)) return [n.x-n.r,n.y-n.r,n.x+n.r,n.y+n.r];
          let w=n.w, h=n.h;
          if(!fin(w)) w = (n.type==='chip'?160 : n.type==='callout'?180 : 120);
          if(!fin(h)) h = (n.type==='chip'?30 : n.type==='callout'?64 : 54);
          return [n.x-w/2, n.y-h/2, n.x+w/2, n.y+h/2];
        }
        return null;
      }
      function fitCamera(ids){                                            // câmera que encaixa o bbox dos ids na tela com margens
        let X0=1e9,Y0=1e9,X1=-1e9,Y1=-1e9, any=false;
        for(const id of ids){ const n=byId[id]; if(!n) continue; const b=nodeBounds(n); if(!b) continue; any=true;
          if(b[0]<X0)X0=b[0]; if(b[1]<Y0)Y0=b[1]; if(b[2]>X1)X1=b[2]; if(b[3]>Y1)Y1=b[3]; }
        if(!any || !(cssW>0) || !(cssH>0)) return null;
        const W=Math.max(1,X1-X0), H=Math.max(1,Y1-Y0), mx=(X0+X1)/2, my=(Y0+Y1)/2;
        const MX=0.055, MTOP=0.135, MBOT=0.11;                            // margens: topo extra p/ o título do passo
        const aw=cssW*(1-2*MX), ah=cssH*(1-MTOP-MBOT);
        let z=Math.min(aw/W, ah/H); z=Math.max(0.4, Math.min(1.75, z));   // clamp de zoom (não estoura em conteúdo esparso)
        return { zoom:z, panX:-mx*z, panY:cssH*(MTOP-MBOT)/2 - my*z };
      }

      const A = spec._audio, au = new Audio();
      let explaining = false, advTimer = null;
      let freeRun = null, frFrames = [], frIdx = 0, frDwell = 0.6, freeTimer = null, freeAudioDone = false;   // fluxo completo (loop sem pausas)
      function clearFree(){ if(freeTimer){ clearTimeout(freeTimer); freeTimer=null; } }

      // ---------- HUD (DOM, estilizado como o rodapé) ----------
      const stage = root.querySelector('.vxk-stage'), footer = root.querySelector('.vxk-footer');
      const titleEl = document.createElement('div'); titleEl.className='vxk-steptitle';
      const capEl   = document.createElement('div'); capEl.className='vxk-caption'; capEl.style.display='none';
      if(stage){ stage.appendChild(titleEl); stage.appendChild(capEl); }
      const nav = document.createElement('span'); nav.className='vxk-ctl vxk-stepnav';
      const bExplain = document.createElement('button'); bExplain.textContent = (A && A.steps) ? '▶ Explicar' : '▶ Reproduzir';
      const bPrev = document.createElement('button'); bPrev.className='ghost'; bPrev.textContent='◀'; bPrev.title='Passo anterior (←)';
      const cnt = document.createElement('span'); cnt.className='vxk-stepcount';
      const bNext = document.createElement('button'); bNext.className='ghost'; bNext.textContent='▶'; bNext.title='Próximo passo (→)';
      nav.append(bExplain, bPrev, cnt, bNext);
      if(footer) footer.insertBefore(nav, footer.firstChild);

      function firstLine(s){ const m=String(s||'').trim().split(/(?<=[.!?])\s|—|–|\n/)[0]; return (m||'').slice(0,80); }
      function updateHUD(){
        const st = steps[cur];
        titleEl.textContent = st.title || firstLine(st.narration) || ('Passo '+(cur+1));
        cnt.textContent = (cur+1)+' / '+N;
        if(stage && st.accent) stage.style.borderTopColor = st.accent;   // faixa de accent por seção (pesquisa)
        const hasAudio = !!(A && A.steps && A.steps[cur]);
        if(st.narration && !hasAudio){ capEl.textContent = st.narration; capEl.style.display=''; }
        else { capEl.style.display='none'; }
        bPrev.disabled = (cur<=0); bNext.disabled = (cur>=N-1);
      }

      // Entra num passo: fotografa o estado atual (from) e carrega o alvo (to);
      // instant=true aplica de imediato (arranque no passo 0, sem tween).
      function beginTransition(i, instant){
        clearFree(); freeAudioDone = false;               // narração do ciclo toca 1x por entrada, não a cada volta
        cur = i<0?0 : i>=N?N-1 : i;
        const st = steps[cur], anim = st.animate || {};
        freeRun = st.freeRun || null;
        if(!freeRun) applyEntryProps(cur);                // reseta props ao estado determinístico de entrada do passo (conserta retroceder/reiniciar)
        animFrom = {}; animTo = {};
        animDur = ((anim.duration!=null?anim.duration : st.duration!=null?st.duration : 0.6)) * RM;
        for(const id in anim){
          if(id==='duration') continue; const n=byId[id]; if(!n) continue;
          const tgt=anim[id], f={}, tv={};
          for(const k in tgt){ f[k]=(n[k]!=null?n[k]:tgt[k]); tv[k]=tgt[k]; }
          animFrom[id]=f; animTo[id]=tv;
        }
        camFrom = { zoom:zoom, panX:panX, panY:panY, rot:rot };
        let _fit = null;
        if(spec.autoframe && !freeRun && st.fit!==false){
          let fids = [];                                            // enquadra o que ESTE passo revela/foca (não todo o visível cumulativo)
          if(st.reveal) fids.push(...st.reveal);
          if(st.focus)  fids.push(...st.focus);
          fids = fids.filter(idf => { const nf=byId[idf]; if(!nf) return false; const cf=registry[nf.type];   // conectores (x0/x1, sem centro) não guiam o enquadramento
            return !!(cf&&cf.pos) || (Number.isFinite(nf.x)&&Number.isFinite(nf.y)); });
          if(!fids.length) fids = [...visibleAt(cur)];
          _fit = fitCamera(fids);
        }
        if(_fit){ camTo = { zoom:_fit.zoom, panX:_fit.panX, panY:_fit.panY, rot:(st.camera&&st.camera.rot)||0 };
          camDur = ((st.camera&&st.camera.duration)!=null?st.camera.duration:0.6)*RM; }
        else if(st.camera){ const z=(st.camera.zoom!=null?st.camera.zoom:zoom);
          camTo = { zoom:z, panX:-(st.camera.cx||0)*z, panY:-(st.camera.cy||0)*z, rot:(st.camera.rot||0) };   // (cx,cy) world → centro; rot = ângulo da câmera
          camDur = (st.camera.duration!=null?st.camera.duration:0.5)*RM;
        } else { camTo = { zoom:zoom, panX:panX, panY:panY, rot:rot }; camDur = 0.001; }
        sigDur = (st.duration!=null?st.duration:0.5)*RM;
        for(const id in opCur) opFrom[id]=opCur[id];
        if(freeRun){ frFrames=(freeRun.frames||[]).map(fid=>{ const s=steps.find(x=>x.id===fid); return (s&&s.animate)||{}; }).filter(o=>Object.keys(o).length); frIdx=0; frDwell=(freeRun.dwell!=null?freeRun.dwell:0.6)*RM;
          for(const id in byId) opTarget[id]= freeRun.revealAll ? 1 : 0;          // ciclo: por padrão esconde tudo (o passo revela só o diagrama); revealAll=motor (nó único)
          if(byId.crank) byId.crank.speed=(freeRun.crankSpeed!=null?freeRun.crankSpeed:1.2);   // giro contínuo
          if(st.reveal) for(const id of st.reveal){ if(byId[id]!=null) opTarget[id]=1; }
          if(st.hide)   for(const id of st.hide){ if(byId[id]!=null) opTarget[id]=0; }
        } else {                                                                   // visibilidade DETERMINÍSTICA dos passos 0..cur (re-esconde o que passos posteriores revelaram)
          const vis=visibleAt(cur); for(const id in byId) opTarget[id]= vis.has(id)?1:0;
          if(!instant) registerEntries(cur);                                       // dispara o pop dos nós revelados neste passo
        }
        activeFocus = (!freeRun && st.focus && st.focus.length) ? new Set(st.focus) : null;
        dimFrom = dimAlpha; dimTarget = activeFocus ? 0.80 : 0;                     // inativos a ~20% visível (pesquisa: spotlight)
        annList = freeRun ? [] : (st.annotate || []);
        elapsed = 0; maxDur = Math.max(animDur, camDur, sigDur, 0.001);
        if(instant){ clearEntries(); elapsed=maxDur; transitioning=false; applyProgress(); commitProps(); annAlpha=1; }
        else { transitioning = true; }
        updateHUD();
      }

      function applyProgress(){
        const eA=easeOut(clamp01(animDur>0?elapsed/animDur:1));
        const eC=easeMove(clamp01(camDur >0?elapsed/camDur :1));   // câmera: ease-in-out (movimento de operador)
        const eS=easeEnter(clamp01(sigDur >0?elapsed/sigDur :1));  // reveal/dim: enter
        for(const id in animTo){ const n=byId[id]; if(!n) continue; const f=animFrom[id], tv=animTo[id];
          for(const k in tv){ const a=f[k], b=tv[k];
            if(typeof b==='number' && typeof a==='number') n[k]=a+(b-a)*eA;                          // numérico: lerp linear
            else if(typeof b==='string' && typeof a==='string' && a.charAt(0)==='#' && b.charAt(0)==='#') n[k]=hexLerp(a,b,eA);  // cor: lerp RGB
            else n[k]=(eA>=1?b:a); } }
        zoom=camFrom.zoom+(camTo.zoom-camFrom.zoom)*eC;
        panX=camFrom.panX+(camTo.panX-camFrom.panX)*eC;
        panY=camFrom.panY+(camTo.panY-camFrom.panY)*eC;
        rot =camFrom.rot +(camTo.rot -camFrom.rot )*eC;
        for(const id in opTarget){ const a=(opFrom[id]!=null?opFrom[id]:opTarget[id]); opCur[id]=a+(opTarget[id]-a)*eS; }
        dimAlpha=dimFrom+(dimTarget-dimFrom)*eS; annAlpha=eS;
      }
      function commitProps(){
        for(const id in animTo){ const n=byId[id]; if(!n) continue; const tv=animTo[id]; for(const k in tv) n[k]=tv[k]; }
        zoom=camTo.zoom; panX=camTo.panX; panY=camTo.panY; rot=camTo.rot;
        for(const id in opTarget) opCur[id]=opTarget[id];
        dimAlpha=dimTarget; annAlpha=1;
      }

      function tick(dt){
        uiClock += dt;                          // relógio de UI: avança SEMPRE (mesmo pausado) — pop de entrada nunca congela
        if(!transitioning) return;
        elapsed += dt;
        if(elapsed >= maxDur){ elapsed=maxDur; transitioning=false; applyProgress(); commitProps();
          if(freeRun){ clearFree(); if(explaining && !freeAudioDone){ playFree(); freeAudioDone=true; } freeTimer=setTimeout(freeStep, frDwell*1000); }
          else if(explaining) playThenAdvance();
        }
        else applyProgress();
      }
      // fluxo completo: percorre em loop os keyframes referenciados, sem dim/anotação/pausa
      function freeStep(){
        if(!freeRun || !frFrames.length) return;
        frIdx=(frIdx+1)%frFrames.length; const tgt=frFrames[frIdx];
        animFrom={}; animTo={}; animDur=(freeRun.tween!=null?freeRun.tween:0.5)*RM;
        for(const id in tgt){ if(id==='duration'||id==='crank') continue; const n=byId[id]; if(!n) continue;
          const f={}, tv={}; for(const k in tgt[id]){ f[k]=(n[k]!=null?n[k]:tgt[id][k]); tv[k]=tgt[id][k]; } animFrom[id]=f; animTo[id]=tv; }
        camFrom={ zoom:zoom, panX:panX, panY:panY, rot:rot }; camTo={ zoom:zoom, panX:panX, panY:panY, rot:rot }; camDur=0.001;
        for(const id in opCur) opFrom[id]=opCur[id];           // congela opacidade (só props animam no loop; evita re-fade/pisca dos nós escondidos)
        dimFrom=dimAlpha; dimTarget=dimAlpha;
        elapsed=0; maxDur=Math.max(animDur,0.001); transitioning=true;
      }

      // ---------- narração por passo / autoplay ----------
      function stopAudio(){ try{ au.pause(); }catch(e){} au.onended=null; if(advTimer){ clearTimeout(advTimer); advTimer=null; } }
      function playThenAdvance(){
        stopAudio();
        const advance = () => { if(!explaining) return; if(cur < N-1) go(cur+1); else stopExplain(); };
        const uri = A && A.steps && A.steps[cur];
        if(uri){ au.src=uri; au.onended=()=>{ au.onended=null; advance(); }; const p=au.play(); if(p&&p.catch) p.catch(()=>{ advTimer=setTimeout(advance,1300); }); }
        else { const s=(steps[cur].autoAdvance!=null?steps[cur].autoAdvance:2.4); advTimer=setTimeout(advance, Math.max(300, s*1000*(reduce?0.6:1))); }
      }
      function playFree(){ stopAudio(); const uri=A && A.steps && A.steps[cur]; if(uri){ au.src=uri; au.onended=null; const p=au.play(); if(p&&p.catch) p.catch(()=>{}); } }
      function startExplain(){ explaining=true; playing=true; { const pb=q('play'); if(pb) pb.textContent='⏸ Pausar'; } bExplain.textContent='⏹ Parar'; if(cur!==0) go(0); else playThenAdvance(); }
      function stopExplain(){ explaining=false; stopAudio(); bExplain.textContent=(A && A.steps)?'▶ Explicar':'▶ Reproduzir'; }
      function go(i){ stopAudio(); beginTransition(i, false); }               // interno (mantém o autoplay)
      function manualGo(i){ if(explaining) stopExplain(); go(i); }            // usuário (interrompe o autoplay)

      bPrev.onclick = () => manualGo(cur-1);
      bNext.onclick = () => manualGo(cur+1);
      bExplain.onclick = () => { if(explaining) stopExplain(); else startExplain(); };
      document.addEventListener('keydown', ev => {
        const tg=ev.target; if(tg && /INPUT|TEXTAREA|SELECT/.test(tg.tagName||'')) return;
        if(ev.key==='ArrowRight'){ ev.preventDefault(); manualGo(cur+1); }
        else if(ev.key==='ArrowLeft'){ ev.preventDefault(); manualGo(cur-1); }
      });

      // ---------- overlay: dim + re-desenho de foco + anotações ----------
      function nodeCenter(n){ const c=registry[n.type]; if(c && c.pos) return c.pos(n, env()); return [n.x||0, n.y||0]; }
      function drawAnnotations(){
        ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.globalAlpha=annAlpha; ctx.letterSpacing='0px';
        ctx.font='600 12.5px "Segoe UI",system-ui,sans-serif'; ctx.textBaseline='middle';
        const H=24, PADX=9, GAP=7, LEAD=16, cw=Math.cos(rot), sw=Math.sin(rot);
        const mL=12, mR=12, mT=48, mB=14;
        const items=[]; let BX0=1e9, BY0=1e9, BX1=-1e9, BY1=-1e9;               // bbox (tela) dos nós anotados = zona proibida
        for(const a of annList){
          let c=null, hw, hh; const n=byId[a.target];
          if(n){ c=nodeCenter(n); const cc=registry[n.type];
            if(cc && cc.bounds){ const b=cc.bounds(n, env());                     // usa a bbox real do componente (placas iso, cards grandes)
              hw=(b[2]-b[0])/2*zoom; hh=(b[3]-b[1])/2*zoom; c=[(b[0]+b[2])/2,(b[1]+b[3])/2]; }
            else if(n.type==='box'){ hw=(n.w||120)/2*zoom; hh=(n.h||50)/2*zoom; }
            else { hw=hh=(n.r||10)*zoom; }
          } else {                                                              // alvo pode nomear uma sub-peça (componente com parts())
            for(const nn of nodes){ const cc=registry[nn.type]; if(cc && cc.parts){ const P=cc.parts(nn, env()); if(P && P[a.target]){ c=P[a.target]; break; } } }
            hw=hh=12*zoom;
          }
          if(!c) continue;
          const sx=cx+panX+(c[0]*cw-c[1]*sw)*zoom, sy=cy+panY+(c[0]*sw+c[1]*cw)*zoom;   // world→screen (ciente da rotação)
          const text=a.text||''; const bw=ctx.measureText(text).width+PADX*2;
          items.push({ side:a.side, sx, sy, hw, hh, text, bw, col:a.color||'#8ab4ff' });
          BX0=Math.min(BX0,sx-hw); BX1=Math.max(BX1,sx+hw); BY0=Math.min(BY0,sy-hh); BY1=Math.max(BY1,sy+hh);
        }
        if(!items.length){ ctx.restore(); return; }
        const CXB=(BX0+BX1)/2, CYB=(BY0+BY1)/2, wide=(BX1-BX0)>=(BY1-BY0);
        for(const it of items){ let s=it.side;                                  // roteia: honra o autor; senão escolhe por forma/posição
          if(s!=='top'&&s!=='bottom'&&s!=='left'&&s!=='right') s = wide ? (it.sy<=CYB?'top':'bottom') : (it.sx<=CXB?'left':'right');
          it.side=s;
        }
        // TOP/BOTTOM: empilham em FILEIRAS acima/abaixo da bbox (rótulos nunca cobrem um nó)
        for(const side of ['top','bottom']){
          const list=items.filter(i=>i.side===side); if(!list.length) continue;
          list.sort((p,q)=>p.sx-q.sx); const rowEnd=[];
          for(const it of list){
            let bx=Math.max(mL, Math.min(cssW-mR-it.bw, it.sx-it.bw/2));
            let ri=0; while(ri<rowEnd.length && bx < rowEnd[ri]+GAP) ri++;      // 1ª fileira onde não colide horizontalmente
            if(ri===rowEnd.length) rowEnd.push(-1e9);
            rowEnd[ri]=bx+it.bw; it.bx=bx;
            it.by = side==='top' ? (BY0-LEAD-H-ri*(H+GAP)) : (BY1+LEAD+ri*(H+GAP));
            it.ax=it.sx; it.ay = side==='top' ? it.sy-it.hh : it.sy+it.hh;
            it.ex=Math.max(it.bx+8, Math.min(it.bx+it.bw-8, it.sx)); it.ey = side==='top' ? it.by+H : it.by;
          }
        }
        // LEFT/RIGHT: colunas fora da bbox, empilhadas pelo y do alvo
        for(const side of ['left','right']){
          const list=items.filter(i=>i.side===side); if(!list.length) continue;
          list.sort((p,q)=>p.sy-q.sy); let prevB=-1e9;
          for(const it of list){ let by=Math.round(it.sy-H/2); if(by<prevB+GAP) by=prevB+GAP; by=Math.max(mT,by); it.by=by; prevB=by+H; }
          const over=prevB-(cssH-mB); if(over>0){ let top=cssH-mB-H; for(let i=list.length-1;i>=0;i--){ if(list[i].by>top) list[i].by=top; top=list[i].by-GAP-H; } }
          for(const it of list){
            it.bx = side==='left' ? Math.max(mL, BX0-LEAD-it.bw) : Math.min(cssW-mR-it.bw, BX1+LEAD);
            it.ax = side==='left' ? it.sx-it.hw : it.sx+it.hw; it.ay=it.sy;
            it.ex = side==='left' ? it.bx+it.bw : it.bx; it.ey=it.by+H/2;
          }
        }
        for(const it of items){
          it.by=Math.max(mT, Math.min(cssH-mB-H, it.by)); if(it.ey==null) it.ey=it.by+H/2;   // clamp na tela
          ctx.beginPath(); ctx.moveTo(it.ax,it.ay);
          if(it.side==='left'||it.side==='right'){ const mx=(it.ax+it.ex)/2; ctx.bezierCurveTo(mx,it.ay,mx,it.ey,it.ex,it.ey); }
          else { const my=(it.ay+it.ey)/2; ctx.bezierCurveTo(it.ax,my,it.ex,my,it.ex,it.ey); }
          ctx.strokeStyle=it.col; ctx.lineWidth=1.6; ctx.stroke();
          ctx.beginPath(); ctx.arc(it.ax,it.ay,2.6,0,6.2832); ctx.fillStyle=it.col; ctx.fill();
          roundRectPath(ctx,it.bx,it.by,it.bw,H,7); ctx.fillStyle='rgba(12,17,28,.95)'; ctx.fill();
          roundRectPath(ctx,it.bx,it.by,it.bw,H,7); ctx.strokeStyle=it.col; ctx.lineWidth=1.2; ctx.stroke();
          ctx.fillStyle='#eef3ff'; ctx.textAlign='left'; ctx.fillText(it.text, it.bx+PADX, it.by+H/2);
        }
        ctx.restore();
      }
      function drawOverlay(e){
        if(dimAlpha>0.004 && activeFocus){
          ctx.save(); ctx.setTransform(1,0,0,1,0,0);                           // 1) escurece TUDO (device space)
          ctx.fillStyle='rgba(6,10,20,'+dimAlpha.toFixed(3)+')'; ctx.fillRect(0,0,cv.width,cv.height); ctx.restore();
          ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.translate(cx+panX, cy+panY); ctx.rotate(rot); ctx.scale(zoom,zoom);  // 2) re-desenha só o foco
          for(const n of nodes){ if(n.id==null || !activeFocus.has(n.id)) continue; const c=registry[n.type]; if(!(c&&c.draw)) continue;
            ctx.letterSpacing='0px'; const op=(opCur[n.id]!=null?opCur[n.id]:1);
            const hasCenter = !!c.pos || (Number.isFinite(n.x) && Number.isFinite(n.y));
            const sc = hasCenter ? entryScaleOf(n.id) : 1;
            ctx.save(); ctx.globalAlpha=op;
            if(sc!==1){ const ctr=(c.pos?c.pos(n,e):[n.x||0,n.y||0]); ctx.translate(ctr[0],ctr[1]); ctx.scale(sc,sc); ctx.translate(-ctr[0],-ctr[1]); }
            c.draw(ctx, n._inst, n, e, n===sel); ctx.restore(); }
          ctx.restore();
        }
        if(annList.length && annAlpha>0.02) drawAnnotations();                 // 3) anotações por cima
      }

      function reset(){ stopExplain(); beginTransition(0, true); }
      beginTransition(0, true);                                                // arranca no passo 0 (imediato)
      const idle = tt => { if(reduce) return {z:1,x:0,y:0,r:0}; return {
        z: 1 + 0.006*Math.sin(tt*0.5),
        x: 2.6*Math.sin(tt*0.31),
        y: 1.6*Math.cos(tt*0.27),
        r: 0.012*Math.sin(tt*0.22) }; };                          // deriva/ângulo sutil: dá vida de câmera
      return {
        opacityOf: n => (n.id!=null ? (opCur[n.id]!=null?opCur[n.id]:0) : 1),
        entryScaleOf: n => (n.id!=null ? entryScaleOf(n.id) : 1),
        focusSet: () => activeFocus,
        drawOverlay, tick, reset, idle,
        forward: () => manualGo(cur+1), back: () => manualGo(cur-1), jumpTo: manualGo
      };
    }
    if(spec.scenes && spec.scenes.length) step = mountStepEngine();
    draw();                                                     // primeiro paint imediato — não depende do 1º quadro do rAF (evita tela vazia)

    return { get selection(){ return sel; }, get time(){ return t; } };
  }

  // centro interpolado montado→explodido por `lift` (compartilhado por `layer` e `part`)
  function liftCenter(n){
    const lift = n.lift!=null ? Math.max(0,Math.min(1,n.lift)) : 0;
    const ax = n.asmX!=null?n.asmX:(n.x||0), ay = n.asmY!=null?n.asmY:(n.y||0);
    const ex = n.expX!=null?n.expX:(n.x||0), ey = n.expY!=null?n.expY:(n.y||0);
    return [ ax+(ex-ax)*lift, ay+(ey-ay)*lift ];
  }

  window.VXK = { register, mount, mat, color: { hex2rgb, shade, rgba, hexLerp }, liftCenter, version: '0.5.0' };
})();
