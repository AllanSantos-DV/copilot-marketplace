// Dashboard server + snapshot/config UI, without an SDK dependency.
// (o createCanvas fica no guard do host, em extension.mjs). Serve `/` (PAGE_HTML) e `/data` (snapshot JSON).
// Reuses the same tree-aware decision core and kill guards as the automatic hook.
// Segurança: bind 127.0.0.1; página busca /data e renderiza com textContent (nunca innerHTML de dados) → anti-XSS.
// Ciclo de vida: porta persistida (sobrevive a reload) + close() que destrói sockets (padrão modo-auto, evita porta presa).
// v0.7: o scan sai do caminho do request — `Sampler` (lib/sampler.mjs) é o SINGLETON que faz o scan em
// segundo plano com coalescing (nunca 2 scans em voo); `/data` só lê o último snapshot (síncrono, <=100ms
// a quente). A telemetria usa `TelemetryStore` (lib/telemetry-store.mjs), tail incremental do NDJSON.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCopilotHome } from "./home.mjs";
import { unloadIdle } from "./unload.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { logLine } from "./log.mjs";
import { Sampler } from "./sampler.mjs";
import { TelemetryStore } from "./telemetry-store.mjs";

export { CANVAS_ID, CANVAS_INSTANCE, CANVAS_TITLE } from "./canvas-meta.mjs";

const stateDir = (home) => join(home, "session-state");
const portFile = (home) => join(stateDir(home), ".unloader-dashboard-port.json");
const metaFile = (home) => join(stateDir(home), ".unloader-meta.json");
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function readPreferredPort(home) {
  try { const o = JSON.parse(readFileSync(portFile(home), "utf8")); const p = Number(o.port); return (p > 1024 && p < 65536) ? p : null; } catch { return null; }
}
function writePreferredPort(home, port) {
  try { mkdirSync(stateDir(home), { recursive: true }); writeFileSync(portFile(home), JSON.stringify({ port })); } catch { /* best-effort */ }
}
function readLastScan(home) { try { return JSON.parse(readFileSync(metaFile(home), "utf8")).lastScan || null; } catch { return null; } }
function sessionName(home, sid) {
  try { const m = /^name:\s*(.+)$/m.exec(readFileSync(join(stateDir(home), sid, "workspace.yaml"), "utf8")); return m ? m[1].trim() : sid.slice(0, 8); }
  catch { return sid.slice(0, 8); }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) {
      const error = new Error(`corpo excede ${maxBytes} bytes`);
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
  }
  if (!raw.trim()) throw new Error("corpo JSON obrigatório");
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`JSON inválido: ${error?.message || error}`); }
}

export class Dashboard {
  constructor({
    home = resolveCopilotHome(),
    token = null,
    port = 0,
    version = "0.0.0-dev",
    startTime = Date.now(),
    sampler = null,
    telemetryStore = null,
  } = {}) {
    this.home = home;
    this.token = token; // setado no DAEMON → exige ?token=; o fallback in-process fica sem (loopback local)
    this.port = port;   // porta FIXA (daemon = arbiter) ou 0 (fallback = efêmera)
    this.version = version;
    this.startTime = startTime;
    this.url = null;
    this._server = null;
    this._sockets = new Set();
    this.sampler = sampler || new Sampler({ home, sessionNameFn: (sid) => sessionName(this.home, sid) });
    this.telemetryStore = telemetryStore || new TelemetryStore({ home });
  }

  async ensureServer() {
    if (this._server) return this.url;
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this._handle(req, res).catch((e) => { res.statusCode = 500; res.setHeader("Connection", "close"); res.end(String(e?.message || e)); });
      });
      server.on("connection", (s) => { this._sockets.add(s); s.on("close", () => this._sockets.delete(s)); });
      const preferred = this.port || readPreferredPort(this.home) || 0;
      const onOk = () => {
        const p = server.address().port;
        this.url = `http://127.0.0.1:${p}/`;
        this._server = server;
        if (!this.port) writePreferredPort(this.home, p);
        server.removeListener("error", onErr);
        resolve(this.url);
      };
      const onErr = (e) => {
        // porta FIXA (daemon) ocupada → outro daemon já venceu o arbiter: REJEITA (não cai pra efêmera).
        // porta preferida (fallback) ocupada → efêmera.
        if (e && e.code === "EADDRINUSE" && !this.port && preferred) { server.listen(0, "127.0.0.1", onOk); }
        else { reject(e); }
      };
      server.once("error", onErr);
      server.listen(preferred, "127.0.0.1", onOk);
    });
  }

  async _handle(req, res) {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const tk = req.headers["x-token"] || u.searchParams.get("token"); // POST usa header X-Token; GET usa query
    if (this.token && tk !== this.token) { // gate só no daemon (token setado) — protege TODO endpoint, inclusive /health
      res.statusCode = 403; res.setHeader("Connection", "close"); res.end("forbidden"); return;
    }
    if (req.method === "POST" && u.pathname.startsWith("/action/")) { return this._handleAction(u, req, res); }
    if (u.pathname === "/health") {
      // raso e instantâneo por design: nunca dispara scan (só reporta metadados do processo do daemon).
      res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        version: this.version,
        startTime: new Date(this.startTime).toISOString(),
        uptimeMs: Date.now() - this.startTime,
        state: this.sampler.isScanning() ? "scanning" : "ready",
      }));
      return;
    }
    if (u.pathname === "/data") {
      const callerPid = Number(u.searchParams.get("callerPid")) || null;
      res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
      res.end(JSON.stringify(this._snapshot(callerPid)));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Connection", "close");
      res.end(PAGE_HTML);
      return;
    }
    res.statusCode = 404; res.setHeader("Connection", "close"); res.end("not found");
  }

  // Ações do painel (POST + token). callerPid vem da query (nunca do body) → protege quem clicou.
  // callerPid só ADICIONA proteção (some ao conjunto de ancestrais protegidos); nunca AUTORIZA um kill —
  // ausência ou forja de callerPid nunca enfraquece as guardas (elas rodam do mesmo jeito com callerPid:null).
  async _handleAction(u, req, res) {
    const json = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(JSON.stringify(obj)); };
    const action = u.pathname.slice("/action/".length);
    const callerPid = Number(u.searchParams.get("callerPid")) || null;

    if (action === "rescan") {
      await this.sampler.nudge(readConfig({ home: this.home }), callerPid);
      return json(200, { ok: true, live: this._live(callerPid) });
    }

    if (action === "toggle") {
      const next = writeConfig({ enabled: !readConfig({ home: this.home }).enabled }, { home: this.home });
      logLine({ action: "toggle", enabled: next.enabled });
      return json(200, { ok: true, enabled: next.enabled });
    }

    if (action === "config") {
      let patch;
      try { patch = await readJsonBody(req); }
      catch (error) { return json(error?.code === "REQUEST_TOO_LARGE" ? 413 : 400, { error: String(error?.message || error) }); }
      try {
        const next = writeConfig(patch, { home: this.home });
        logLine({
          action: "config",
          idleTimeoutMs: next.idleTimeoutMs,
          activeCpuRatio: next.activeCpuRatio,
          minSampleMs: next.minSampleMs,
          allowlist: next.allowlist,
        });
        return json(200, { ok: true, config: next });
      } catch (error) {
        if (error?.code === "INVALID_UNLOADER_CONFIG") return json(400, { error: String(error.message) });
        throw error;
      }
    }

    if (action === "unload") {
      const sessionIdRaw = u.searchParams.get("sessionId");
      if (sessionIdRaw && !SESSION_ID_RE.test(sessionIdRaw)) {
        return json(400, { error: "sessionId inválido" });
      }
      if (this._unloading) return json(409, { error: "descarga já em execução" }); // mutex anti-double-click
      this._unloading = true;
      try {
        const dryRun = u.searchParams.get("dryRun") !== "0"; // dry-run é o padrão seguro
        // guardas + callerPid protegem; callerPid nunca AUTORIZA — só reforça auto-preservação.
        const r = await unloadIdle({ home: this.home, dryRun, sessionId: sessionIdRaw || null, callerPid });
        logLine({ action: dryRun ? "panel-dryrun" : "panel-unload", killed: r.killed?.length || 0, candidates: r.candidates?.length || 0, skipped: r.skipped?.length || 0 });
        await this.sampler.nudge(readConfig({ home: this.home }), callerPid); // estado mudou → força um scan novo
        return json(200, r);
      } catch (e) { return json(500, { error: String(e?.message || e) }); }
      finally { this._unloading = false; }
    }
    return json(404, { error: "ação desconhecida" });
  }

  // Leitura SÍNCRONA e imediata — nunca bloqueia em scan. O sampler nudge-a a si mesmo quando stale.
  _snapshot(callerPid = null) {
    const config = readConfig({ home: this.home });
    const freshness = this.sampler.snapshot(config, callerPid);
    const telemetry = this.telemetryStore.read();
    if (freshness.data?.counts) telemetry.live = freshness.data.counts;
    const status = {
      active: true,
      enabled: config.enabled,
      config,
      lastScan: readLastScan(this.home),
      loadedNow: freshness.data ? freshness.data.sessions.length : null,
      generatedAt: new Date().toISOString(),
      daemonVersion: this.version,
      daemonUptimeMs: Date.now() - this.startTime,
    };
    return {
      status,
      freshness,
      telemetry,
      live: {
        sessions: freshness.data ? freshness.data.sessions : [],
        cachedAt: freshness.cachedAt,
        error: freshness.lastError,
      },
    };
  }

  _live(callerPid = null) {
    return this._snapshot(callerPid).live;
  }

  close() {
    try { for (const s of this._sockets) { try { s.destroy(); } catch { /* ignore */ } } this._sockets.clear(); } catch { /* ignore */ }
    try { this._server?.close(); } catch { /* ignore */ }
    this._server = null; this.url = null;
  }
}


const PAGE_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Unloader</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--coral:#ff7b72;--aqua:#39d0c4;--red:#f85149;--grn:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:20px}
h1{font-size:20px;margin:0 0 2px;display:flex;align-items:center;gap:8px}
.sub{color:var(--mut);font-size:12px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:14px}
.card .n{font-size:26px;font-weight:700}
.card.aqua .n{color:var(--aqua)} .card.coral .n{color:var(--coral)}
.card .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:22px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--bd);font-size:13px}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase}
tr:last-child td{border-bottom:none}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--grn)}
.empty{color:var(--mut);padding:14px;text-align:center}
.foot{color:var(--mut);font-size:11px;margin-top:18px;text-align:center}
.actions{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.btn{background:var(--panel);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px}
.btn:hover{border-color:var(--aqua)} .btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:var(--coral);border-color:var(--coral);color:#0d1117;font-weight:600}
.switch{display:flex;align-items:center;gap:6px;margin-left:auto;color:var(--mut);cursor:pointer;user-select:none}
.warn-banner{background:rgba(248,81,73,.15);border:1px solid var(--red);color:var(--red);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.result{font-size:13px;color:var(--mut);margin-bottom:14px;white-space:pre-wrap;min-height:18px}
.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:18px}
.field{display:flex;flex-direction:column;gap:5px;color:var(--mut);font-size:12px}.field.wide{grid-column:1/-1}
.field input,.field textarea{width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:7px;color:var(--fg);padding:8px;font:13px ui-monospace,monospace}
.field textarea{min-height:74px;resize:vertical}.hint{color:var(--mut);font-size:11px}.settings-actions{display:flex;align-items:end}
</style></head>
<body><div class="wrap">
<h1>🧹 Session Unloader <span id="live" class="dot"></span></h1>
<div class="sub" id="status">carregando…</div>
<div class="sub" id="freshness">—</div>
<div id="banner" class="warn-banner" style="display:none">⚠️ Modo automático DESLIGADO — sessões ociosas não são descarregadas sozinhas.</div>
<div class="actions">
<button id="btn-unload" class="btn primary">Descarregar ociosas agora</button>
<button id="btn-rescan" class="btn">Reescanear</button>
<label class="switch"><input type="checkbox" id="toggle"> Automático</label>
</div>
<div id="action-result" class="result"></div>
<h2>Política de segurança</h2>
<div class="settings">
  <label class="field">Inatividade contínua (min)<input id="idle-timeout" type="number" min="15" max="1440" step="5"></label>
  <label class="field">Razão mínima de CPU<input id="active-ratio" type="number" min="0.000001" max="0.25" step="0.000001"></label>
  <label class="field">Janela mínima de amostra (s)<input id="sample-floor" type="number" min="5" max="300" step="5"></label>
  <div class="settings-actions"><button id="btn-save-config" class="btn">Salvar política</button></div>
  <label class="field wide">Allowlist adicional (uma entrada literal por linha)<textarea id="allowlist" spellcheck="false"></textarea>
    <span class="hint">Proteções obrigatórias: <span id="required-allowlist"></span>. Entradas genéricas como node, copilot e .exe são rejeitadas.</span>
  </label>
</div>
<div class="cards" id="cards"></div>
<h2>Estado ao vivo (snapshot atual)</h2>
<div class="cards" id="cards-live"></div>
<h2>Sessões carregadas agora</h2>
<table><thead><tr><th></th><th>Sessão</th><th>Ocioso</th><th>RAM</th><th>Situação</th></tr></thead><tbody id="live-tb"><tr><td class="empty" colspan="5">escaneando…</td></tr></tbody></table>
<h2>Últimas descargas</h2>
<table><thead><tr><th>Quando</th><th>Sessão</th><th>RAM liberada</th></tr></thead><tbody id="hist-tb"><tr><td class="empty" colspan="3">—</td></tr></tbody></table>
<div class="foot" id="foot"></div>
</div>
<script>
function el(tag,txt){var e=document.createElement(tag);if(txt!=null)e.textContent=txt;return e;}
function fmtTime(iso){if(!iso)return "—";try{return new Date(iso).toLocaleString("pt-BR");}catch(e){return "—";}}
function card(label,value,cls){var d=el("div");d.className="card"+(cls?(" "+cls):"");var n=el("div",value);n.className="n";var l=el("div",label);l.className="l";d.appendChild(n);d.appendChild(l);return d;}
function fmtDur(ms){if(ms==null)return "—";if(ms<1000)return Math.round(ms)+"ms";var s=ms/1000;if(s<60)return s.toFixed(1)+"s";var m=Math.floor(s/60);return m+"min"+Math.round(s%60)+"s";}
function fmtAge(ms){if(ms==null)return "—";return fmtDur(ms)+" atrás";}
function stateLabel(st){return {fresh:"🟢 atualizado",scanning:"🔄 escaneando…",stale:"🟡 desatualizando",error:"🔴 erro"}[st]||st||"—";}
var configInitialized=false;
function render(d){
  var s=d.status||{},t=d.telemetry||{},live=d.live||{},fr=d.freshness||{};
  document.getElementById("status").textContent="Ativo · última varredura: "+fmtTime(s.lastScan)+" · "+(s.loadedNow!=null?s.loadedNow:"?")+" sessão(ões) carregada(s)";
  document.getElementById("freshness").textContent=
    stateLabel(fr.state)+" · snapshot há "+fmtAge(fr.age)+" · scan levou "+fmtDur(fr.durationMs)+
    " · daemon no ar há "+fmtDur(s.daemonUptimeMs)+" (v"+(s.daemonVersion||"?")+")"+
    (fr.lastError?(" · ⚠️ "+fr.lastError):"");
  var enabled=s.enabled!==false;
  document.getElementById("banner").style.display=enabled?"none":"block";
  document.getElementById("toggle").checked=enabled;
  var cfg=s.config||{};
  if(!configInitialized){
    document.getElementById("idle-timeout").value=cfg.idleTimeoutMs?String(cfg.idleTimeoutMs/60000):"";
    document.getElementById("active-ratio").value=cfg.activeCpuRatio!=null?String(cfg.activeCpuRatio):"";
    document.getElementById("sample-floor").value=cfg.minSampleMs?String(cfg.minSampleMs/1000):"";
    document.getElementById("allowlist").value=(cfg.allowlist||[]).join("\\n");
    document.getElementById("required-allowlist").textContent=(cfg.effectiveAllowlist||[]).filter(function(x){return !(cfg.allowlist||[]).includes(x);}).join(", ");
    configInitialized=true;
  }
  if(cfg.configError&&!document.getElementById("action-result").textContent)document.getElementById("action-result").textContent="Configuração inválida; automático mantido desligado: "+cfg.configError;
  var cards=document.getElementById("cards");cards.textContent="";
  cards.appendChild(card("descarregadas (total)",String(t.totalKilled||0),"aqua"));
  cards.appendChild(card("descarregadas hoje",String(t.killedToday||0),"aqua"));
  cards.appendChild(card("RAM liberada (MB)",String(t.ramFreedMb||0),"coral"));
  cards.appendChild(card("preservadas por guarda",String(t.totalSkipped||0)));
  cards.appendChild(card("scans (daemon)",String(t.totalScans||0)));
  cards.appendChild(card("falhas de scan/kill",String((t.totalScanFails||0)+(t.totalKillFails||0))));
  var lc=t.live||{};
  var cardsLive=document.getElementById("cards-live");cardsLive.textContent="";
  cardsLive.appendChild(card("carregadas agora",String(lc.loaded!=null?lc.loaded:"—")));
  cardsLive.appendChild(card("ativas",String(lc.active!=null?lc.active:"—"),"aqua"));
  cardsLive.appendChild(card("protegidas agora",String(lc.protectedCount!=null?lc.protectedCount:"—")));
  cardsLive.appendChild(card("candidatas agora",String(lc.candidates!=null?lc.candidates:"—"),"coral"));
  cardsLive.appendChild(card("RAM carregada (MB)",String(lc.ramLoadedMb!=null?lc.ramLoadedMb:"—")));
  cardsLive.appendChild(card("RAM liberável (MB)",String(lc.ramReleasableMb!=null?lc.ramReleasableMb:"—"),"coral"));
  var tb=document.getElementById("live-tb");tb.textContent="";
  var sess=(live&&live.sessions)||[];
  if(!sess.length){var tr=el("tr");var td=el("td",live&&live.error?("erro: "+live.error):"nenhuma sessão carregada");td.className="empty";td.colSpan=5;tr.appendChild(td);tb.appendChild(tr);}
  else sess.forEach(function(x){var tr=el("tr");tr.appendChild(el("td",x.icon||""));var nm=el("td",x.name||"?");tr.appendChild(nm);tr.appendChild(el("td",x.idleMin!=null?(x.idleMin+" min"):"—"));var rm=el("td",x.wsMb!=null?(x.wsMb+" MB"):"—");rm.className="mono";tr.appendChild(rm);tr.appendChild(el("td",x.verdict||""));tb.appendChild(tr);});
  var ht=document.getElementById("hist-tb");ht.textContent="";
  var rk=t.recentKills||[];
  if(!rk.length){var tr2=el("tr");var td2=el("td","nenhuma descarga registrada ainda");td2.className="empty";td2.colSpan=3;tr2.appendChild(td2);ht.appendChild(tr2);}
  else rk.forEach(function(k){var tr=el("tr");tr.appendChild(el("td",fmtTime(k.ts)));tr.appendChild(el("td",k.sessionId?String(k.sessionId).slice(0,8):"?"));var rm=el("td",(k.wsMb||0)+" MB");rm.className="mono";tr.appendChild(rm);ht.appendChild(tr);});
  document.getElementById("foot").textContent="atualizado "+fmtTime(s.generatedAt)+" · dados: "+((live&&live.cachedAt)?("scan "+fmtTime(live.cachedAt)):"");
}
function tick(){fetch("/data"+window.location.search).then(function(r){return r.json();}).then(render).catch(function(){document.getElementById("live").style.background="var(--red)";});}
var Q=window.location.search;var TOKEN=new URLSearchParams(Q).get("token")||"";
function postAction(path,body){var u=new URL(path,window.location.origin);new URLSearchParams(Q).forEach(function(v,k){u.searchParams.set(k,v);});var opts={method:"POST",headers:{"X-Token":TOKEN}};if(body!==undefined){opts.headers["Content-Type"]="application/json";opts.body=JSON.stringify(body);}return fetch(u.pathname+u.search,opts).then(function(r){return r.json().then(function(j){return{status:r.status,j:j};});});}
function setResult(t){document.getElementById("action-result").textContent=t;}
document.getElementById("btn-unload").addEventListener("click",function(){var b=this;b.disabled=true;setResult("verificando candidatas…");postAction("/action/unload?dryRun=1").then(function(o){var c=(o.j.candidates||[]);if(!c.length){setResult("Nenhuma sessão ociosa para descarregar agora.");b.disabled=false;return;}var names=c.map(function(x){return x.sessionId?String(x.sessionId).slice(0,8):x.pid;}).join(", ");if(!confirm("Descarregar "+c.length+" sessao(oes) ociosa(s)?\\n"+names+"\\n\\nO estado pode mudar entre a previa e a execucao; as guardas sao reavaliadas no kill.")){b.disabled=false;setResult("");return;}setResult("descarregando…");postAction("/action/unload").then(function(o2){var k=(o2.j.killed||[]).length,sk=(o2.j.skipped||[]).length;setResult("Descarregadas "+k+" | preservadas por guarda "+sk+".");b.disabled=false;tick();});}).catch(function(){setResult("erro na acao.");b.disabled=false;});});
document.getElementById("btn-rescan").addEventListener("click",function(){var b=this;b.disabled=true;setResult("reescaneando…");postAction("/action/rescan").then(function(){setResult("");b.disabled=false;tick();});});
document.getElementById("toggle").addEventListener("change",function(){postAction("/action/toggle").then(function(o){setResult(o.j.enabled?"Automatico LIGADO.":"Automatico DESLIGADO.");tick();});});
document.getElementById("btn-save-config").addEventListener("click",function(){var b=this;b.disabled=true;var allow=document.getElementById("allowlist").value.split(/\\r?\\n/).map(function(x){return x.trim();}).filter(Boolean);var patch={idleTimeoutMs:Number(document.getElementById("idle-timeout").value)*60000,activeCpuRatio:Number(document.getElementById("active-ratio").value),minSampleMs:Number(document.getElementById("sample-floor").value)*1000,allowlist:allow};setResult("salvando política…");postAction("/action/config",patch).then(function(o){if(o.status!==200){setResult(o.j.error||"Falha ao salvar configuração.");b.disabled=false;return;}configInitialized=false;setResult("Política salva. O automático continua no estado escolhido acima.");b.disabled=false;tick();}).catch(function(e){setResult("Falha ao salvar configuração: "+String(e&&e.message||e));b.disabled=false;});});
tick();setInterval(tick,10000);
</script></body></html>`;
