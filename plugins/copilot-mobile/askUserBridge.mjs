// askUserBridge.mjs — override do ask_user para sessões LIVE (app aberto) quando o daemon está armado.
//
// PROBLEMA: numa sessão live, o ask_user usa o tool NATIVO do app → renderiza um modal no PC que só
// fecha no clique local. Responder pelo celular resolve o turno por baixo, mas a janela fica órfã
// (o frontend do app não reage ao user_input.completed de outro cliente). Não há API no SDK pra
// dispensar essa janela.
//
// SOLUÇÃO (na origem): o bridge (que roda DENTRO da sessão live via joinSession) registra um override
// do ask_user com overridesBuiltInTool:true. Assim o app NÃO renderiza o modal nativo — não há janela
// pra ficar presa. A pergunta é roteada por nós:
//   1) emite um user_input.requested SINTÉTICO pelo liveLink → o daemon normaliza → CARD NO CELULAR
//      (reusa todo o pipeline + o fix de sobrevivência do card que já existe);
//   2) abre um CANVAS no PC (painel lateral) com a pergunta + botões, pra responder sem o celular;
//   3) BLOQUEIA o turno até a resposta chegar de QUALQUER via (celular OU canvas) — ou o turno abortar;
//   4) emite user_input.completed (limpa o card) e FECHA o canvas (a Voz volta a ser o painel ativo).
//
// Só é instanciado quando há um TRANSPORTE ABERTO no boot do bridge (extension.mjs/askMode decidem).
// Transporte fechado (daemon off/ausente) ⇒ este override NÃO roda ⇒ ask_user NATIVO normal no PC
// (modal padrão, confiável, nunca escondido); o celular ainda responde o nativo via handlePendingUserInput.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@github/copilot-sdk/extension";
import { deriveCanvasIds, ASK_CANVAS_BASE } from "./canvasId.mjs";
import { availabilityOf, shouldRetryCanvasOpen, canvasRetryDelayMs } from "./canvasOpen.mjs";

export const ASK_CANVAS_ID = ASK_CANVAS_BASE;

export class AskUserBridge {
  constructor({ log = () => {}, sessionId = "" } = {}) {
    this.log = log;
    // Per-session UNIQUE canvas id + instance. A FIXED id is global last-writer-wins at the host: a
    // newer session registering the same id STEALS it, so every OTHER session's canvas.open then fails
    // "No canvas is registered" (orphaned questions on the PC). Deriving from the sessionId (pid fallback)
    // gives each concurrent session its OWN canvas that can't be stolen by a sibling. See canvasId.mjs.
    const ids = deriveCanvasIds(sessionId, typeof process !== "undefined" ? process.pid : 0);
    this._canvasId = ids.canvasId;
    this._instanceId = ids.instanceId; // one question at a time (the turn blocks on it)
    this.session = null;   // the joined live CopilotSession (for rpc.canvas.open/close)
    this.liveLink = null;  // to emit the synthetic user_input.* to the daemon → phone
    this._pending = new Map(); // requestId -> { resolve, question, choices, allowFreeform }
    this._server = null;
    this._serverPromise = null; // in-flight _ensureServer() promise (memoized so concurrent callers share ONE server)
    this._openPromise = null;   // in-flight canvas.open() promise, awaited before close so close can't race ahead
    this._returnTarget = null;  // canvas the user was on before the question opened, re-focused on close
    this._url = null;
  }

  setSession(s) { this.session = s; }
  setLiveLink(l) { this.liveLink = l; }

  /** The ask_user override registered in joinSession({ tools: [...] }). */
  tool() {
    return {
      name: "ask_user",
      overridesBuiltInTool: true,
      description: "Ask the user a question and wait for their response.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user." },
          choices: { type: "array", items: { type: "string" }, description: "Optional multiple-choice options." },
          allowFreeform: { type: "boolean", description: "Allow freeform text in addition to choices (default true)." },
        },
        required: ["question"],
      },
      handler: async (args) => this._handle(args || {}),
    };
  }

  /** The canvas registered in joinSession({ canvases: [...] }). Serves a small local page. */
  canvas() {
    return createCanvas({
      id: this._canvasId,
      displayName: "Pergunta",
      description: "Responder no PC a pergunta que o agente fez (espelha o celular)",
      open: async () => {
        await this._ensureServer();
        return { title: "❓ Pergunta do agente", url: this._url };
      },
    });
  }

  async _handle(args) {
    const requestId = randomUUID();
    const question = typeof args.question === "string" ? args.question : "";
    const choices = Array.isArray(args.choices) ? args.choices.filter((c) => typeof c === "string") : [];
    const allowFreeform = args.allowFreeform !== false;
    this.log(`ask_user override: req=${requestId} q="${question.slice(0, 60)}" choices=${JSON.stringify(choices)}`);

    // CRITICAL ORDERING: register the resolver FIRST — before notifying anyone and before ANY await —
    // so an answer from either side (phone or canvas) always has somewhere to land. If we notified the
    // phone (or awaited canvas.open) first, a fast phone tap in that window would be dropped, and a
    // canvas.open that HANGS would block registration forever ⇒ unrescuable turn hang. (Gate findings
    // E1/E3.) The blocking is ONLY on this promise; setup is best-effort and off the critical path.
    const answerPromise = new Promise((resolve) => {
      this._pending.set(requestId, { resolve, question, choices, allowFreeform });
    });

    // 1) route to the phone via a synthetic transient event (daemon normalizes → question card).
    try { this.liveLink?.pushEvent({ type: "user_input.requested", data: { requestId, question, choices, allowFreeform } }); } catch (e) { this.log("push requested err: " + (e?.message || e)); }

    // 2) start the local canvas server + open the canvas on the PC, with BOUNDED RETRY until the panel is
    //    confirmed shown. In override mode the native modal is suppressed, so the canvas MUST surface — a
    //    stale/failed open (provider stolen by a reload fork, or a host hiccup) is re-issued (re-opening
    //    rehydrates + rebinds the provider). Still OFF the blocking path: a slow/wedged open never delays
    //    the answer, and we stop retrying the moment the question is answered/aborted. We KEEP the promise
    //    so cleanup waits for open to finish before closing (a close racing ahead of open is a host no-op).
    this._ensureServer().catch((e) => this.log("server err: " + (e?.message || e)));
    this._returnTarget = null;
    this._openPromise = Promise.resolve()
      .then(async () => {
        // Snapshot who's ALREADY open before we add our canvas, so on close we return focus to the user's
        // PRIOR canvas (whatever it was) — never guessing/hardcoding, never spawning anything new.
        try {
          const snap = await this.session?.rpc?.canvas?.listOpen();
          const others = (snap?.openCanvases || []).filter((c) => c && c.canvasId !== this._canvasId);
          this._returnTarget = others[0] || null;
        } catch {}
        const maxAttempts = 3;
        let result = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (!this._pending.has(requestId)) return result; // already answered/aborted → stop retrying
          let threw = false;
          try {
            result = await this.session?.rpc?.canvas?.open({ canvasId: this._canvasId, instanceId: this._instanceId, input: { requestId } });
          } catch (e) { threw = true; result = null; this.log(`canvas open attempt ${attempt} err: ` + (e?.message || e)); }
          const availability = availabilityOf(result);
          this.log(`canvas open attempt ${attempt}: availability=${availability} threw=${threw} (returnTarget=${this._returnTarget?.canvasId ?? "none"})`);
          if (!shouldRetryCanvasOpen({ availability, threw, attempt, maxAttempts })) return result;
          await new Promise((r) => setTimeout(r, canvasRetryDelayMs(attempt)));
        }
        return result;
      })
      .catch((e) => { this.log("canvas open err: " + (e?.message || e)); return null; });

    // 3) block ONLY on the answer (phone OR canvas), or an abort (abortAll resolves it with "").
    const answer = await answerPromise;

    // 4) cleanup: clear the phone card + close the canvas (Voz volta a ser o painel ativo).
    try { this.liveLink?.pushEvent({ type: "user_input.completed", data: { requestId, answer } }); } catch {}
    await this._closeCanvas();

    const text = String(answer ?? "").trim();
    return { resultType: "success", textResultForLlm: text || "(o usuário não respondeu)" };
  }

  /** Close the PC canvas for real. The host won't tear down the ACTIVE tab on close, so we first return
   *  focus to the user's PRIOR canvas (captured at open — whatever they were already on, never spawned)
   *  to make OUR tab a background one, THEN close it. Waits (bounded) for open to finish first. */
  async _closeCanvas() {
    try { await Promise.race([this._openPromise ?? Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]); } catch {}
    // Return focus to whatever canvas the user was on before the question (already-open only — never a
    // spawn), so ours stops being the active tab. A user who doesn't use voice never sees voice pop up.
    const back = this._returnTarget;
    if (back) {
      try {
        await this.session?.rpc?.canvas?.open({ canvasId: back.canvasId, instanceId: back.instanceId });
        this.log(`returned focus to ${back.canvasId}/${back.instanceId} before closing ask`);
      } catch (e) { this.log("return focus err: " + (e?.message || e)); }
    } else {
      this.log("no prior canvas to return focus to (closing ask directly)");
    }
    // Now close ours (retry once) — with our tab now in the background, the host removes it.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.session?.rpc?.canvas?.close({ canvasId: this._canvasId, instanceId: this._instanceId });
        this.log(`canvas closed (req done)`);
        break;
      } catch (e) {
        this.log(`canvas close attempt ${attempt} err: ` + (e?.message || e));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** Resolve from the phone (liveLink cmd "answer"). Returns true if it matched a pending question. */
  resolveFromPhone(requestId, answer) { return this._resolve(requestId, answer); }

  /** Resolve every pending question (called on abort so a killed turn never dangles). */
  abortAll() { for (const rid of [...this._pending.keys()]) this._resolve(rid, ""); }

  /** True if there's an open override question (extension.mjs uses this to only touch our own path). */
  hasPending() { return this._pending.size > 0; }

  _resolve(requestId, answer) {
    let key = String(requestId || "");
    // Empty id (older phone with no requestId) → resolve the single open question if there's exactly
    // one. A non-empty UNKNOWN id must NOT hijack a different pending question: a stale/duplicate answer
    // carrying an already-closed requestId would otherwise inject the wrong text into the NEXT ask_user
    // (gate finding E2). So only the empty-id case falls back; a non-matching non-empty id returns false.
    if (!key && this._pending.size === 1) key = [...this._pending.keys()][0];
    const p = this._pending.get(key);
    if (!p) return false;
    this._pending.delete(key);
    try { p.resolve(String(answer ?? "")); } catch {}
    return true;
  }

  _currentPayload() {
    // The one open question (the turn blocks on a single ask_user at a time).
    const rid = [...this._pending.keys()][0];
    if (!rid) return null;
    const p = this._pending.get(rid);
    return { requestId: rid, question: p.question, choices: p.choices, allowFreeform: p.allowFreeform };
  }

  async _ensureServer() {
    if (this._server) return;
    // Memoize the in-flight start so concurrent callers (_handle AND the canvas open() handler) share
    // ONE server. Guarding only on `this._server` (set after the async listen) is a check-then-act race
    // that could bind two servers and orphan one (gate round-2 finding). The promise clears on failure
    // so a later call can retry.
    if (this._serverPromise) return this._serverPromise;
    this._serverPromise = new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://x");
          if (req.method === "GET" && u.pathname === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(this._pageHtml()); return;
          }
          if (req.method === "GET" && u.pathname === "/state") {
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ pending: this._currentPayload() })); return;
          }
          if (req.method === "POST" && u.pathname === "/answer") {
            let body = ""; for await (const c of req) body += c;
            let requestId = "", answer = "", wasFreeform = false;
            try { const j = JSON.parse(body || "{}"); requestId = j.requestId ?? ""; answer = String(j.answer ?? ""); wasFreeform = !!j.wasFreeform; } catch {}
            const cur = this._currentPayload();
            const rid = requestId || cur?.requestId || "";
            const ok = this._resolve(rid, answer);
            this.log(`canvas answer: req=${rid} ok=${ok} wasFreeform=${wasFreeform}`);
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok })); return;
          }
          res.statusCode = 404; res.end("not found");
        } catch (e) { res.statusCode = 500; res.end(String(e?.message || e)); }
      });
      // Resolve on listen success; reject (not crash) on a bind error so a failure fails the turn
      // cleanly instead of raising an uncaughtException — the phone path can still carry the question.
      const onErr = (e) => { server.removeListener("listening", onOk); reject(e); };
      const onOk = () => {
        server.removeListener("error", onErr);
        this._server = server;
        this._url = `http://127.0.0.1:${server.address().port}/`;
        this.log(`ask canvas server em ${this._url}`);
        resolve();
      };
      server.once("error", onErr);
      server.listen(0, "127.0.0.1", onOk);
    }).catch((e) => { this._serverPromise = null; throw e; });
    return this._serverPromise;
  }

  _pageHtml() {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pergunta do agente</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:system-ui,Segoe UI,sans-serif;margin:0;padding:18px;background:#0d1117;color:#e6edf3}
  h1{font-size:15px;margin:0 0 2px;font-weight:600}
  .sub{color:#8b949e;font-size:12px;margin-bottom:16px}
  .q{font-size:16px;line-height:1.45;margin:0 0 16px;white-space:pre-wrap}
  .choices{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
  button{cursor:pointer;text-align:left;border-radius:10px;border:1px solid #30363d;padding:12px 14px;font-size:14px;background:#21262d;color:#e6edf3;transition:.12s}
  button:hover{background:#30363d;border-color:#8b949e}
  button:disabled{opacity:.5;cursor:default}
  .num{display:inline-block;min-width:20px;color:#8b949e;font-variant-numeric:tabular-nums}
  form{display:flex;gap:8px;margin-top:6px}
  input[type=text]{flex:1;border-radius:10px;border:1px solid #30363d;padding:12px;background:#010409;color:#e6edf3;font-size:14px}
  input[type=text]:focus{outline:none;border-color:#1f6feb}
  .send{background:#238636;border-color:#2ea043;color:#fff;font-weight:600;text-align:center;padding:12px 16px}
  .send:hover{background:#2ea043}
  .none{color:#8b949e;font-style:italic}
  .done{color:#3fb950;font-weight:600}
</style></head>
<body>
  <h1>❓ Pergunta do agente</h1>
  <div class="sub">Responda aqui ou pelo celular — o que vier primeiro. Ao responder, isto fecha sozinho.</div>
  <div id="app"><div class="none">carregando…</div></div>
<script>
  const app = document.getElementById('app');
  let current = null, answering = false, renderedRid = null;
  function esc(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function render(){
    let html = '<div class="q">'+esc(current.question||'(sem texto)')+'</div>';
    if((current.choices||[]).length){
      html += '<div class="choices">';
      current.choices.forEach((c,i)=>{ html += '<button data-i="'+i+'"><span class="num">'+(i+1)+'.</span> '+esc(c)+'</button>'; });
      html += '</div>';
    }
    if(current.allowFreeform!==false){
      html += '<form id="ffForm"><input type="text" id="ff" placeholder="Digite sua resposta…" autocomplete="off"/><button class="send" type="submit">Enviar</button></form>';
    }
    app.innerHTML = html;
    app.querySelectorAll('button[data-i]').forEach(b=>b.addEventListener('click', ()=>answer(+b.dataset.i)));
    const form = document.getElementById('ffForm');
    if(form) form.addEventListener('submit', freeform);
    const ff = document.getElementById('ff');
    if(ff) ff.focus();
  }
  async function load(){
    if (answering) return; // enquanto um POST /answer está em voo, não mexe no DOM
    try{
      const r = await fetch('/state'); const j = await r.json();
      current = j.pending;
      if(!current){
        // Sem pergunta aberta agora. Mostra "respondido" UMA vez e RE-ARMA (renderedRid=null) para que a
        // PRÓXIMA pergunta seja renderizada mesmo quando o host REUSA este painel (mesmo instanceId ⇒ só
        // foca a webview já carregada, não recria) em vez de fechá-lo — senão a página ficava presa na
        // tela final da pergunta anterior e nunca mostrava a nova (o bug do flag "done" permanente).
        if(renderedRid !== null){ app.innerHTML = '<div class="done">✓ Respondido — fechando…</div>'; renderedRid = null; }
        return;
      }
      // Uma pergunta está aberta. Só reconstrói o DOM quando é uma pergunta NOVA (requestId mudou) —
      // enquanto a MESMA segue aberta o poll é no-op (preserva o texto digitado e o foco do input).
      if(current.requestId === renderedRid) return;
      renderedRid = current.requestId;
      render();
    }catch(e){ /* keep last */ }
  }
  async function send(text, wasFreeform){
    if(answering || !current) return;
    answering = true;
    const rid = current.requestId;
    document.querySelectorAll('button,input').forEach(b=>b.disabled=true);
    app.innerHTML = '<div class="done">✓ Enviando…</div>';
    try{
      await fetch('/answer', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ requestId: rid, answer: text, wasFreeform })});
    }catch(e){}
    app.innerHTML = '<div class="done">✓ Respondido — fechando…</div>';
    answering = false; // libera o poll: quando /state virar null (ou uma nova pergunta) a página re-arma
  }
  function answer(i){ send(current.choices[i], false); }
  function freeform(ev){ ev.preventDefault(); const v=document.getElementById('ff').value.trim(); if(v) send(v, true); return false; }
  load(); setInterval(load, 800);
</script>
</body></html>`;
  }
}
