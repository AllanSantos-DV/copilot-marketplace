// dashboard.mjs — painel canvas READ-ONLY do session-unloader. SERVER + snapshot, SEM dependência do SDK
// (o createCanvas fica no guard do host, em extension.mjs). Serve `/` (PAGE_HTML) e `/data` (snapshot JSON).
// Reúso: scan/isIdle/guardKill (bloco AO VIVO), telemetry (do log), .unloader-meta.json (status).
// Segurança: bind 127.0.0.1; página busca /data e renderiza com textContent (nunca innerHTML de dados) → anti-XSS.
// Ciclo de vida: porta persistida (sobrevive a reload) + close() que destrói sockets (padrão modo-auto, evita porta presa).
// Custo: o scan ao vivo (spawn PowerShell) é guardado por cache TTL de 30s; o front atualiza a cada 10s → ≤2 scans/min.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCopilotHome } from "./home.mjs";
import { scanServers } from "./scan.mjs";
import { getProcMap } from "./procmap.mjs";
import { ancestorsOf, guardKill } from "./guards.mjs";
import { readSnapshot, isIdle } from "./snapshot.mjs";
import { parseTelemetry } from "./telemetry.mjs";
import { pidAlive } from "./process-utils.mjs";

export const CANVAS_ID = "session-unloader-panel";
export const CANVAS_INSTANCE = "session-unloader-panel";
export const CANVAS_TITLE = "🧹 Session Unloader";

const SCAN_TTL_MS = 30000;

const stateDir = (home) => join(home, "session-state");
const portFile = (home) => join(stateDir(home), ".unloader-dashboard-port.json");
const logFile = (home) => join(home, "logs", "unloader.log");
const metaFile = (home) => join(stateDir(home), ".unloader-meta.json");

function readPreferredPort(home) {
  try { const o = JSON.parse(readFileSync(portFile(home), "utf8")); const p = Number(o.port); return (p > 1024 && p < 65536) ? p : null; } catch { return null; }
}
function writePreferredPort(home, port) {
  try { mkdirSync(stateDir(home), { recursive: true }); writeFileSync(portFile(home), JSON.stringify({ port })); } catch { /* best-effort */ }
}
function readLogLines(home) { try { return readFileSync(logFile(home), "utf8").split(/\r?\n/); } catch { return []; } }
function readLastScan(home) { try { return JSON.parse(readFileSync(metaFile(home), "utf8")).lastScan || null; } catch { return null; } }
function sessionName(home, sid) {
  try { const m = /^name:\s*(.+)$/m.exec(readFileSync(join(stateDir(home), sid, "workspace.yaml"), "utf8")); return m ? m[1].trim() : sid.slice(0, 8); }
  catch { return sid.slice(0, 8); }
}

export class Dashboard {
  constructor({ home = resolveCopilotHome(), token = null, port = 0 } = {}) {
    this.home = home;
    this.token = token; // setado no DAEMON → exige ?token=; o fallback in-process fica sem (loopback local)
    this.port = port;   // porta FIXA (daemon = arbiter) ou 0 (fallback = efêmera)
    this.url = null;
    this._server = null;
    this._sockets = new Set();
    this._scanCache = null; // { data:{servers,procMap,at,error}, ts }
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
    if (this.token && u.searchParams.get("token") !== this.token) { // gate só no daemon (token setado)
      res.statusCode = 403; res.setHeader("Connection", "close"); res.end("forbidden"); return;
    }
    if (u.pathname === "/health") { res.setHeader("Connection", "close"); res.end("ok"); return; }
    if (u.pathname === "/data") {
      const callerPid = Number(u.searchParams.get("callerPid")) || null;
      res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
      res.end(JSON.stringify(await this._snapshot(callerPid)));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Connection", "close");
      res.end(PAGE_HTML);
      return;
    }
    res.statusCode = 404; res.setHeader("Connection", "close"); res.end("not found");
  }

  async _snapshot(callerPid = null) {
    const live = await this._live(callerPid);
    const status = {
      active: true,
      lastScan: readLastScan(this.home),
      loadedNow: live && Array.isArray(live.sessions) ? live.sessions.length : null,
      generatedAt: new Date().toISOString(),
    };
    return { status, telemetry: parseTelemetry(readLogLines(this.home)), live };
  }

  async _live(callerPid = null) {
    const now = Date.now();
    // cache guarda o SCAN BRUTO (caro); a marcação por callerPid é aplicada por request (barato).
    let raw = this._scanCache && (now - this._scanCache.ts) < SCAN_TTL_MS ? this._scanCache.data : null;
    if (!raw) {
      try { raw = { servers: await scanServers({ home: this.home }), procMap: await getProcMap(), at: now }; }
      catch (e) { raw = { servers: [], procMap: new Map(), error: String(e?.message || e), at: now }; }
      this._scanCache = { data: raw, ts: now };
    }
    const selfPid = process.pid;
    const selfAncestors = ancestorsOf(selfPid, raw.procMap);
    const callerAncestors = callerPid ? ancestorsOf(callerPid, raw.procMap) : new Set();
    const protectedPids = new Set([...selfAncestors, ...callerAncestors, selfPid]);
    if (callerPid) protectedPids.add(callerPid);
    const sessions = raw.servers.map((s) => {
      const idle = isIdle(s, s.sessionId ? readSnapshot(s.sessionId, { home: this.home }) : null, now);
      let verdict, icon;
      if (!s.sessionId) { verdict = "casca (sem sessão)"; icon = "⚪"; }
      else if (callerPid && callerAncestors.has(s.pid)) { verdict = "esta sessão"; icon = "🟢"; }
      else if (!idle) { verdict = "ativa"; icon = "🟢"; }
      else {
        const g = guardKill(s, { selfPid, selfAncestors: protectedPids, procMap: raw.procMap, pidAlive });
        if (g.ok) { verdict = "candidata"; icon = "🔴"; }
        else { verdict = "protegida (" + g.reason + ")"; icon = "🔒"; }
      }
      return {
        pid: s.pid,
        name: s.sessionId ? sessionName(this.home, s.sessionId) : "(servidor sem sessão)",
        idleMin: s.eventsMtimeMs ? Math.round((now - s.eventsMtimeMs) / 60000) : null,
        wsMb: s.wsMb == null ? null : Number(s.wsMb),
        verdict, icon,
      };
    });
    return { sessions, cachedAt: new Date(raw.at).toISOString(), error: raw.error };
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
</style></head>
<body><div class="wrap">
<h1>🧹 Session Unloader <span id="live" class="dot"></span></h1>
<div class="sub" id="status">carregando…</div>
<div class="cards" id="cards"></div>
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
function render(d){
  var s=d.status||{},t=d.telemetry||{},live=d.live||{};
  document.getElementById("status").textContent="Ativo · última varredura: "+fmtTime(s.lastScan)+" · "+(s.loadedNow!=null?s.loadedNow:"?")+" sessão(ões) carregada(s)";
  var cards=document.getElementById("cards");cards.textContent="";
  cards.appendChild(card("descarregadas (total)",String(t.totalKilled||0),"aqua"));
  cards.appendChild(card("descarregadas hoje",String(t.killedToday||0),"aqua"));
  cards.appendChild(card("RAM liberada (MB)",String(t.ramFreedMb||0),"coral"));
  cards.appendChild(card("protegidas (guarda)",String(t.totalSkipped||0)));
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
tick();setInterval(tick,10000);
</script></body></html>`;
