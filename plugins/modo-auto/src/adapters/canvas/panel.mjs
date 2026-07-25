// Painel canvas ENXUTO do modo-auto — SERVER + HTML, SEM dependência do SDK (testável em smoke).
// Mostra os 3 interruptores conscientes: STATUS ao vivo + 1 parágrafo cada (fonte = guide.mjs, o mesmo
// do modo_guia) + um botão que LIGA/DESLIGA delegando ao HOST (onToggle → o mesmo caminho dos tools,
// incl. reflect() no modo-auto). O painel é burro: não sabe flipar estado, só pede ao host e re-lê.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SWITCHES, PRODUCT, CAPABILITIES } from "./guide.mjs";

export const PANEL_CANVAS_ID = "modo-auto-panel";
export const PANEL_INSTANCE_ID = "modo-auto-panel";
export const PANEL_TITLE = "🧠 modo-auto";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function stateDir() { return process.env.MODO_AUTO_PANEL_DIR || join(homedir(), ".copilot-modo-auto"); }
function portFile() { return join(stateDir(), "panel-port.json"); }
function readPreferredPort() {
  try { const p = Number(JSON.parse(readFileSync(portFile(), "utf8")).port); return Number.isInteger(p) && p > 1024 && p < 65536 ? p : null; } catch { return null; }
}
function writePreferredPort(port) { try { mkdirSync(stateDir(), { recursive: true }); writeFileSync(portFile(), JSON.stringify({ port })); } catch { /* best-effort */ } }

/**
 * HTML do painel a partir do estado atual. PURO/testável (sem I/O).
 * @param {{auto:boolean, deep:boolean, sombra:boolean}} state
 */
export function renderPanelHTML(state = {}) {
  const levers = SWITCHES.map((s) => {
    const on = !!state[s.key];
    return `<section class="lever ${on ? "on" : "off"}" data-accent="${esc(s.key)}">
      <div class="lever-h"><h2>${esc(s.name)}</h2>
        <button class="track" type="button" role="switch" aria-checked="${on ? "true" : "false"}" data-key="${esc(s.key)}" data-next="${on ? "off" : "on"}" aria-label="${on ? "Desligar" : "Ligar"} ${esc(s.name)}"><span class="knob"></span></button>
      </div>
      <p class="desc">${esc(s.paragraph)}</p>
      <div class="lever-f"><code>${esc(s.tool)} ${on ? "off" : "on"}</code><span class="state">${on ? "LIGADO" : "desligado"}</span></div>
    </section>`;
  }).join("\n");

  const caps = CAPABILITIES.map(([n, d]) =>
    `<div class="cap"><code class="cid">${esc(n)}</code><span class="cdesc">${esc(d)}</span></div>`
  ).join("\n");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PANEL_TITLE)}</title>
<style>
  :root{
    color-scheme: dark;
    --ink:#0a0d13; --panel:#0f141d; --raised:#151b26; --line:#212a38; --line-soft:#19212d;
    --text:#eaeef6; --muted:#8b95a7; --faint:#586274;
    --auto:#3fd7c4; --deep:#f2a75b; --sombra:#b98bff;
    --mono: ui-monospace,"Cascadia Code","SF Mono",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}
  body{font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:14px 14px 28px;background:radial-gradient(130% 60% at 50% -12%,#0e1522 0%,var(--ink) 62%);color:var(--text);-webkit-font-smoothing:antialiased}
  .top{margin:0 0 4px}
  .brand{display:flex;align-items:center;gap:9px}
  .pulse-dot{width:9px;height:9px;border-radius:50%;background:var(--auto);flex:none}
  body.alive .pulse-dot{animation:beat 1.1s ease-out infinite}
  @keyframes beat{0%{box-shadow:0 0 0 0 rgba(63,215,196,.55)}70%{box-shadow:0 0 0 8px rgba(63,215,196,0)}100%{box-shadow:0 0 0 0 rgba(63,215,196,0)}}
  .word{font-weight:800;letter-spacing:.01em;font-size:15px}
  .ekg{flex:1;height:22px;opacity:.4}
  .ekg polyline{fill:none;stroke:var(--auto);stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}
  body.alive .ekg{opacity:.85}
  body.alive .ekg polyline{stroke-dasharray:20 250;animation:trace 1.5s linear infinite}
  @keyframes trace{from{stroke-dashoffset:270}to{stroke-dashoffset:0}}
  .lede{margin:9px 0 0;color:var(--muted);font-size:11.5px;max-width:48ch}
  .eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.17em;font-weight:700;color:var(--muted);margin:22px 2px 9px;display:flex;align-items:baseline;gap:7px}
  .eyebrow .hint{font-weight:500;letter-spacing:.01em;text-transform:none;color:var(--faint);font-size:10.5px}
  .eyebrow .hint b{color:var(--muted);font-weight:700;font-style:normal}
  .levers{display:flex;flex-direction:column;gap:9px}
  .lever{position:relative;border:1px solid var(--line);border-radius:12px;padding:12px 14px 11px;background:linear-gradient(180deg,var(--raised),var(--panel));overflow:hidden}
  .lever::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--faint);opacity:.3;transition:.25s}
  .lever.on[data-accent="auto"]{--ac:var(--auto)}
  .lever.on[data-accent="deep"]{--ac:var(--deep)}
  .lever.on[data-accent="sombra"]{--ac:var(--sombra)}
  .lever.on{border-color:color-mix(in oklab,var(--ac) 50%,var(--line))}
  .lever.on::before{background:var(--ac);opacity:1;box-shadow:0 0 16px var(--ac)}
  .lever-h{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .lever h2{margin:0;font-size:12px;font-weight:800;letter-spacing:.13em}
  .lever.on h2{color:var(--ac)}
  .track{flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--line);background:#0b0f17;padding:0;cursor:pointer;position:relative;transition:.22s}
  .track .knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--faint);transition:.24s cubic-bezier(.4,1.35,.5,1)}
  .lever.on .track{background:color-mix(in oklab,var(--ac) 24%,#0b0f17);border-color:var(--ac)}
  .lever.on .track .knob{left:22px;background:var(--ac);box-shadow:0 0 10px var(--ac)}
  .track:focus-visible{outline:2px solid var(--ac,#5b8cff);outline-offset:3px}
  .desc{margin:9px 0 10px;color:#c4ccda;font-size:11.5px}
  .lever-f{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .lever code{font-family:var(--mono);font-size:10.5px;color:var(--muted);background:#0b1017;border:1px solid var(--line-soft);padding:2px 7px;border-radius:6px}
  .lever.on code{color:var(--ac);border-color:color-mix(in oklab,var(--ac) 38%,var(--line-soft))}
  .state{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
  .lever.on .state{color:var(--ac)}
  .caps{border:1px solid var(--line-soft);border-radius:12px;overflow:hidden;background:var(--panel)}
  .cap{display:flex;gap:11px;align-items:baseline;padding:8px 13px;border-top:1px solid var(--line-soft)}
  .cap:first-child{border-top:0}
  .cap .cid{font-family:var(--mono);font-size:11px;color:#8fb2ff;white-space:nowrap;flex:none;min-width:120px}
  .cap .cdesc{color:var(--muted);font-size:11px}
  .note{color:var(--faint);font-size:10.5px;margin:9px 2px 0}
  .empty{color:var(--faint);font-size:11.5px;margin:2px}
  .act{border:1px solid var(--line-soft);border-radius:9px;padding:8px 10px;margin:0 0 6px;background:var(--panel)}
  .act .top{display:flex;align-items:center;gap:7px;font-size:11.5px}
  .act .role{font-weight:600}
  .act .st{font-size:9px;padding:1px 6px;border-radius:999px;background:#232c3a;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  .act.running .st{background:#173a49;color:var(--auto)}
  .act.fail .st{background:#4a1f22;color:#ff8a8a}
  .act.done .st{background:#1c3a2a;color:#63d197}
  .act .meta{color:var(--faint);font-size:10px;margin-left:auto;font-family:var(--mono)}
  .act .snip{color:#aeb8c8;font-size:11px;margin:4px 0 0;white-space:pre-wrap}
  .thread{border:1px solid var(--line-soft);border-radius:11px;margin:0 0 8px;background:var(--panel);overflow:hidden}
  .thread>summary{list-style:none;cursor:pointer;padding:9px 12px;display:flex;align-items:center;gap:8px}
  .thread>summary::-webkit-details-marker{display:none}
  .thread .kind{font-size:9px;text-transform:uppercase;letter-spacing:.09em;padding:2px 8px;border-radius:999px;font-weight:700}
  .thread .kind.mesa{background:#a371f728;color:#d2b8ff}.thread .kind.adr{background:#2ea04328;color:#7ee787}
  .thread .kind.dev{background:#1f6feb28;color:#79c0ff}.thread .kind.sombra{background:#8b95a728;color:#c3cbd9}
  .thread .kind.deep{background:#f2a75b28;color:#ffbf87}.thread .kind.gate{background:#e3b34128;color:#f2cc60}
  .thread .topic{font-size:12px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .thread .gmeta{font-size:9.5px;color:var(--muted);margin-left:auto;display:flex;align-items:center;gap:5px;font-family:var(--mono)}
  .thread .body{padding:2px 12px 9px}
  .turn{display:flex;gap:9px;padding:7px 0;border-top:1px solid var(--line-soft)}
  .turn .rail{width:3px;border-radius:3px;background:#2a3341;flex:none}
  .turn.running .rail{background:var(--auto)}.turn.done .rail{background:#3fbf7a}.turn.fail .rail{background:#f27070}
  .turn .who{font-size:11px;font-weight:600;color:var(--text)}
  .turn .say{font-size:11px;color:#aeb8c8;margin:2px 0 0;white-space:pre-wrap}
  .turn .tmeta{font-size:9px;color:var(--faint);margin-left:auto;white-space:nowrap;font-family:var(--mono)}
  .spin{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--auto);animation:pmesa 1.2s ease-in-out infinite}
  @keyframes pmesa{0%,100%{opacity:.3}50%{opacity:1}}
  @media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}.ekg polyline{stroke-dasharray:none!important}}
</style></head><body>
  <header class="top">
    <div class="brand"><span class="pulse-dot"></span><span class="word">modo-auto</span><svg class="ekg" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,12 20,12 26,4 32,20 38,12 58,12 64,7 70,17 76,12 120,12"/></svg></div>
    <p class="lede">${esc(PRODUCT)}</p>
  </header>
  <p class="eyebrow">Interruptores conscientes <span class="hint">— todos <b>off</b> por padrão, nada liga sozinho</span></p>
  <div id="cards" class="levers">${levers}</div>
  <p class="note">Por sessão — não afeta outras. Ligar aqui = chamar o tool.</p>
  <p class="eyebrow">Capacidades <span class="hint">— sempre prontas, você chama quando precisa</span></p>
  <div class="caps">${caps}</div>
  <p class="eyebrow">Conversas da mesa <span class="hint">· <span id="gcount">0</span> deliberações</span></p>
  <div id="threads"><p class="empty">nenhuma deliberação ainda nesta sessão.</p></div>
  <p class="eyebrow">Atividade da mesa <span class="hint">· <span id="running">0</span> rodando</span></p>
  <div id="activity"><p class="empty">nenhum agente rodou ainda nesta sessão.</p></div>
<script>
  async function refresh() {
    try { const r = await fetch("./status"); const s = await r.json(); paint(s); } catch (e) {}
  }
  function paint(s) {
    document.querySelectorAll(".lever").forEach(function (lever) {
      var btn = lever.querySelector(".track"); if (!btn) return;
      var key = btn.getAttribute("data-key"); var on = !!s[key];
      lever.classList.toggle("on", on); lever.classList.toggle("off", !on);
      btn.setAttribute("aria-checked", on ? "true" : "false"); btn.setAttribute("data-next", on ? "off" : "on");
      var stEl = lever.querySelector(".state"); if (stEl) stEl.textContent = on ? "LIGADO" : "desligado";
      var codeEl = lever.querySelector("code"); if (codeEl) codeEl.textContent = codeEl.textContent.replace(/\\s(on|off)$/, " " + (on ? "off" : "on"));
      btn.disabled = false;
    });
  }
  document.getElementById("cards").addEventListener("click", async function (ev) {
    var btn = ev.target.closest(".track"); if (!btn) return;
    btn.disabled = true;
    try {
      var r = await fetch("./toggle", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: btn.getAttribute("data-key"), value: btn.getAttribute("data-next") === "on" }) });
      var s = await r.json(); paint(s);
    } catch (e) { btn.disabled = false; }
  });
  function fmtDur(ms) { if (ms == null) return ""; if (ms < 1000) return ms + "ms"; return (ms / 1000).toFixed(1) + "s"; }
  function escAct(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  async function refreshActivity() {
    try {
      var a = await (await fetch("./activity")).json();
      document.getElementById("running").textContent = a.running || 0;
      document.body.classList.toggle("alive", (a.running || 0) > 0);
      var box = document.getElementById("activity");
      if (!a.recent || !a.recent.length) { box.innerHTML = '<p class="empty">nenhum agente rodou ainda nesta sessão.</p>'; }
      else box.innerHTML = a.recent.map(function (e) {
        var cls = e.status === "running" ? "running" : (e.status === "fail" ? "fail" : "done");
        var tags = [e.stage, e.taskType].filter(Boolean).join(" · ");
        var meta = [tags, e.model, fmtDur(e.durationMs)].filter(Boolean).join(" · ");
        var snip = e.snippet ? '<p class="snip">' + escAct(e.snippet) + '</p>' : (e.status === "running" ? '<p class="snip">rodando…</p>' : '');
        return '<div class="act ' + cls + '"><div class="top"><span class="role">' + escAct(e.role) + '</span><span class="st">' + cls + '</span><span class="meta">' + escAct(meta) + '</span></div>' + snip + '</div>';
      }).join("");
      renderThreads(a.groups || []);
    } catch (e) { /* painel resiliente: falha de fetch não quebra a UI */ }
  }
  var KIND_LABEL = { mesa: "mesa", adr: "adr", dev: "dev", sombra: "sombra", deep: "deep", gate: "gate" };
  function renderThreads(groups) {
    document.getElementById("gcount").textContent = groups.length;
    var box = document.getElementById("threads");
    if (!groups.length) { box.innerHTML = '<p class="empty">nenhuma deliberação ainda nesta sessão.</p>'; return; }
    // preserva quais threads o usuário fechou (por id) entre atualizações
    var closed = {}; box.querySelectorAll("details.thread").forEach(function (d) { if (!d.open) closed[d.getAttribute("data-id")] = 1; });
    box.innerHTML = groups.map(function (g) {
      var kind = KIND_LABEL[g.kind] ? g.kind : "mesa";
      var st = g.status === "running" ? '<span class="spin"></span> rodando' : (g.status === "fail" ? "com falha" : "concluída");
      var n = (g.workers || []).length;
      var open = closed[g.id] ? "" : " open";
      var turns = (g.workers || []).map(function (w) {
        var cls = w.status === "running" ? "running" : (w.status === "fail" ? "fail" : "done");
        var say = w.snippet ? escAct(w.snippet) : (w.status === "running" ? "pensando…" : "");
        var tm = [w.model, fmtDur(w.durationMs)].filter(Boolean).join(" · ");
        return '<div class="turn ' + cls + '"><div class="rail"></div><div style="flex:1"><span class="who">' + escAct(w.role) + '</span>'
          + '<span class="tmeta">' + escAct(tm) + '</span><p class="say">' + say + '</p></div></div>';
      }).join("");
      return '<details class="thread" data-id="' + escAct(g.id) + '"' + open + '>'
        + '<summary><span class="kind ' + kind + '">' + escAct(kind) + '</span>'
        + '<span class="topic">' + escAct(g.topic || "(sem tópico)") + '</span>'
        + '<span class="gmeta">' + n + ' ' + (n === 1 ? "agente" : "agentes") + ' · ' + st + '</span></summary>'
        + '<div class="body">' + turns + '</div></details>';
    }).join("");
  }
  setInterval(refresh, 3000);
  setInterval(refreshActivity, 2000); refreshActivity();
</script></body></html>`;
}

/**
 * Painel canvas. `stateProvider()` → {auto,deep,sombra} (estado ao vivo). `onToggle(key,value)` → o host
 * flipa DE VERDADE (mesmo caminho dos tools; ex.: reflect() no auto) e devolve o novo estado (ou void).
 */
export class ModoAutoPanel {
  constructor({ stateProvider = () => ({}), onToggle = null, activityProvider = null, log = () => {} } = {}) {
    this.stateProvider = stateProvider;
    this.onToggle = onToggle;
    this.activityProvider = activityProvider; // () => { running, recent[] } — observabilidade (opcional)
    this.log = log;
    this.url = null;
    this._server = null;
    this._serverPromise = null;
  }

  _status() {
    const s = this.stateProvider() || {};
    return { auto: !!s.auto, deep: !!s.deep, sombra: !!s.sombra };
  }

  _activity() {
    if (typeof this.activityProvider !== "function") return { running: 0, total: 0, recent: [], groups: [] };
    const a = this.activityProvider() || {};
    return { running: a.running || 0, total: a.total || 0, recent: Array.isArray(a.recent) ? a.recent : [], groups: Array.isArray(a.groups) ? a.groups : [] };
  }

  async ensureServer() {
    if (this._server) return this.url;
    if (this._serverPromise) return this._serverPromise;
    this._sockets = new Set();
    const listenOn = (port) => new Promise((resolve, reject) => {
      const server = createServer((req, res) => { this._route(req, res).catch((e) => { try { res.statusCode = 500; res.end(String(e?.message || e)); } catch { /* já respondido */ } }); });
      server.on("connection", (s) => { this._sockets.add(s); s.on("close", () => this._sockets.delete(s)); });
      const onErr = (e) => { server.removeListener("listening", onOk); reject(e); };
      const onOk = () => {
        server.removeListener("error", onErr);
        this._server = server;
        const p = server.address().port;
        this.url = `http://127.0.0.1:${p}/`;
        writePreferredPort(p);
        resolve(this.url);
      };
      server.once("error", onErr);
      server.listen(port, "127.0.0.1", onOk);
    });
    const preferred = readPreferredPort();
    this._serverPromise = (preferred ? listenOn(preferred).catch(() => listenOn(0)) : listenOn(0))
      .catch((e) => { this._serverPromise = null; throw e; });
    return this._serverPromise;
  }

  // Shutdown limpo: destrói sockets vivos (keep-alive) e fecha o server — sem race de teardown.
  async close() {
    const srv = this._server;
    if (!srv) return;
    for (const s of this._sockets || []) { try { s.destroy(); } catch { /* ignore */ } }
    await new Promise((r) => srv.close(() => r()));
    this._server = null; this._serverPromise = null; this.url = null;
  }

  async _route(req, res) {
    // localhost-only + poll leve (3s): sem keep-alive → nada de socket ocioso pra reciclar (shutdown trivial,
    // sem race de teardown no Windows). Ganho de keep-alive é irrelevante aqui.
    res.setHeader("Connection", "close");
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPanelHTML(this._status()));
      return;
    }
    if (req.method === "GET" && u.pathname === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this._status()));
      return;
    }
    if (req.method === "GET" && u.pathname === "/activity") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this._activity()));
      return;
    }
    if (req.method === "POST" && u.pathname === "/toggle") {
      const body = await readBody(req);
      let key, value;
      try { const j = JSON.parse(body || "{}"); key = j.key; value = !!j.value; } catch { res.statusCode = 400; res.end('{"error":"json"}'); return; }
      const known = SWITCHES.some((s) => s.key === key);
      if (!known) { res.statusCode = 400; res.end('{"error":"chave desconhecida"}'); return; }
      if (typeof this.onToggle !== "function") { res.statusCode = 501; res.end('{"error":"painel sem onToggle (host nao ligou)"}'); return; }
      // FAIL LOUD: erro do flip do host vira 500 com a mensagem REAL (surfaced, não finge sucesso).
      try {
        await this.onToggle(key, value);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(e?.message || e) }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this._status()));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); req.on("error", () => resolve("")); });
}
