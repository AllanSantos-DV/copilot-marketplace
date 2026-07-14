// Painel de memória (canvas) — SERVER + snapshot, SEM dependência do SDK (testável em smoke/CI).
// A extensão registra o canvas com createCanvas() DENTRO do guard do host (onde o SDK já é importado
// dinamicamente); aqui só servimos o HTML + os endpoints JSON e compomos o snapshot lendo o daemon
// e a telemetria local. Cliente-puro: nunca sobe o servidor (exceto quando o usuário clica em
// "Provisionar", que delega a provision.ensureServer — o mesmo caminho consentido do memory_setup).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { discover } from "./daemon.mjs";
import { MemoryClient } from "./client.mjs";
import { tryResolveProjectId, projectIdStrength, isFragileScope } from "./projectId.mjs";
import { projectConfigPath, loadProjectConfig } from "./projectConfig.mjs";
import { consumptionLogPath } from "./consumption.mjs";
import { TYPE_ACTIVE, TYPE_CANDIDATE } from "./skill.mjs";

// id/instância FIXOS: o host é last-writer-wins, então a sessão MAIS RECENTE possui o canvas — que é
// exatamente a que o usuário está usando. Simples e alinhado ao mcp-bridge-dashboard.
export const DASHBOARD_CANVAS_ID = "copilot-memory-dashboard";
export const DASHBOARD_INSTANCE_ID = "copilot-memory-dashboard";
export const DASHBOARD_TITLE = "🧠 Memory";

const clampText = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// Telemetria de consumo (consumption.jsonl) → agregados escopados ao projeto. Best-effort: arquivo
// ausente/corrompido → zeros. Correlaciona ponteiros injetados (recall) com buscas de corpo (fetch).
function readTelemetry(projectId) {
    const out = { recalls: 0, pointersInjected: 0, fetches: 0, hitRate: null, lastRecallAt: null };
    let raw;
    try { raw = readFileSync(consumptionLogPath(), "utf8"); } catch { return out; }
    const injected = new Set();
    const fetched = new Set();
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (projectId && r.projectId && r.projectId !== projectId) continue; // escopa ao projeto aberto
        if (r.kind === "recall") {
            out.recalls++;
            const ids = Array.isArray(r.pointerIds) ? r.pointerIds : [];
            for (const id of ids) injected.add(id);
            if (r.ts && (!out.lastRecallAt || r.ts > out.lastRecallAt)) out.lastRecallAt = r.ts;
        } else if (r.kind === "fetch") {
            out.fetches++;
            if (r.id) fetched.add(r.id);
        }
    }
    out.pointersInjected = injected.size;
    if (injected.size) {
        let hit = 0;
        for (const id of injected) if (fetched.has(id)) hit++;
        out.hitRate = hit / injected.size;
    }
    return out;
}

export class MemoryDashboard {
    // cwdProvider: () => diretório de trabalho atual (o toolCwd() capturado dos hooks).
    // provisioner: async () => resultado (injeta provision.ensureServer sem acoplar o SDK aqui).
    constructor({ cwdProvider, provisioner } = {}) {
        this._cwd = typeof cwdProvider === "function" ? cwdProvider : () => process.cwd();
        this._provision = typeof provisioner === "function" ? provisioner : null;
        this._server = null;
        this._serverPromise = null;
        this.url = null;
    }

    // Snapshot completo do estado da memória para o projeto aberto. NUNCA lança (cada seção é isolada).
    async snapshot() {
        const workdir = this._cwd();
        const snap = {
            ts: new Date().toISOString(),
            daemon: { online: false, url: null, version: null, status: null },
            scope: { projectId: null, strength: "none", fragile: true, hasConfig: false, configPath: null, workdir },
            recent: [],
            skills: { active: [], candidate: [] },
            telemetry: { recalls: 0, pointersInjected: 0, fetches: 0, hitRate: null, lastRecallAt: null },
            canProvision: !!this._provision,
        };

        // Escopo (independe do daemon estar vivo).
        try {
            snap.scope.projectId = tryResolveProjectId(workdir);
            snap.scope.strength = projectIdStrength(workdir);
            snap.scope.fragile = isFragileScope(workdir);
            snap.scope.configPath = projectConfigPath(workdir);
            snap.scope.hasConfig = !!loadProjectConfig(workdir);
        } catch { /* mantém defaults */ }

        // Telemetria (local, independe do daemon).
        try { snap.telemetry = readTelemetry(snap.scope.projectId); } catch { /* zeros */ }

        // Daemon + dados escopados.
        let info = null;
        try { info = await discover(); } catch { info = null; }
        if (info) {
            snap.daemon.online = true;
            snap.daemon.url = info.url;
            snap.daemon.version = info.version ?? null;
            const client = new MemoryClient(info.url);
            try {
                const h = await client.health();
                snap.daemon.status = (h && h.status) || "ok";
                if (h && h.version && !snap.daemon.version) snap.daemon.version = h.version;
            } catch { snap.daemon.status = "sem resposta"; }

            const pid = snap.scope.projectId;
            if (pid) {
                try {
                    const r = await client.recent({ limit: 8, metadata: { project_id: pid } });
                    snap.recent = ((r && r.data) || []).map((d) => ({
                        id: d.id,
                        text: clampText(d.content, 160),
                        type: (d.metadata && d.metadata.type) || null,
                    }));
                } catch { /* lista vazia */ }
                for (const t of [TYPE_ACTIVE, TYPE_CANDIDATE]) {
                    try {
                        const r = await client.list({ limit: 20, metadata: { project_id: pid, type: t } });
                        const bucket = t === TYPE_ACTIVE ? snap.skills.active : snap.skills.candidate;
                        for (const d of (r && r.data) || []) {
                            bucket.push({
                                id: d.id,
                                name: (d.metadata && d.metadata.name) || "(sem nome)",
                                status: (d.metadata && d.metadata.status) || (t === TYPE_ACTIVE ? "active" : "candidate"),
                            });
                        }
                    } catch { /* tipo sem resultados */ }
                }
            }
        }
        return snap;
    }

    async search(query) {
        const q = String(query || "").trim();
        if (!q) return { results: [] };
        const workdir = this._cwd();
        const pid = tryResolveProjectId(workdir);
        let info = null;
        try { info = await discover(); } catch { info = null; }
        if (!info) return { error: "daemon offline" };
        try {
            const client = new MemoryClient(info.url);
            const r = await client.search(q, { topK: 6, metadata: pid ? { project_id: pid } : undefined });
            const results = ((r && r.results) || []).map((x) => ({
                id: x.documentId, score: x.score, text: clampText(x.text, 200),
            }));
            return { results };
        } catch (e) {
            return { error: String(e?.message || e) };
        }
    }

    async provision() {
        if (!this._provision) return { ok: false, reason: "provisionamento indisponível" };
        try { return await this._provision(); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
    }

    // Sobe (uma vez) o HTTP server local que serve o painel. Memoiza a promise em voo.
    async ensureServer() {
        if (this._server) return this.url;
        if (this._serverPromise) return this._serverPromise;
        this._serverPromise = new Promise((resolve, reject) => {
            const server = createServer(async (req, res) => {
                try { await this._route(req, res); }
                catch (e) { res.statusCode = 500; res.end(String(e?.message || e)); }
            });
            const onErr = (e) => { server.removeListener("listening", onOk); reject(e); };
            const onOk = () => {
                server.removeListener("error", onErr);
                this._server = server;
                this.url = `http://127.0.0.1:${server.address().port}/`;
                resolve(this.url);
            };
            server.once("error", onErr);
            server.listen(0, "127.0.0.1", onOk);
        }).catch((e) => { this._serverPromise = null; throw e; });
        return this._serverPromise;
    }

    async _route(req, res) {
        const u = new URL(req.url, "http://x");
        if (req.method === "GET" && u.pathname === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(PAGE_HTML);
            return;
        }
        if (req.method === "GET" && u.pathname === "/api/data") {
            const snap = await this.snapshot();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(snap));
            return;
        }
        if (req.method === "GET" && u.pathname === "/api/search") {
            const out = await this.search(u.searchParams.get("q") || "");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(out));
            return;
        }
        if (req.method === "POST" && u.pathname === "/api/setup") {
            const out = await this.provision();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(out));
            return;
        }
        res.statusCode = 404;
        res.end("not found");
    }
}

// ── Página (assinatura visual: a ESCADA DE ESCOPO — o resolver é literalmente uma escada) ──────────
// Paleta consistente com a vitrine do plugin: fundo grafite, coral = marca/comando, verde = saudável,
// âmbar = frágil/degradado, vermelho = offline. Tipografia mono-forward (memória = registros).
const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Memory</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#0b0f14; --panel:#12181f; --panel2:#0e141b; --line:#232c37; --line2:#2e3a48;
    --tx:#e6edf3; --mut:#8b98a9; --coral:#ff7b72; --mint:#3fb950; --amber:#d29922; --red:#f85149; --blue:#58a6ff;
    --mono:ui-monospace,"Cascadia Code","IBM Plex Mono","JetBrains Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:var(--bg);color:var(--tx);font-family:var(--mono);font-size:13px;line-height:1.5}
  .wrap{padding:14px 14px 40px;max-width:640px;margin:0 auto}
  header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .brand{font-weight:700;font-size:14px;letter-spacing:.3px}
  .brand b{color:var(--coral)}
  .pill{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--line2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  .pill.on{border-color:#1f5d33;color:var(--mint)} .pill.on .dot{background:var(--mint);box-shadow:0 0 8px #3fb95088}
  .pill.deg{border-color:#6b5316;color:var(--amber)} .pill.deg .dot{background:var(--amber)}
  .pill.off{border-color:#6e2b28;color:var(--red)} .pill.off .dot{background:var(--red)}
  .meta{color:var(--mut);font-size:11px;margin:-8px 0 16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 14px;margin-bottom:12px}
  .card h2{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--mut)}
  .pid{color:var(--coral);font-weight:600;word-break:break-all}
  /* escada de escopo */
  .ladder{display:flex;flex-direction:column;gap:1px;margin-top:4px}
  .rung{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:7px;border:1px solid transparent;color:var(--mut)}
  .rung .rk{width:74px;flex:0 0 auto;font-size:11px;letter-spacing:.4px;text-transform:uppercase}
  .rung .rd{font-size:11px;color:#6b7686}
  .rung.past{opacity:.45;text-decoration:line-through}
  .rung.active{background:var(--panel2);border-color:var(--line2);color:var(--tx)}
  .rung.active .rk{color:var(--coral)} .rung.active .rd{color:var(--mut)}
  .rung .mark{margin-left:auto;font-size:11px;color:var(--mint)}
  .warn{margin-top:10px;background:#1c1608;border:1px solid #5c4611;border-radius:9px;padding:10px 12px;color:#e8cf94;font-size:12px}
  .warn b{color:var(--amber)}
  details{margin-top:8px} summary{cursor:pointer;color:var(--blue);font-size:12px}
  pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:11px;color:#c9d4e0;margin:8px 0 0}
  /* telemetria */
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .stat{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:9px 10px;text-align:center}
  .stat .n{font-size:19px;font-weight:700;color:var(--tx)} .stat .l{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  .bar{height:6px;border-radius:4px;background:var(--panel2);border:1px solid var(--line);overflow:hidden;margin-top:10px}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--coral),var(--mint))}
  .hint{color:var(--mut);font-size:11px;margin-top:6px}
  /* listas */
  ul{list-style:none;margin:0;padding:0} li{padding:7px 0;border-top:1px solid var(--line);font-size:12px}
  li:first-child{border-top:0}
  .id{color:#6b7686;font-size:10px} .tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--line2);font-size:10px;color:var(--mut);margin-left:6px}
  .tag.active{color:var(--mint);border-color:#1f5d33} .tag.candidate{color:var(--amber);border-color:#6b5316}
  .empty{color:#6b7686;font-style:italic;font-size:12px}
  /* ações */
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px}
  button{cursor:pointer;font-family:var(--mono);font-size:12px;border-radius:8px;border:1px solid var(--line2);background:var(--panel2);color:var(--tx);padding:8px 12px;transition:.12s}
  button:hover{border-color:var(--coral);color:#fff}
  button.primary{background:#20301f;border-color:#2f5f2c;color:#c6f0c0} button.primary:hover{background:#274127}
  button:disabled{opacity:.5;cursor:default}
  input[type=text]{flex:1;min-width:140px;font-family:var(--mono);font-size:12px;border-radius:8px;border:1px solid var(--line2);background:#070b10;color:var(--tx);padding:8px 10px}
  input[type=text]:focus{outline:none;border-color:var(--blue)}
  .foot{display:flex;align-items:center;gap:10px;color:var(--mut);font-size:11px;margin-top:6px}
  .foot .spin{margin-left:auto}
  a{color:var(--blue)}
</style></head>
<body><div class="wrap">
  <header>
    <div class="brand">🧠 copilot-<b>memory</b></div>
    <div id="pill" class="pill"><span class="dot"></span><span id="pillt">…</span></div>
  </header>
  <div id="dmeta" class="meta">verificando o daemon…</div>
  <div id="app"><div class="card"><span class="empty">carregando…</span></div></div>
  <div class="foot">
    <button id="refresh">↻ Atualizar</button>
    <span id="setup"></span>
    <span class="spin" id="spin"></span>
  </div>
</div>
<script>
  const $=(id)=>document.getElementById(id);
  const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const RUNGS=[
    ['declared','.memory/project.json'],
    ['git-remote','origin normalizado'],
    ['git-base','repo base (worktrees)'],
    ['path','caminho absoluto'],
    ['name','nome da pasta'],
  ];
  const TEMPLATE=JSON.stringify({version:"1",project:{name:"<nome>",client:"<cliente|opcional>",team:"<time|opcional>"},metadata:{defaults:{project_id:"<owner>/<projeto>"},branches:{"feat/*":{type:"feature"},"fix/*":{type:"bugfix"},"main":{type:"production"}}},user:{identifyBy:"git-email"}},null,2);
  let busy=false;

  function ladder(strength){
    const order=RUNGS.map(r=>r[0]); const ai=order.indexOf(strength);
    return '<div class="ladder">'+RUNGS.map(([k,d],i)=>{
      let cls='rung'; if(ai>=0&&i<ai)cls+=' past'; if(k===strength)cls+=' active';
      const mark=(k===strength)?'<span class="mark">◀ resolve</span>':'';
      return '<div class="'+cls+'"><span class="rk">'+k+'</span><span class="rd">'+d+'</span>'+mark+'</div>';
    }).join('')+'</div>';
  }
  function pct(x){ return x==null?'—':Math.round(x*100)+'%'; }
  function when(ts){ if(!ts)return 'nunca'; try{const d=new Date(ts);const s=Math.round((Date.now()-d)/1000);
    if(s<60)return s+'s atrás'; if(s<3600)return Math.round(s/60)+'min atrás'; if(s<86400)return Math.round(s/3600)+'h atrás'; return Math.round(s/86400)+'d atrás';}catch{return ts;} }

  function setPill(s){
    const p=$('pill'),t=$('pillt');
    if(!s.daemon.online){p.className='pill off';t.textContent='offline';}
    else if(s.daemon.status&&/degrad/i.test(s.daemon.status)){p.className='pill deg';t.textContent='degradado';}
    else {p.className='pill on';t.textContent='online';}
    $('dmeta').innerHTML = s.daemon.online
      ? 'daemon '+esc(s.daemon.url)+(s.daemon.version?' · v'+esc(s.daemon.version):'')+(s.daemon.status?' · '+esc(s.daemon.status):'')
      : 'nenhum daemon vivo em ~/.mcp-memory/run';
    const su=$('setup');
    if(!s.daemon.online&&s.canProvision){ su.innerHTML='<button class="primary" id="prov">⬇ Provisionar servidor</button>';
      $('prov').onclick=doProvision; } else su.innerHTML='';
  }

  function scopeCard(s){
    const sc=s.scope;
    let h='<div class="card"><h2>Escopo do projeto</h2>';
    h+='<div class="pid">'+esc(sc.projectId||'(não resolvido)')+'</div>';
    h+=ladder(sc.strength);
    if(sc.fragile){
      h+='<div class="warn"><b>Escopo frágil.</b> Sem <code>.memory/project.json</code> nem git remote, a memória é escopada pelo CAMINHO — não casa entre máquinas. Peça ao agente: <code>memory_init_project</code>.';
      h+='<details><summary>modelo do project.json</summary><pre>'+esc(TEMPLATE)+'</pre></details></div>';
    } else if(sc.hasConfig){
      h+='<div class="hint">✓ escopo estável via '+esc(sc.configPath)+'</div>';
    } else {
      h+='<div class="hint">✓ escopo estável ('+esc(sc.strength)+')</div>';
    }
    return h+'</div>';
  }

  function teleCard(s){
    const t=s.telemetry;
    let h='<div class="card"><h2>Telemetria de recall</h2><div class="grid">';
    h+='<div class="stat"><div class="n">'+t.recalls+'</div><div class="l">recalls</div></div>';
    h+='<div class="stat"><div class="n">'+t.pointersInjected+'</div><div class="l">ponteiros</div></div>';
    h+='<div class="stat"><div class="n">'+t.fetches+'</div><div class="l">fetches</div></div>';
    h+='</div>';
    h+='<div class="bar"><i style="width:'+(t.hitRate==null?0:Math.round(t.hitRate*100))+'%"></i></div>';
    h+='<div class="hint">hit-rate ponteiro→fetch: <b>'+pct(t.hitRate)+'</b> · último recall '+when(t.lastRecallAt)+'</div>';
    return h+'</div>';
  }

  function docsCard(s){
    let h='<div class="card"><h2>Documentos recentes</h2>';
    if(!s.daemon.online){h+='<span class="empty">daemon offline</span></div>';return h;}
    if(!s.recent.length){h+='<span class="empty">sem documentos neste projeto</span></div>';return h;}
    h+='<ul>'+s.recent.map(d=>'<li>'+esc(d.text)+(d.type?'<span class="tag">'+esc(d.type)+'</span>':'')+'<div class="id">'+esc(d.id)+'</div></li>').join('')+'</ul>';
    return h+'</div>';
  }

  function skillsCard(s){
    const a=s.skills.active,c=s.skills.candidate;
    let h='<div class="card"><h2>Skills do projeto</h2>';
    if(!s.daemon.online){h+='<span class="empty">daemon offline</span></div>';return h;}
    if(!a.length&&!c.length){h+='<span class="empty">nenhuma skill destilada ainda</span></div>';return h;}
    const li=(x,k)=>'<li>'+esc(x.name)+'<span class="tag '+k+'">'+esc(x.status)+'</span><div class="id">'+esc(x.id)+'</div></li>';
    h+='<ul>'+a.map(x=>li(x,'active')).concat(c.map(x=>li(x,'candidate'))).join('')+'</ul>';
    return h+'</div>';
  }

  function searchCard(s){
    let h='<div class="card"><h2>Buscar na memória</h2><div class="row">';
    h+='<input type="text" id="q" placeholder="buscar no projeto…" autocomplete="off"'+(s.daemon.online?'':' disabled')+'/>';
    h+='<button id="go"'+(s.daemon.online?'':' disabled')+'>Buscar</button></div>';
    h+='<div id="results"></div></div>';
    return h;
  }

  function render(s){
    setPill(s);
    $('app').innerHTML = scopeCard(s)+teleCard(s)+searchCard(s)+docsCard(s)+skillsCard(s);
    const go=$('go'),q=$('q');
    if(go){ go.onclick=doSearch; }
    if(q){ q.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();}); }
  }

  async function load(){
    try{ const r=await fetch('/api/data'); const s=await r.json(); render(s); }
    catch(e){ $('app').innerHTML='<div class="card"><span class="empty">falha ao carregar: '+esc(e.message)+'</span></div>'; }
  }
  async function doSearch(){
    const q=$('q'); if(!q||!q.value.trim())return; const box=$('results');
    box.innerHTML='<div class="hint">buscando…</div>';
    try{
      const r=await fetch('/api/search?q='+encodeURIComponent(q.value.trim())); const j=await r.json();
      if(j.error){box.innerHTML='<div class="hint">'+esc(j.error)+'</div>';return;}
      if(!j.results||!j.results.length){box.innerHTML='<div class="empty">nada encontrado</div>';return;}
      box.innerHTML='<ul>'+j.results.map(x=>'<li>'+esc(x.text)+'<div class="id">'+esc(x.id)+' · score '+(x.score!=null?Number(x.score).toFixed(2):'—')+'</div></li>').join('')+'</ul>';
    }catch(e){ box.innerHTML='<div class="hint">erro: '+esc(e.message)+'</div>'; }
  }
  async function doProvision(){
    const b=$('prov'); if(!b||busy)return; busy=true; b.disabled=true; b.textContent='⏳ provisionando…';
    try{ await fetch('/api/setup',{method:'POST'}); }catch(e){}
    setTimeout(()=>{ busy=false; load(); }, 2500);
  }
  $('refresh').onclick=()=>load();
  load(); setInterval(()=>{ if(!busy) load(); }, 5000);
</script>
</body></html>`;
