#!/usr/bin/env node

// build-artifact.mjs
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join2, dirname, resolve, extname as extname2 } from "node:path";
import { fileURLToPath } from "node:url";
import os2 from "node:os";
import { spawn } from "node:child_process";

// kit/lib/vox_client.mjs
import net from "node:net";
var DEFAULT_PIPE = "\\\\.\\pipe\\vox";
var MAX_JSON = 4 * 1024 * 1024;
var MAX_AUDIO = 512 * 1024 * 1024;
function encode(header, audio = Buffer.alloc(0)) {
  const jb = Buffer.from(JSON.stringify(header), "utf8");
  if (jb.length === 0 || jb.length > MAX_JSON) throw new Error(`json_len inv\xE1lido: ${jb.length}`);
  if (audio.length > MAX_AUDIO) throw new Error(`audio muito grande: ${audio.length}`);
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(jb.length, 0);
  head.writeUInt32BE(audio.length, 4);
  return Buffer.concat([head, jb, audio]);
}
var FrameDecoder = class {
  constructor(onFrame) {
    this._buf = Buffer.alloc(0);
    this._onFrame = onFrame;
  }
  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (; ; ) {
      if (this._buf.length < 8) return;
      const jsonLen = this._buf.readUInt32BE(0);
      const audioLen = this._buf.readUInt32BE(4);
      if (jsonLen === 0 || jsonLen > MAX_JSON || audioLen > MAX_AUDIO) {
        throw new Error(`frame fora dos limites (json=${jsonLen}, audio=${audioLen})`);
      }
      const total = 8 + jsonLen + audioLen;
      if (this._buf.length < total) return;
      const header = JSON.parse(this._buf.subarray(8, 8 + jsonLen).toString("utf8"));
      const audio = Buffer.from(this._buf.subarray(8 + jsonLen, total));
      this._buf = this._buf.subarray(total);
      this._onFrame(header, audio);
    }
  }
};
var VoxClient = class _VoxClient {
  constructor(sock) {
    this.sock = sock;
    this.alive = true;
    this._ids = 0;
    this._pending = /* @__PURE__ */ new Map();
    this._dec = new FrameDecoder((h, a) => this._onFrame(h, a));
    sock.on("data", (c) => {
      try {
        this._dec.push(c);
      } catch (e) {
        this._fail(e);
        try {
          sock.destroy();
        } catch {
        }
      }
    });
    sock.on("close", () => this._fail(new Error("pipe fechado")));
    sock.on("error", () => {
    });
  }
  static connect(pipeName = DEFAULT_PIPE, { timeoutMs = 5e3 } = {}) {
    return new Promise((resolve2, reject) => {
      const sock = net.connect({ path: pipeName });
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout ao conectar"));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        resolve2(new _VoxClient(sock));
      });
      sock.once("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
  }
  // Conecta se o daemon existir; senão resolve para null (reusa-se-existe).
  static async tryConnect(pipeName = DEFAULT_PIPE, opts = {}) {
    try {
      return await _VoxClient.connect(pipeName, opts);
    } catch {
      return null;
    }
  }
  _onFrame(header, audio) {
    const rid = header.req_id;
    const p2 = rid != null ? this._pending.get(rid) : void 0;
    if (p2) {
      clearTimeout(p2.timer);
      this._pending.delete(rid);
      p2.resolve({ header, audio });
    }
  }
  _fail(err2) {
    if (!this.alive && this._pending.size === 0) return;
    this.alive = false;
    for (const p2 of this._pending.values()) {
      clearTimeout(p2.timer);
      p2.reject(err2);
    }
    this._pending.clear();
  }
  request(header, audio = Buffer.alloc(0), { timeoutMs = 6e4 } = {}) {
    const rid = header.req_id || `r${++this._ids}`;
    const framed = { ...header, req_id: rid };
    return new Promise((resolve2, reject) => {
      if (!this.alive) return reject(new Error("cliente desconectado"));
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        reject(new Error(`timeout: ${header.cmd}`));
      }, timeoutMs);
      this._pending.set(rid, { resolve: resolve2, reject, timer });
      let data;
      try {
        data = encode(framed, audio);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(rid);
        return reject(e);
      }
      this.sock.write(data, (e) => {
        if (e) {
          clearTimeout(timer);
          this._pending.delete(rid);
          reject(e);
        }
      });
    });
  }
  async ping({ timeoutMs = 5e3 } = {}) {
    const { header } = await this.request({ cmd: "ping" }, void 0, { timeoutMs });
    return header.event === "pong";
  }
  async info({ timeoutMs = 5e3 } = {}) {
    return (await this.request({ cmd: "info" }, void 0, { timeoutMs })).header;
  }
  async openSession(session, defaults = {}) {
    return (await this.request({ cmd: "open_session", session, ...defaults })).header;
  }
  async set(session = "default", { lang, voice, priority } = {}, { timeoutMs = 5e3 } = {}) {
    const p2 = { cmd: "set", session };
    if (lang != null) p2.lang = lang;
    if (voice != null) p2.voice = voice;
    if (priority != null) p2.priority = priority;
    return (await this.request(p2, void 0, { timeoutMs })).header;
  }
  async closeSession(session) {
    return (await this.request({ cmd: "close_session", session })).header;
  }
  async transcribe(samples, { lang = "", session = "default", priority = "interactive", timeoutMs = 12e4 } = {}) {
    const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    const audio = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    const { header } = await this.request({ cmd: "transcribe", session, lang, priority }, audio, { timeoutMs });
    return header;
  }
  async tts(text, { voice = null, speed = 1, session = "default", priority = "interactive", format = "pcm", timeoutMs = 12e4 } = {}) {
    const req = { cmd: "tts", session, text, voice, speed, priority };
    if (format && format !== "pcm") req.format = format;
    const { header, audio } = await this.request(req, void 0, { timeoutMs });
    if (format && format !== "pcm") return { header, audio };
    const n = Math.floor(audio.length / 4);
    const f = new Float32Array(n);
    for (let i2 = 0; i2 < n; i2++) f[i2] = audio.readFloatLE(i2 * 4);
    return { header, audio: f };
  }
  async encodeFormats({ timeoutMs = 5e3 } = {}) {
    const info = (await this.request({ cmd: "info" }, void 0, { timeoutMs })).header;
    return info.encode_formats || ["pcm"];
  }
  close() {
    this.alive = false;
    try {
      this.sock.destroy();
    } catch {
    }
  }
};

// kit/lib/tts_cache.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
var CACHE_SCHEMA = "v1";
function ttsKey({ engine = "", voice = "", format = "", speed = 1, text = "" }) {
  return createHash("sha256").update([CACHE_SCHEMA, String(engine), String(voice), String(format), String(speed), String(text)].join("\0")).digest("hex");
}
function defaultCacheDir() {
  return process.env.VXK_TTS_CACHE_DIR || join(os.homedir(), ".cache", "vxk-tts");
}
function makeFileCache(dir = defaultCacheDir()) {
  let ready = false;
  const ensure = () => {
    if (!ready) {
      mkdirSync(dir, { recursive: true });
      ready = true;
    }
  };
  return {
    dir,
    get(key) {
      const p2 = join(dir, key + ".bin");
      if (!existsSync(p2)) return null;
      try {
        if (statSync(p2).size === 0) return null;
        return readFileSync(p2);
      } catch {
        return null;
      }
    },
    put(key, buf) {
      if (!buf || buf.length === 0) return;
      ensure();
      const final = join(dir, key + ".bin");
      const tmp = join(dir, key + "." + process.pid + "." + Date.now() + ".tmp");
      try {
        writeFileSync(tmp, buf);
        renameSync(tmp, final);
      } catch (e) {
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
        }
        throw e;
      }
    }
  };
}
function cached(cache, meta, synthFn) {
  const off = process.env.VXK_NO_CACHE === "1";
  let warned = false;
  const warnOnce = (e) => {
    if (!warned) {
      warned = true;
      console.warn("WARN  cache TTS indispon\xEDvel (seguindo sem cache): " + (e && e.message || e));
    }
  };
  return async (text) => {
    if (off) return { audio: await synthFn(text), cached: false };
    const key = ttsKey({ ...meta, text });
    let hit = null;
    try {
      hit = cache.get(key);
    } catch (e) {
      warnOnce(e);
      hit = null;
    }
    if (hit) return { audio: hit, cached: true };
    const audio = await synthFn(text);
    try {
      cache.put(key, audio);
    } catch (e) {
      warnOnce(e);
    }
    return { audio, cached: false };
  };
}

// node_modules/@dagrejs/dagre/dist/dagre.esm.js
var ge = Object.defineProperty;
var hn = (e, n, t) => n in e ? ge(e, n, { enumerable: true, configurable: true, writable: true, value: t }) : e[n] = t;
var fn = (e, n) => {
  for (var t in n) ge(e, t, { get: n[t], enumerable: true });
};
var pe = (e, n, t) => hn(e, typeof n != "symbol" ? n + "" : n, t);
var z = {};
fn(z, { Graph: () => p, alg: () => R, json: () => ye, version: () => pn });
var bn = Object.defineProperty;
var Le = (e, n) => {
  for (var t in n) bn(e, t, { get: n[t], enumerable: true });
};
var p = class {
  constructor(e) {
    this._isDirected = true, this._isMultigraph = false, this._isCompound = false, this._nodes = {}, this._in = {}, this._preds = {}, this._out = {}, this._sucs = {}, this._edgeObjs = {}, this._edgeLabels = {}, this._nodeCount = 0, this._edgeCount = 0, this._defaultNodeLabelFn = () => {
    }, this._defaultEdgeLabelFn = () => {
    }, e && (this._isDirected = "directed" in e ? e.directed : true, this._isMultigraph = "multigraph" in e ? e.multigraph : false, this._isCompound = "compound" in e ? e.compound : false), this._isCompound && (this._parent = {}, this._children = {}, this._children["\0"] = {});
  }
  isDirected() {
    return this._isDirected;
  }
  isMultigraph() {
    return this._isMultigraph;
  }
  isCompound() {
    return this._isCompound;
  }
  setGraph(e) {
    return this._label = e, this;
  }
  graph() {
    return this._label;
  }
  setDefaultNodeLabel(e) {
    return typeof e != "function" ? this._defaultNodeLabelFn = () => e : this._defaultNodeLabelFn = e, this;
  }
  nodeCount() {
    return this._nodeCount;
  }
  nodes() {
    return Object.keys(this._nodes);
  }
  sources() {
    return this.nodes().filter((e) => Object.keys(this._in[e]).length === 0);
  }
  sinks() {
    return this.nodes().filter((e) => Object.keys(this._out[e]).length === 0);
  }
  setNodes(e, n) {
    return e.forEach((t) => {
      n !== void 0 ? this.setNode(t, n) : this.setNode(t);
    }), this;
  }
  setNode(e, n) {
    return e in this._nodes ? (arguments.length > 1 && (this._nodes[e] = n), this) : (this._nodes[e] = arguments.length > 1 ? n : this._defaultNodeLabelFn(e), this._isCompound && (this._parent[e] = "\0", this._children[e] = {}, this._children["\0"][e] = true), this._in[e] = {}, this._preds[e] = {}, this._out[e] = {}, this._sucs[e] = {}, ++this._nodeCount, this);
  }
  node(e) {
    return this._nodes[e];
  }
  hasNode(e) {
    return e in this._nodes;
  }
  removeNode(e) {
    if (e in this._nodes) {
      let n = (t) => this.removeEdge(this._edgeObjs[t]);
      delete this._nodes[e], this._isCompound && (this._removeFromParentsChildList(e), delete this._parent[e], this.children(e).forEach((t) => {
        this.setParent(t);
      }), delete this._children[e]), Object.keys(this._in[e]).forEach(n), delete this._in[e], delete this._preds[e], Object.keys(this._out[e]).forEach(n), delete this._out[e], delete this._sucs[e], --this._nodeCount;
    }
    return this;
  }
  setParent(e, n) {
    if (!this._isCompound) throw new Error("Cannot set parent in a non-compound graph");
    if (n === void 0) n = "\0";
    else {
      n += "";
      for (let t = n; t !== void 0; t = this.parent(t)) if (t === e) throw new Error("Setting " + n + " as parent of " + e + " would create a cycle");
      this.setNode(n);
    }
    return this.setNode(e), this._removeFromParentsChildList(e), this._parent[e] = n, this._children[n][e] = true, this;
  }
  parent(e) {
    if (this._isCompound) {
      let n = this._parent[e];
      if (n !== "\0") return n;
    }
  }
  children(e = "\0") {
    if (this._isCompound) {
      let n = this._children[e];
      if (n) return Object.keys(n);
    } else {
      if (e === "\0") return this.nodes();
      if (this.hasNode(e)) return [];
    }
    return [];
  }
  predecessors(e) {
    let n = this._preds[e];
    if (n) return Object.keys(n);
  }
  successors(e) {
    let n = this._sucs[e];
    if (n) return Object.keys(n);
  }
  neighbors(e) {
    let n = this.predecessors(e);
    if (n) {
      let t = new Set(n);
      for (let r of this.successors(e)) t.add(r);
      return Array.from(t.values());
    }
  }
  isLeaf(e) {
    let n;
    return this.isDirected() ? n = this.successors(e) : n = this.neighbors(e), n.length === 0;
  }
  filterNodes(e) {
    let n = new this.constructor({ directed: this._isDirected, multigraph: this._isMultigraph, compound: this._isCompound });
    n.setGraph(this.graph()), Object.entries(this._nodes).forEach(([o, i2]) => {
      e(o) && n.setNode(o, i2);
    }), Object.values(this._edgeObjs).forEach((o) => {
      n.hasNode(o.v) && n.hasNode(o.w) && n.setEdge(o, this.edge(o));
    });
    let t = {}, r = (o) => {
      let i2 = this.parent(o);
      return !i2 || n.hasNode(i2) ? (t[o] = i2 != null ? i2 : void 0, i2 != null ? i2 : void 0) : i2 in t ? t[i2] : r(i2);
    };
    return this._isCompound && n.nodes().forEach((o) => n.setParent(o, r(o))), n;
  }
  setDefaultEdgeLabel(e) {
    return typeof e != "function" ? this._defaultEdgeLabelFn = () => e : this._defaultEdgeLabelFn = e, this;
  }
  edgeCount() {
    return this._edgeCount;
  }
  edges() {
    return Object.values(this._edgeObjs);
  }
  setPath(e, n) {
    return e.reduce((t, r) => (n !== void 0 ? this.setEdge(t, r, n) : this.setEdge(t, r), r)), this;
  }
  setEdge(e, n, t, r) {
    let o, i2, s, a, d = false;
    typeof e == "object" && e !== null && "v" in e ? (o = e.v, i2 = e.w, s = e.name, arguments.length === 2 && (a = n, d = true)) : (o = e, i2 = n, s = r, arguments.length > 2 && (a = t, d = true)), o = "" + o, i2 = "" + i2, s !== void 0 && (s = "" + s);
    let l = C(this._isDirected, o, i2, s);
    if (l in this._edgeLabels) return d && (this._edgeLabels[l] = a), this;
    if (s !== void 0 && !this._isMultigraph) throw new Error("Cannot set a named edge when isMultigraph = false");
    this.setNode(o), this.setNode(i2), this._edgeLabels[l] = d ? a : this._defaultEdgeLabelFn(o, i2, s);
    let u = gn(this._isDirected, o, i2, s);
    return o = u.v, i2 = u.w, Object.freeze(u), this._edgeObjs[l] = u, me(this._preds[i2], o), me(this._sucs[o], i2), this._in[i2][l] = u, this._out[o][l] = u, this._edgeCount++, this;
  }
  edge(e, n, t) {
    let r = arguments.length === 1 ? Y(this._isDirected, e) : C(this._isDirected, e, n, t);
    return this._edgeLabels[r];
  }
  edgeAsObj(e, n, t) {
    let r = arguments.length === 1 ? this.edge(e) : this.edge(e, n, t);
    return typeof r != "object" ? { label: r } : r;
  }
  hasEdge(e, n, t) {
    return (arguments.length === 1 ? Y(this._isDirected, e) : C(this._isDirected, e, n, t)) in this._edgeLabels;
  }
  removeEdge(e, n, t) {
    let r = arguments.length === 1 ? Y(this._isDirected, e) : C(this._isDirected, e, n, t), o = this._edgeObjs[r];
    if (o) {
      let i2 = o.v, s = o.w;
      delete this._edgeLabels[r], delete this._edgeObjs[r], Ee(this._preds[s], i2), Ee(this._sucs[i2], s), delete this._in[s][r], delete this._out[i2][r], this._edgeCount--;
    }
    return this;
  }
  inEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._in[e], e, n) : this.nodeEdges(e, n);
  }
  outEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._out[e], e, n) : this.nodeEdges(e, n);
  }
  nodeEdges(e, n) {
    if (e in this._nodes) return this.filterEdges({ ...this._in[e], ...this._out[e] }, e, n);
  }
  _removeFromParentsChildList(e) {
    delete this._children[this._parent[e]][e];
  }
  filterEdges(e, n, t) {
    if (!e) return;
    let r = Object.values(e);
    return t ? r.filter((o) => o.v === n && o.w === t || o.v === t && o.w === n) : r;
  }
};
function me(e, n) {
  e[n] ? e[n]++ : e[n] = 1;
}
function Ee(e, n) {
  e[n] !== void 0 && !--e[n] && delete e[n];
}
function C(e, n, t, r) {
  let o = "" + n, i2 = "" + t;
  if (!e && o > i2) {
    let s = o;
    o = i2, i2 = s;
  }
  return o + "" + i2 + "" + (r === void 0 ? "\0" : r);
}
function gn(e, n, t, r) {
  let o = "" + n, i2 = "" + t;
  if (!e && o > i2) {
    let a = o;
    o = i2, i2 = a;
  }
  let s = { v: o, w: i2 };
  return r && (s.name = r), s;
}
function Y(e, n) {
  return C(e, n.v, n.w, n.name);
}
var pn = "4.0.1";
var ye = {};
Le(ye, { read: () => yn, write: () => mn });
function mn(e) {
  let n = { options: { directed: e.isDirected(), multigraph: e.isMultigraph(), compound: e.isCompound() }, nodes: En(e), edges: Ln(e) }, t = e.graph();
  return t !== void 0 && (n.value = structuredClone(t)), n;
}
function En(e) {
  return e.nodes().map((n) => {
    let t = e.node(n), r = e.parent(n), o = { v: n };
    return t !== void 0 && (o.value = t), r !== void 0 && (o.parent = r), o;
  });
}
function Ln(e) {
  return e.edges().map((n) => {
    let t = e.edge(n), r = { v: n.v, w: n.w };
    return n.name !== void 0 && (r.name = n.name), t !== void 0 && (r.value = t), r;
  });
}
function yn(e) {
  let n = new p(e.options);
  return e.value !== void 0 && n.setGraph(e.value), e.nodes.forEach((t) => {
    n.setNode(t.v, t.value), t.parent && n.setParent(t.v, t.parent);
  }), e.edges.forEach((t) => {
    n.setEdge({ v: t.v, w: t.w, name: t.name }, t.value);
  }), n;
}
var R = {};
Le(R, { CycleException: () => D, bellmanFord: () => we, components: () => Gn, dijkstra: () => F, dijkstraAll: () => _n, findCycles: () => xn, floydWarshall: () => On, isAcyclic: () => Cn, postorder: () => Pn, preorder: () => Mn, prim: () => jn, shortestPaths: () => Sn, tarjan: () => Ge, topsort: () => ke });
var wn = () => 1;
function we(e, n, t, r) {
  return Nn(e, String(n), t || wn, r || function(o) {
    return e.outEdges(o);
  });
}
function Nn(e, n, t, r) {
  let o = {}, i2, s = 0, a = e.nodes(), d = function(c) {
    let h = t(c);
    o[c.v].distance + h < o[c.w].distance && (o[c.w] = { distance: o[c.v].distance + h, predecessor: c.v }, i2 = true);
  }, l = function() {
    a.forEach(function(c) {
      r(c).forEach(function(h) {
        let f = h.v === c ? h.v : h.w, g = f === h.v ? h.w : h.v;
        d({ v: f, w: g });
      });
    });
  };
  a.forEach(function(c) {
    let h = c === n ? 0 : Number.POSITIVE_INFINITY;
    o[c] = { distance: h, predecessor: "" };
  });
  let u = a.length;
  for (let c = 1; c < u && (i2 = false, s++, l(), !!i2); c++) ;
  if (s === u - 1 && (i2 = false, l(), i2)) throw new Error("The graph contains a negative weight cycle");
  return o;
}
function Gn(e) {
  let n = {}, t = [], r;
  function o(i2) {
    i2 in n || (n[i2] = true, r.push(i2), e.successors(i2).forEach(o), e.predecessors(i2).forEach(o));
  }
  return e.nodes().forEach(function(i2) {
    r = [], o(i2), r.length && t.push(r);
  }), t;
}
var Ne = class {
  constructor() {
    this._arr = [], this._keyIndices = {};
  }
  size() {
    return this._arr.length;
  }
  keys() {
    return this._arr.map((e) => e.key);
  }
  has(e) {
    return e in this._keyIndices;
  }
  priority(e) {
    let n = this._keyIndices[e];
    if (n !== void 0) return this._arr[n].priority;
  }
  min() {
    if (this.size() === 0) throw new Error("Queue underflow");
    return this._arr[0].key;
  }
  add(e, n) {
    let t = this._keyIndices, r = String(e);
    if (!(r in t)) {
      let o = this._arr, i2 = o.length;
      return t[r] = i2, o.push({ key: r, priority: n }), this._decrease(i2), true;
    }
    return false;
  }
  removeMin() {
    this._swap(0, this._arr.length - 1);
    let e = this._arr.pop();
    return delete this._keyIndices[e.key], this._heapify(0), e.key;
  }
  decrease(e, n) {
    let t = this._keyIndices[e];
    if (t === void 0) throw new Error(`Key not found: ${e}`);
    let r = this._arr[t].priority;
    if (n > r) throw new Error(`New priority is greater than current priority. Key: ${e} Old: ${r} New: ${n}`);
    this._arr[t].priority = n, this._decrease(t);
  }
  _heapify(e) {
    let n = this._arr, t = 2 * e, r = t + 1, o = e;
    t < n.length && (o = n[t].priority < n[o].priority ? t : o, r < n.length && (o = n[r].priority < n[o].priority ? r : o), o !== e && (this._swap(e, o), this._heapify(o)));
  }
  _decrease(e) {
    let n = this._arr, t = n[e].priority, r;
    for (; e !== 0 && (r = e >> 1, !(n[r].priority < t)); ) this._swap(e, r), e = r;
  }
  _swap(e, n) {
    let t = this._arr, r = this._keyIndices, o = t[e], i2 = t[n];
    t[e] = i2, t[n] = o, r[i2.key] = e, r[o.key] = n;
  }
};
var kn = () => 1;
function F(e, n, t, r) {
  let o = function(i2) {
    return e.outEdges(i2);
  };
  return vn(e, String(n), t || kn, r || o);
}
function vn(e, n, t, r) {
  let o = {}, i2 = new Ne(), s, a, d = function(l) {
    let u = l.v !== s ? l.v : l.w, c = o[u], h = t(l), f = a.distance + h;
    if (h < 0) throw new Error("dijkstra does not allow negative edge weights. Bad edge: " + l + " Weight: " + h);
    f < c.distance && (c.distance = f, c.predecessor = s, i2.decrease(u, f));
  };
  for (e.nodes().forEach(function(l) {
    let u = l === n ? 0 : Number.POSITIVE_INFINITY;
    o[l] = { distance: u, predecessor: "" }, i2.add(l, u);
  }); i2.size() > 0 && (s = i2.removeMin(), a = o[s], a.distance !== Number.POSITIVE_INFINITY); ) r(s).forEach(d);
  return o;
}
function _n(e, n, t) {
  return e.nodes().reduce(function(r, o) {
    return r[o] = F(e, o, n, t), r;
  }, {});
}
function Ge(e) {
  let n = 0, t = [], r = {}, o = [];
  function i2(s) {
    let a = r[s] = { onStack: true, lowlink: n, index: n++ };
    if (t.push(s), e.successors(s).forEach(function(d) {
      d in r ? r[d].onStack && (a.lowlink = Math.min(a.lowlink, r[d].index)) : (i2(d), a.lowlink = Math.min(a.lowlink, r[d].lowlink));
    }), a.lowlink === a.index) {
      let d = [], l;
      do
        l = t.pop(), r[l].onStack = false, d.push(l);
      while (s !== l);
      o.push(d);
    }
  }
  return e.nodes().forEach(function(s) {
    s in r || i2(s);
  }), o;
}
function xn(e) {
  return Ge(e).filter(function(n) {
    return n.length > 1 || n.length === 1 && e.hasEdge(n[0], n[0]);
  });
}
var Tn = () => 1;
function On(e, n, t) {
  return In(e, n || Tn, t || function(r) {
    return e.outEdges(r);
  });
}
function In(e, n, t) {
  let r = {}, o = e.nodes();
  return o.forEach(function(i2) {
    r[i2] = {}, r[i2][i2] = { distance: 0, predecessor: "" }, o.forEach(function(s) {
      i2 !== s && (r[i2][s] = { distance: Number.POSITIVE_INFINITY, predecessor: "" });
    }), t(i2).forEach(function(s) {
      let a = s.v === i2 ? s.w : s.v, d = n(s);
      r[i2][a] = { distance: d, predecessor: i2 };
    });
  }), o.forEach(function(i2) {
    let s = r[i2];
    o.forEach(function(a) {
      let d = r[a];
      o.forEach(function(l) {
        let u = d[i2], c = s[l], h = d[l], f = u.distance + c.distance;
        f < h.distance && (h.distance = f, h.predecessor = c.predecessor);
      });
    });
  }), r;
}
var D = class extends Error {
  constructor(...e) {
    super(...e);
  }
};
function ke(e) {
  let n = {}, t = {}, r = [];
  function o(i2) {
    if (i2 in t) throw new D();
    i2 in n || (t[i2] = true, n[i2] = true, e.predecessors(i2).forEach(o), delete t[i2], r.push(i2));
  }
  if (e.sinks().forEach(o), Object.keys(n).length !== e.nodeCount()) throw new D();
  return r;
}
function Cn(e) {
  try {
    ke(e);
  } catch (n) {
    if (n instanceof D) return false;
    throw n;
  }
  return true;
}
function Rn(e, n, t, r, o) {
  Array.isArray(n) || (n = [n]);
  let i2 = ((a) => {
    var d;
    return (d = e.isDirected() ? e.successors(a) : e.neighbors(a)) != null ? d : [];
  }), s = {};
  return n.forEach(function(a) {
    if (!e.hasNode(a)) throw new Error("Graph does not have node: " + a);
    o = ve(e, a, t === "post", s, i2, r, o);
  }), o;
}
function ve(e, n, t, r, o, i2, s) {
  return n in r || (r[n] = true, t || (s = i2(s, n)), o(n).forEach(function(a) {
    s = ve(e, a, t, r, o, i2, s);
  }), t && (s = i2(s, n))), s;
}
function _e(e, n, t) {
  return Rn(e, n, t, function(r, o) {
    return r.push(o), r;
  }, []);
}
function Pn(e, n) {
  return _e(e, n, "post");
}
function Mn(e, n) {
  return _e(e, n, "pre");
}
function jn(e, n) {
  let t = new p(), r = {}, o = new Ne(), i2;
  function s(d) {
    let l = d.v === i2 ? d.w : d.v, u = o.priority(l);
    if (u !== void 0) {
      let c = n(d);
      c < u && (r[l] = i2, o.decrease(l, c));
    }
  }
  if (e.nodeCount() === 0) return t;
  e.nodes().forEach(function(d) {
    o.add(d, Number.POSITIVE_INFINITY), t.setNode(d);
  }), o.decrease(e.nodes()[0], 0);
  let a = false;
  for (; o.size() > 0; ) {
    if (i2 = o.removeMin(), i2 in r) t.setEdge(i2, r[i2]);
    else {
      if (a) throw new Error("Input graph is not connected: " + e);
      a = true;
    }
    e.nodeEdges(i2).forEach(s);
  }
  return t;
}
function Sn(e, n, t, r) {
  return Fn(e, n, t, r != null ? r : ((o) => {
    let i2 = e.outEdges(o);
    return i2 != null ? i2 : [];
  }));
}
function Fn(e, n, t, r) {
  if (t === void 0) return F(e, n, t, r);
  let o = false, i2 = e.nodes();
  for (let s = 0; s < i2.length; s++) {
    let a = r(i2[s]);
    for (let d = 0; d < a.length; d++) {
      let l = a[d], u = l.v === i2[s] ? l.v : l.w, c = u === l.v ? l.w : l.v;
      t({ v: u, w: c }) < 0 && (o = true);
    }
    if (o) return we(e, n, t, r);
  }
  return F(e, n, t, r);
}
function w(e, n, t, r) {
  let o = r;
  for (; e.hasNode(o); ) o = j(r);
  return t.dummy = n, e.setNode(o, t), o;
}
function xe(e) {
  let n = new p().setGraph(e.graph());
  return e.nodes().forEach((t) => n.setNode(t, e.node(t))), e.edges().forEach((t) => {
    let r = n.edge(t.v, t.w) || { weight: 0, minlen: 1 }, o = e.edge(t);
    n.setEdge(t.v, t.w, { weight: r.weight + o.weight, minlen: Math.max(r.minlen, o.minlen) });
  }), n;
}
function A(e) {
  let n = new p({ multigraph: e.isMultigraph() }).setGraph(e.graph());
  return e.nodes().forEach((t) => {
    e.children(t).length || n.setNode(t, e.node(t));
  }), e.edges().forEach((t) => {
    n.setEdge(t, e.edge(t));
  }), n;
}
function H(e, n) {
  let t = e.x, r = e.y, o = n.x - t, i2 = n.y - r, s = e.width / 2, a = e.height / 2;
  if (!o && !i2) throw new Error("Not possible to find intersection inside of the rectangle");
  let d, l;
  return Math.abs(i2) * s > Math.abs(o) * a ? (i2 < 0 && (a = -a), d = a * o / i2, l = a) : (o < 0 && (s = -s), d = s, l = s * i2 / o), { x: t + d, y: r + l };
}
function N(e) {
  let n = k(X(e) + 1).map(() => []);
  return e.nodes().forEach((t) => {
    let r = e.node(t), o = r.rank;
    o !== void 0 && (n[o] || (n[o] = []), n[o][r.order] = t);
  }), n;
}
function Te(e) {
  let n = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === void 0 ? Number.MAX_VALUE : o;
  }), t = L(Math.min, n);
  e.nodes().forEach((r) => {
    let o = e.node(r);
    Object.hasOwn(o, "rank") && (o.rank -= t);
  });
}
function Oe(e) {
  let n = e.nodes().map((s) => e.node(s).rank).filter((s) => s !== void 0), t = L(Math.min, n), r = [];
  e.nodes().forEach((s) => {
    let a = e.node(s).rank - t;
    r[a] || (r[a] = []), r[a].push(s);
  });
  let o = 0, i2 = e.graph().nodeRankFactor;
  Array.from(r).forEach((s, a) => {
    s === void 0 && a % i2 !== 0 ? --o : s !== void 0 && o && s.forEach((d) => e.node(d).rank += o);
  });
}
function q(e, n, t, r) {
  let o = { width: 0, height: 0 };
  return arguments.length >= 4 && (o.rank = t, o.order = r), w(e, "border", o, n);
}
function Dn(e, n = Ie) {
  let t = [];
  for (let r = 0; r < e.length; r += n) {
    let o = e.slice(r, r + n);
    t.push(o);
  }
  return t;
}
var Ie = 65535;
function L(e, n) {
  if (n.length > Ie) {
    let t = Dn(n);
    return e(...t.map((r) => e(...r)));
  } else return e(...n);
}
function X(e) {
  let t = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === void 0 ? Number.MIN_VALUE : o;
  });
  return L(Math.max, t);
}
function Ce(e, n) {
  let t = { lhs: [], rhs: [] };
  return e.forEach((r) => {
    n(r) ? t.lhs.push(r) : t.rhs.push(r);
  }), t;
}
function P(e, n) {
  let t = Date.now();
  try {
    return n();
  } finally {
    console.log(e + " time: " + (Date.now() - t) + "ms");
  }
}
function M(e, n) {
  return n();
}
var An = 0;
function j(e) {
  let n = ++An;
  return e + ("" + n);
}
function k(e, n, t = 1) {
  n == null && (n = e, e = 0);
  let r = (i2) => i2 < n;
  t < 0 && (r = (i2) => n < i2);
  let o = [];
  for (let i2 = e; r(i2); i2 += t) o.push(i2);
  return o;
}
function T(e, n) {
  let t = {};
  for (let r of n) e[r] !== void 0 && (t[r] = e[r]);
  return t;
}
function O(e, n) {
  let t;
  return typeof n == "string" ? t = (r) => r[n] : t = n, Object.entries(e).reduce((r, [o, i2]) => (r[o] = t(i2, o), r), {});
}
function Re(e, n) {
  return e.reduce((t, r, o) => (t[r] = n[o], t), {});
}
var _ = "\0";
var U = "3.0.0";
var K = class {
  constructor() {
    pe(this, "_sentinel");
    let n = {};
    n._next = n._prev = n, this._sentinel = n;
  }
  dequeue() {
    let n = this._sentinel, t = n._prev;
    if (t !== n) return Pe(t), t;
  }
  enqueue(n) {
    let t = this._sentinel;
    n._prev && n._next && Pe(n), n._next = t._next, t._next._prev = n, t._next = n, n._prev = t;
  }
  toString() {
    let n = [], t = this._sentinel, r = t._prev;
    for (; r !== t; ) n.push(JSON.stringify(r, Vn)), r = r._prev;
    return "[" + n.join(", ") + "]";
  }
};
function Pe(e) {
  e._prev._next = e._next, e._next._prev = e._prev, delete e._next, delete e._prev;
}
function Vn(e, n) {
  if (e !== "_next" && e !== "_prev") return n;
}
var Me = K;
var Wn = () => 1;
function Q(e, n) {
  if (e.nodeCount() <= 1) return [];
  let t = Yn(e, n || Wn);
  return Bn(t.graph, t.buckets, t.zeroIdx).flatMap((o) => e.outEdges(o.v, o.w) || []);
}
function Bn(e, n, t) {
  var a;
  let r = [], o = n[n.length - 1], i2 = n[0], s;
  for (; e.nodeCount(); ) {
    for (; s = i2.dequeue(); ) $(e, n, t, s);
    for (; s = o.dequeue(); ) $(e, n, t, s);
    if (e.nodeCount()) {
      for (let d = n.length - 2; d > 0; --d) if (s = (a = n[d]) == null ? void 0 : a.dequeue(), s) {
        r = r.concat($(e, n, t, s, true) || []);
        break;
      }
    }
  }
  return r;
}
function $(e, n, t, r, o) {
  let i2 = [], s = o ? i2 : void 0;
  return (e.inEdges(r.v) || []).forEach((a) => {
    let d = e.edge(a), l = e.node(a.v);
    o && i2.push({ v: a.v, w: a.w }), l.out -= d, J(n, t, l);
  }), (e.outEdges(r.v) || []).forEach((a) => {
    let d = e.edge(a), l = a.w, u = e.node(l);
    u.in -= d, J(n, t, u);
  }), e.removeNode(r.v), s;
}
function Yn(e, n) {
  let t = new p(), r = 0, o = 0;
  e.nodes().forEach((a) => {
    t.setNode(a, { v: a, in: 0, out: 0 });
  }), e.edges().forEach((a) => {
    let d = t.edge(a.v, a.w) || 0, l = n(a), u = d + l;
    t.setEdge(a.v, a.w, u);
    let c = t.node(a.v), h = t.node(a.w);
    o = Math.max(o, c.out += l), r = Math.max(r, h.in += l);
  });
  let i2 = zn(o + r + 3).map(() => new Me()), s = r + 1;
  return t.nodes().forEach((a) => {
    J(i2, s, t.node(a));
  }), { graph: t, buckets: i2, zeroIdx: s };
}
function J(e, n, t) {
  var r, o, i2;
  t.out ? t.in ? (i2 = e[t.out - t.in + n]) == null || i2.enqueue(t) : (o = e[e.length - 1]) == null || o.enqueue(t) : (r = e[0]) == null || r.enqueue(t);
}
function zn(e) {
  let n = [];
  for (let t = 0; t < e; t++) n.push(t);
  return n;
}
function je(e) {
  (e.graph().acyclicer === "greedy" ? Q(e, t(e)) : Hn(e)).forEach((r) => {
    let o = e.edge(r);
    e.removeEdge(r), o.forwardName = r.name, o.reversed = true, e.setEdge(r.w, r.v, o, j("rev"));
  });
  function t(r) {
    return (o) => r.edge(o).weight;
  }
}
function Hn(e) {
  let n = [], t = {}, r = {};
  function o(i2) {
    Object.hasOwn(r, i2) || (r[i2] = true, t[i2] = true, e.outEdges(i2).forEach((s) => {
      Object.hasOwn(t, s.w) ? n.push(s) : o(s.w);
    }), delete t[i2]);
  }
  return e.nodes().forEach(o), n;
}
function Se(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.reversed) {
      e.removeEdge(n);
      let r = t.forwardName;
      delete t.reversed, delete t.forwardName, e.setEdge(n.w, n.v, t, r);
    }
  });
}
function Fe(e) {
  e.graph().dummyChains = [], e.edges().forEach((n) => Xn(e, n));
}
function Xn(e, n) {
  let t = n.v, r = e.node(t).rank, o = n.w, i2 = e.node(o).rank, s = n.name, a = e.edge(n), d = a.labelRank;
  if (i2 === r + 1) return;
  e.removeEdge(n);
  let l, u, c;
  for (c = 0, ++r; r < i2; ++c, ++r) a.points = [], u = { width: 0, height: 0, edgeLabel: a, edgeObj: n, rank: r }, l = w(e, "edge", u, "_d"), r === d && (u.width = a.width, u.height = a.height, u.dummy = "edge-label", u.labelpos = a.labelpos), e.setEdge(t, l, { weight: a.weight }, s), c === 0 && e.graph().dummyChains.push(l), t = l;
  e.setEdge(t, o, { weight: a.weight }, s);
}
function De(e) {
  e.graph().dummyChains.forEach((n) => {
    let t = e.node(n), r = t.edgeLabel, o;
    for (e.setEdge(t.edgeObj, r); t.dummy; ) o = e.successors(n)[0], e.removeNode(n), r.points.push({ x: t.x, y: t.y }), t.dummy === "edge-label" && (r.x = t.x, r.y = t.y, r.width = t.width, r.height = t.height), n = o, t = e.node(n);
  });
}
function S(e) {
  let n = {};
  function t(r) {
    let o = e.node(r);
    if (Object.hasOwn(n, r)) return o.rank;
    n[r] = true;
    let i2 = e.outEdges(r), s = i2 ? i2.map((d) => d == null ? Number.POSITIVE_INFINITY : t(d.w) - e.edge(d).minlen) : [], a = L(Math.min, s);
    return a === Number.POSITIVE_INFINITY && (a = 0), o.rank = a;
  }
  e.sources().forEach(t);
}
function v(e, n) {
  return e.node(n.w).rank - e.node(n.v).rank - e.edge(n).minlen;
}
var V = Kn;
function Kn(e) {
  let n = new p({ directed: false }), t = e.nodes();
  if (t.length === 0) throw new Error("Graph must have at least one node");
  let r = t[0], o = e.nodeCount();
  n.setNode(r, {});
  let i2, s;
  for (; $n(n, e) < o && (i2 = Jn(n, e), !!i2); ) s = n.hasNode(i2.v) ? v(e, i2) : -v(e, i2), Qn(n, e, s);
  return n;
}
function $n(e, n) {
  function t(r) {
    let o = n.nodeEdges(r);
    o && o.forEach((i2) => {
      let s = i2.v, a = r === s ? i2.w : s;
      !e.hasNode(a) && !v(n, i2) && (e.setNode(a, {}), e.setEdge(r, a, {}), t(a));
    });
  }
  return e.nodes().forEach(t), e.nodeCount();
}
function Jn(e, n) {
  return n.edges().reduce((r, o) => {
    let i2 = Number.POSITIVE_INFINITY;
    return e.hasNode(o.v) !== e.hasNode(o.w) && (i2 = v(n, o)), i2 < r[0] ? [i2, o] : r;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function Qn(e, n, t) {
  e.nodes().forEach((r) => n.node(r).rank += t);
}
var { preorder: Zn, postorder: et } = R;
var Ve = x;
x.initLowLimValues = ee;
x.initCutValues = Z;
x.calcCutValue = We;
x.leaveEdge = Ye;
x.enterEdge = ze;
x.exchangeEdges = He;
function x(e) {
  e = xe(e), S(e);
  let n = V(e);
  ee(n), Z(n, e);
  let t, r;
  for (; t = Ye(n); ) r = ze(n, e, t), He(n, e, t, r);
}
function Z(e, n) {
  let t = et(e, e.nodes());
  t = t.slice(0, t.length - 1), t.forEach((r) => nt(e, n, r));
}
function nt(e, n, t) {
  let o = e.node(t).parent, i2 = e.edge(t, o);
  i2.cutvalue = We(e, n, t);
}
function We(e, n, t) {
  let o = e.node(t).parent, i2 = true, s = n.edge(t, o), a = 0;
  s || (i2 = false, s = n.edge(o, t)), a = s.weight;
  let d = n.nodeEdges(t);
  return d && d.forEach((l) => {
    let u = l.v === t, c = u ? l.w : l.v;
    if (c !== o) {
      let h = u === i2, f = n.edge(l).weight;
      if (a += h ? f : -f, rt(e, t, c)) {
        let b = e.edge(t, c).cutvalue;
        a += h ? -b : b;
      }
    }
  }), a;
}
function ee(e, n) {
  arguments.length < 2 && (n = e.nodes()[0]), Be(e, {}, 1, n);
}
function Be(e, n, t, r, o) {
  let i2 = t, s = e.node(r);
  n[r] = true;
  let a = e.neighbors(r);
  return a && a.forEach((d) => {
    Object.hasOwn(n, d) || (t = Be(e, n, t, d, r));
  }), s.low = i2, s.lim = t++, o ? s.parent = o : delete s.parent, t;
}
function Ye(e) {
  return e.edges().find((n) => e.edge(n).cutvalue < 0);
}
function ze(e, n, t) {
  let r = t.v, o = t.w;
  n.hasEdge(r, o) || (r = t.w, o = t.v);
  let i2 = e.node(r), s = e.node(o), a = i2, d = false;
  return i2.lim > s.lim && (a = s, d = true), n.edges().filter((u) => d === Ae(e, e.node(u.v), a) && d !== Ae(e, e.node(u.w), a)).reduce((u, c) => v(n, c) < v(n, u) ? c : u);
}
function He(e, n, t, r) {
  let o = t.v, i2 = t.w;
  e.removeEdge(o, i2), e.setEdge(r.v, r.w, {}), ee(e), Z(e, n), tt(e, n);
}
function tt(e, n) {
  let t = e.nodes().find((o) => !e.node(o).parent);
  if (!t) return;
  let r = Zn(e, [t]);
  r = r.slice(1), r.forEach((o) => {
    let s = e.node(o).parent, a = n.edge(o, s), d = false;
    a || (a = n.edge(s, o), d = true), n.node(o).rank = n.node(s).rank + (d ? a.minlen : -a.minlen);
  });
}
function rt(e, n, t) {
  return e.hasEdge(n, t);
}
function Ae(e, n, t) {
  return t.low <= n.lim && n.lim <= t.lim;
}
var Xe = ot;
function ot(e) {
  let n = e.graph().ranker;
  if (typeof n == "function") return n(e);
  switch (n) {
    case "network-simplex":
      qe(e);
      break;
    case "tight-tree":
      st(e);
      break;
    case "longest-path":
      it(e);
      break;
    case "none":
      break;
    default:
      qe(e);
  }
}
var it = S;
function st(e) {
  S(e), V(e);
}
function qe(e) {
  Ve(e);
}
var Ue = at;
function at(e) {
  let n = lt(e);
  e.graph().dummyChains.forEach((t) => {
    let r = e.node(t), o = r.edgeObj, i2 = dt(e, n, o.v, o.w), s = i2.path, a = i2.lca, d = 0, l = s[d], u = true;
    for (; t !== o.w; ) {
      if (r = e.node(t), u) {
        for (; (l = s[d]) !== a && e.node(l).maxRank < r.rank; ) d++;
        l === a && (u = false);
      }
      if (!u) {
        for (; d < s.length - 1 && e.node(s[d + 1]).minRank <= r.rank; ) d++;
        l = s[d];
      }
      l !== void 0 && e.setParent(t, l), t = e.successors(t)[0];
    }
  });
}
function dt(e, n, t, r) {
  let o = [], i2 = [], s = Math.min(n[t].low, n[r].low), a = Math.max(n[t].lim, n[r].lim), d;
  d = t;
  do
    d = e.parent(d), o.push(d);
  while (d && (n[d].low > s || a > n[d].lim));
  let l = d, u = r;
  for (; (u = e.parent(u)) !== l; ) i2.push(u);
  return { path: o.concat(i2.reverse()), lca: l };
}
function lt(e) {
  let n = {}, t = 0;
  function r(o) {
    let i2 = t;
    e.children(o).forEach(r), n[o] = { low: i2, lim: t++ };
  }
  return e.children(_).forEach(r), n;
}
function Ke(e) {
  let n = w(e, "root", {}, "_root"), t = ut(e), r = Object.values(t), o = L(Math.max, r) - 1, i2 = 2 * o + 1;
  e.graph().nestingRoot = n, e.edges().forEach((a) => e.edge(a).minlen *= i2);
  let s = ct(e) + 1;
  e.children(_).forEach((a) => $e(e, n, i2, s, o, t, a)), e.graph().nodeRankFactor = i2;
}
function $e(e, n, t, r, o, i2, s) {
  var c;
  let a = e.children(s);
  if (!a.length) {
    s !== n && e.setEdge(n, s, { weight: 0, minlen: t });
    return;
  }
  let d = q(e, "_bt"), l = q(e, "_bb"), u = e.node(s);
  e.setParent(d, s), u.borderTop = d, e.setParent(l, s), u.borderBottom = l, a.forEach((h) => {
    var y;
    $e(e, n, t, r, o, i2, h);
    let f = e.node(h), g = f.borderTop ? f.borderTop : h, b = f.borderBottom ? f.borderBottom : h, m = f.borderTop ? r : 2 * r, E = g !== b ? 1 : o - ((y = i2[s]) != null ? y : 0) + 1;
    e.setEdge(d, g, { weight: m, minlen: E, nestingEdge: true }), e.setEdge(b, l, { weight: m, minlen: E, nestingEdge: true });
  }), e.parent(s) || e.setEdge(n, d, { weight: 0, minlen: o + ((c = i2[s]) != null ? c : 0) });
}
function ut(e) {
  let n = {};
  function t(r, o) {
    let i2 = e.children(r);
    i2 && i2.length && i2.forEach((s) => t(s, o + 1)), n[r] = o;
  }
  return e.children(_).forEach((r) => t(r, 1)), n;
}
function ct(e) {
  return e.edges().reduce((n, t) => n + e.edge(t).weight, 0);
}
function Je(e) {
  let n = e.graph();
  e.removeNode(n.nestingRoot), delete n.nestingRoot, e.edges().forEach((t) => {
    e.edge(t).nestingEdge && e.removeEdge(t);
  });
}
var Ze = ft;
function ft(e) {
  function n(t) {
    let r = e.children(t), o = e.node(t);
    if (r.length && r.forEach(n), Object.hasOwn(o, "minRank")) {
      o.borderLeft = [], o.borderRight = [];
      for (let i2 = o.minRank, s = o.maxRank + 1; i2 < s; ++i2) Qe(e, "borderLeft", "_bl", t, o, i2), Qe(e, "borderRight", "_br", t, o, i2);
    }
  }
  e.children(_).forEach(n);
}
function Qe(e, n, t, r, o, i2) {
  let s = { width: 0, height: 0, rank: i2, borderType: n }, a = o[n][i2 - 1], d = w(e, "border", s, t);
  o[n][i2] = d, e.setParent(d, r), a && e.setEdge(a, d, { weight: 1 });
}
function nn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? void 0 : t.toLowerCase();
  (n === "lr" || n === "rl") && rn(e);
}
function tn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? void 0 : t.toLowerCase();
  (n === "bt" || n === "rl") && bt(e), (n === "lr" || n === "rl") && (gt(e), rn(e));
}
function rn(e) {
  e.nodes().forEach((n) => en(e.node(n))), e.edges().forEach((n) => en(e.edge(n)));
}
function en(e) {
  let n = e.width;
  e.width = e.height, e.height = n;
}
function bt(e) {
  e.nodes().forEach((n) => ne(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(ne), Object.hasOwn(t, "y") && ne(t);
  });
}
function ne(e) {
  e.y = -e.y;
}
function gt(e) {
  e.nodes().forEach((n) => te(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(te), Object.hasOwn(t, "x") && te(t);
  });
}
function te(e) {
  let n = e.x;
  e.x = e.y, e.y = n;
}
function re(e) {
  let n = {}, t = e.nodes().filter((d) => !e.children(d).length), r = t.map((d) => e.node(d).rank), o = L(Math.max, r), i2 = k(o + 1).map(() => []);
  function s(d) {
    if (n[d]) return;
    n[d] = true;
    let l = e.node(d);
    i2[l.rank].push(d);
    let u = e.successors(d);
    u && u.forEach(s);
  }
  return t.sort((d, l) => e.node(d).rank - e.node(l).rank).forEach(s), i2;
}
function oe(e, n) {
  let t = 0;
  for (let r = 1; r < n.length; ++r) t += mt(e, n[r - 1], n[r]);
  return t;
}
function mt(e, n, t) {
  let r = Re(t, t.map((l, u) => u)), o = n.flatMap((l) => {
    let u = e.outEdges(l);
    return u ? u.map((c) => ({ pos: r[c.w], weight: e.edge(c).weight })).sort((c, h) => c.pos - h.pos) : [];
  }), i2 = 1;
  for (; i2 < t.length; ) i2 <<= 1;
  let s = 2 * i2 - 1;
  i2 -= 1;
  let a = new Array(s).fill(0), d = 0;
  return o.forEach((l) => {
    let u = l.pos + i2;
    a[u] += l.weight;
    let c = 0;
    for (; u > 0; ) u % 2 && (c += a[u + 1]), u = u - 1 >> 1, a[u] += l.weight;
    d += l.weight * c;
  }), d;
}
function ie(e, n = []) {
  return n.map((t) => {
    let r = e.inEdges(t);
    if (!r || !r.length) return { v: t };
    {
      let o = r.reduce((i2, s) => {
        let a = e.edge(s), d = e.node(s.v);
        return { sum: i2.sum + a.weight * d.order, weight: i2.weight + a.weight };
      }, { sum: 0, weight: 0 });
      return { v: t, barycenter: o.sum / o.weight, weight: o.weight };
    }
  });
}
function se(e, n) {
  let t = {};
  e.forEach((o, i2) => {
    let s = { indegree: 0, in: [], out: [], vs: [o.v], i: i2 };
    o.barycenter !== void 0 && (s.barycenter = o.barycenter, s.weight = o.weight), t[o.v] = s;
  }), n.edges().forEach((o) => {
    let i2 = t[o.v], s = t[o.w];
    i2 !== void 0 && s !== void 0 && (s.indegree++, i2.out.push(s));
  });
  let r = Object.values(t).filter((o) => !o.indegree);
  return Et(r);
}
function Et(e) {
  let n = [];
  function t(o) {
    return (i2) => {
      i2.merged || (i2.barycenter === void 0 || o.barycenter === void 0 || i2.barycenter >= o.barycenter) && Lt(o, i2);
    };
  }
  function r(o) {
    return (i2) => {
      i2.in.push(o), --i2.indegree === 0 && e.push(i2);
    };
  }
  for (; e.length; ) {
    let o = e.pop();
    n.push(o), o.in.reverse().forEach(t(o)), o.out.forEach(r(o));
  }
  return n.filter((o) => !o.merged).map((o) => T(o, ["vs", "i", "barycenter", "weight"]));
}
function Lt(e, n) {
  let t = 0, r = 0;
  e.weight && (t += e.barycenter * e.weight, r += e.weight), n.weight && (t += n.barycenter * n.weight, r += n.weight), e.vs = n.vs.concat(e.vs), e.barycenter = t / r, e.weight = r, e.i = Math.min(n.i, e.i), n.merged = true;
}
function ae(e, n) {
  let t = Ce(e, (u) => Object.hasOwn(u, "barycenter")), r = t.lhs, o = t.rhs.sort((u, c) => c.i - u.i), i2 = [], s = 0, a = 0, d = 0;
  r.sort(yt(!!n)), d = on(i2, o, d), r.forEach((u) => {
    d += u.vs.length, i2.push(u.vs), s += u.barycenter * u.weight, a += u.weight, d = on(i2, o, d);
  });
  let l = { vs: i2.flat(1) };
  return a && (l.barycenter = s / a, l.weight = a), l;
}
function on(e, n, t) {
  let r;
  for (; n.length && (r = n[n.length - 1]).i <= t; ) n.pop(), e.push(r.vs), t++;
  return t;
}
function yt(e) {
  return (n, t) => n.barycenter < t.barycenter ? -1 : n.barycenter > t.barycenter ? 1 : e ? t.i - n.i : n.i - t.i;
}
function W(e, n, t, r) {
  let o = e.children(n), i2 = e.node(n), s = i2 ? i2.borderLeft : void 0, a = i2 ? i2.borderRight : void 0, d = {};
  s && (o = o.filter((h) => h !== s && h !== a));
  let l = ie(e, o);
  l.forEach((h) => {
    if (e.children(h.v).length) {
      let f = W(e, h.v, t, r);
      d[h.v] = f, Object.hasOwn(f, "barycenter") && Nt(h, f);
    }
  });
  let u = se(l, t);
  wt(u, d);
  let c = ae(u, r);
  if (s && a) {
    c.vs = [s, c.vs, a].flat(1);
    let h = e.predecessors(s);
    if (h && h.length) {
      let f = e.node(h[0]), g = e.predecessors(a), b = e.node(g[0]);
      Object.hasOwn(c, "barycenter") || (c.barycenter = 0, c.weight = 0), c.barycenter = (c.barycenter * c.weight + f.order + b.order) / (c.weight + 2), c.weight += 2;
    }
  }
  return c;
}
function wt(e, n) {
  e.forEach((t) => {
    t.vs = t.vs.flatMap((r) => n[r] ? n[r].vs : r);
  });
}
function Nt(e, n) {
  e.barycenter !== void 0 ? (e.barycenter = (e.barycenter * e.weight + n.barycenter * n.weight) / (e.weight + n.weight), e.weight += n.weight) : (e.barycenter = n.barycenter, e.weight = n.weight);
}
function de(e, n, t, r) {
  r || (r = e.nodes());
  let o = Gt(e), i2 = new p({ compound: true }).setGraph({ root: o }).setDefaultNodeLabel((s) => e.node(s));
  return r.forEach((s) => {
    let a = e.node(s), d = e.parent(s);
    if (a.rank === n || a.minRank <= n && n <= a.maxRank) {
      i2.setNode(s), i2.setParent(s, d || o);
      let l = e[t](s);
      l && l.forEach((u) => {
        let c = u.v === s ? u.w : u.v, h = i2.edge(c, s), f = h !== void 0 ? h.weight : 0;
        i2.setEdge(c, s, { weight: e.edge(u).weight + f });
      }), Object.hasOwn(a, "minRank") && i2.setNode(s, { borderLeft: a.borderLeft[n], borderRight: a.borderRight[n] });
    }
  }), i2;
}
function Gt(e) {
  let n;
  for (; e.hasNode(n = j("_root")); ) ;
  return n;
}
function le(e, n, t) {
  let r = {}, o;
  t.forEach((i2) => {
    let s = e.parent(i2), a, d;
    for (; s; ) {
      if (a = e.parent(s), a ? (d = r[a], r[a] = s) : (d = o, o = s), d && d !== s) {
        n.setEdge(d, s);
        return;
      }
      s = a;
    }
  });
}
function B(e, n = {}) {
  if (typeof n.customOrder == "function") {
    n.customOrder(e, B);
    return;
  }
  let t = X(e), r = sn(e, k(1, t + 1), "inEdges"), o = sn(e, k(t - 1, -1, -1), "outEdges"), i2 = re(e);
  if (an(e, i2), n.disableOptimalOrderHeuristic) return;
  let s = Number.POSITIVE_INFINITY, a, d = n.constraints || [];
  for (let l = 0, u = 0; u < 4; ++l, ++u) {
    kt(l % 2 ? r : o, l % 4 >= 2, d), i2 = N(e);
    let c = oe(e, i2);
    c < s ? (u = 0, a = Object.assign({}, i2), s = c) : c === s && (a = structuredClone(i2));
  }
  an(e, a);
}
function sn(e, n, t) {
  let r = /* @__PURE__ */ new Map(), o = (i2, s) => {
    r.has(i2) || r.set(i2, []), r.get(i2).push(s);
  };
  for (let i2 of e.nodes()) {
    let s = e.node(i2);
    if (typeof s.rank == "number" && o(s.rank, i2), typeof s.minRank == "number" && typeof s.maxRank == "number") for (let a = s.minRank; a <= s.maxRank; a++) a !== s.rank && o(a, i2);
  }
  return n.map(function(i2) {
    return de(e, i2, t, r.get(i2) || []);
  });
}
function kt(e, n, t) {
  let r = new p();
  e.forEach(function(o) {
    t.forEach((a) => r.setEdge(a.left, a.right));
    let i2 = o.graph().root, s = W(o, i2, r, n);
    s.vs.forEach((a, d) => o.node(a).order = d), le(o, r, s.vs);
  });
}
function an(e, n) {
  Object.values(n).forEach((t) => t.forEach((r, o) => e.node(r).order = o));
}
function vt(e, n) {
  let t = {};
  function r(o, i2) {
    let s = 0, a = 0, d = o.length, l = i2[i2.length - 1];
    return i2.forEach((u, c) => {
      let h = xt(e, u), f = h ? e.node(h).order : d;
      (h || u === l) && (i2.slice(a, c + 1).forEach((g) => {
        let b = e.predecessors(g);
        b && b.forEach((m) => {
          let E = e.node(m), y = E.order;
          (y < s || f < y) && !(E.dummy && e.node(g).dummy) && dn(t, m, g);
        });
      }), a = c + 1, s = f);
    }), i2;
  }
  return n.length && n.reduce(r), t;
}
function _t(e, n) {
  let t = {};
  function r(i2, s, a, d, l) {
    k(s, a).forEach((u) => {
      let c = i2[u];
      if (c !== void 0 && e.node(c).dummy) {
        let h = e.predecessors(c);
        h && h.forEach((f) => {
          if (f === void 0) return;
          let g = e.node(f);
          g.dummy && (g.order < d || g.order > l) && dn(t, f, c);
        });
      }
    });
  }
  function o(i2, s) {
    let a = -1, d = -1, l = 0;
    return s.forEach((u, c) => {
      if (e.node(u).dummy === "border") {
        let h = e.predecessors(u);
        if (h && h.length) {
          let f = h[0];
          if (f === void 0) return;
          d = e.node(f).order, r(s, l, c, a, d), l = c, a = d;
        }
      }
      r(s, l, s.length, d, i2.length);
    }), s;
  }
  return n.length && n.reduce(o), t;
}
function xt(e, n) {
  if (e.node(n).dummy) {
    let t = e.predecessors(n);
    if (t) return t.find((r) => e.node(r).dummy);
  }
}
function dn(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  r || (e[n] = r = {}), r[t] = true;
}
function Tt(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  return r !== void 0 && Object.hasOwn(r, t);
}
function Ot(e, n, t, r) {
  let o = {}, i2 = {}, s = {};
  return n.forEach((a) => {
    a.forEach((d, l) => {
      o[d] = d, i2[d] = d, s[d] = l;
    });
  }), n.forEach((a) => {
    let d = -1;
    a.forEach((l) => {
      let u = r(l);
      if (u && u.length) {
        let c = u.sort((f, g) => {
          let b = s[f], m = s[g];
          return (b !== void 0 ? b : 0) - (m !== void 0 ? m : 0);
        }), h = (c.length - 1) / 2;
        for (let f = Math.floor(h), g = Math.ceil(h); f <= g; ++f) {
          let b = c[f];
          if (b === void 0) continue;
          let m = s[b];
          if (m !== void 0 && i2[l] === l && d < m && !Tt(t, l, b)) {
            let E = o[b];
            E !== void 0 && (i2[b] = l, i2[l] = o[l] = E, d = m);
          }
        }
      }
    });
  }), { root: o, align: i2 };
}
function It(e, n, t, r, o = false) {
  let i2 = {}, s = Ct(e, n, t, o), a = o ? "borderLeft" : "borderRight";
  function d(f, g) {
    let b = s.nodes().slice(), m = {}, E = b.pop();
    for (; E; ) {
      if (m[E]) f(E);
      else {
        m[E] = true, b.push(E);
        for (let y of g(E)) b.push(y);
      }
      E = b.pop();
    }
  }
  function l(f) {
    let g = s.inEdges(f);
    g ? i2[f] = g.reduce((b, m) => {
      var I;
      let E = (I = i2[m.v]) != null ? I : 0, y = s.edge(m);
      return Math.max(b, E + (y !== void 0 ? y : 0));
    }, 0) : i2[f] = 0;
  }
  function u(f) {
    let g = s.outEdges(f), b = Number.POSITIVE_INFINITY;
    g && (b = g.reduce((E, y) => {
      let I = i2[y.w], be = s.edge(y);
      return Math.min(E, (I !== void 0 ? I : 0) - (be !== void 0 ? be : 0));
    }, Number.POSITIVE_INFINITY));
    let m = e.node(f);
    b !== Number.POSITIVE_INFINITY && m.borderType !== a && (i2[f] = Math.max(i2[f] !== void 0 ? i2[f] : 0, b));
  }
  function c(f) {
    return s.predecessors(f) || [];
  }
  function h(f) {
    return s.successors(f) || [];
  }
  return d(l, c), d(u, h), Object.keys(r).forEach((f) => {
    var b;
    let g = t[f];
    g !== void 0 && (i2[f] = (b = i2[g]) != null ? b : 0);
  }), i2;
}
function Ct(e, n, t, r) {
  let o = new p(), i2 = e.graph(), s = jt(i2.nodesep, i2.edgesep, r);
  return n.forEach((a) => {
    let d;
    a.forEach((l) => {
      let u = t[l];
      if (u !== void 0) {
        if (o.setNode(u), d !== void 0) {
          let c = t[d];
          if (c !== void 0) {
            let h = o.edge(c, u);
            o.setEdge(c, u, Math.max(s(e, l, d), h || 0));
          }
        }
        d = l;
      }
    });
  }), o;
}
function Rt(e, n) {
  return Object.values(n).reduce((t, r) => {
    let o = Number.NEGATIVE_INFINITY, i2 = Number.POSITIVE_INFINITY;
    Object.entries(r).forEach(([a, d]) => {
      let l = St(e, a) / 2;
      o = Math.max(d + l, o), i2 = Math.min(d - l, i2);
    });
    let s = o - i2;
    return s < t[0] && (t = [s, r]), t;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function Pt(e, n) {
  let t = Object.values(n), r = L(Math.min, t), o = L(Math.max, t);
  ["u", "d"].forEach((i2) => {
    ["l", "r"].forEach((s) => {
      let a = i2 + s, d = e[a];
      if (!d || d === n) return;
      let l = Object.values(d), u = r - L(Math.min, l);
      s !== "l" && (u = o - L(Math.max, l)), u && (e[a] = O(d, (c) => c + u));
    });
  });
}
function Mt(e, n = void 0) {
  let t = e.ul;
  return t ? O(t, (r, o) => {
    var s, a;
    if (n) {
      let d = n.toLowerCase(), l = e[d];
      if (l && l[o] !== void 0) return l[o];
    }
    let i2 = Object.values(e).map((d) => {
      let l = d[o];
      return l !== void 0 ? l : 0;
    }).sort((d, l) => d - l);
    return (((s = i2[1]) != null ? s : 0) + ((a = i2[2]) != null ? a : 0)) / 2;
  }) : {};
}
function ln(e) {
  let n = N(e), t = Object.assign(vt(e, n), _t(e, n)), r = {}, o;
  ["u", "d"].forEach((s) => {
    o = s === "u" ? n : Object.values(n).reverse(), ["l", "r"].forEach((a) => {
      a === "r" && (o = o.map((c) => Object.values(c).reverse()));
      let l = Ot(e, o, t, (c) => (s === "u" ? e.predecessors(c) : e.successors(c)) || []), u = It(e, o, l.root, l.align, a === "r");
      a === "r" && (u = O(u, (c) => -c)), r[s + a] = u;
    });
  });
  let i2 = Rt(e, r);
  return Pt(r, i2), Mt(r, e.graph().align);
}
function jt(e, n, t) {
  return (r, o, i2) => {
    let s = r.node(o), a = r.node(i2), d = 0, l;
    if (d += s.width / 2, Object.hasOwn(s, "labelpos")) switch (s.labelpos.toLowerCase()) {
      case "l":
        l = -s.width / 2;
        break;
      case "r":
        l = s.width / 2;
        break;
    }
    if (l && (d += t ? l : -l), l = void 0, d += (s.dummy ? n : e) / 2, d += (a.dummy ? n : e) / 2, d += a.width / 2, Object.hasOwn(a, "labelpos")) switch (a.labelpos.toLowerCase()) {
      case "l":
        l = a.width / 2;
        break;
      case "r":
        l = -a.width / 2;
        break;
    }
    return l && (d += t ? l : -l), d;
  };
}
function St(e, n) {
  return e.node(n).width;
}
function un(e) {
  e = A(e), Ft(e), Object.entries(ln(e)).forEach(([n, t]) => e.node(n).x = t);
}
function Ft(e) {
  let n = N(e), t = e.graph(), r = t.ranksep, o = t.rankalign, i2 = 0;
  n.forEach((s) => {
    let a = s.reduce((d, l) => {
      var c;
      let u = (c = e.node(l).height) != null ? c : 0;
      return d > u ? d : u;
    }, 0);
    s.forEach((d) => {
      let l = e.node(d);
      o === "top" ? l.y = i2 + l.height / 2 : o === "bottom" ? l.y = i2 + a - l.height / 2 : l.y = i2 + a / 2;
    }), i2 += a + r;
  });
}
function he(e, n = {}) {
  let t = n.debugTiming ? P : M;
  return t("layout", () => {
    let r = t("  buildLayoutGraph", () => Xt(e));
    return t("  runLayout", () => Dt(r, t, n)), t("  updateInputGraph", () => At(e, r)), r;
  });
}
function Dt(e, n, t) {
  n("    makeSpaceForEdgeLabels", () => Ut(e)), n("    removeSelfEdges", () => rr(e)), n("    acyclic", () => je(e)), n("    nestingGraph.run", () => Ke(e)), n("    rank", () => Xe(A(e))), n("    injectEdgeLabelProxies", () => Kt(e)), n("    removeEmptyRanks", () => Oe(e)), n("    nestingGraph.cleanup", () => Je(e)), n("    normalizeRanks", () => Te(e)), n("    assignRankMinMax", () => $t(e)), n("    removeEdgeLabelProxies", () => Jt(e)), n("    normalize.run", () => Fe(e)), n("    parentDummyChains", () => Ue(e)), n("    addBorderSegments", () => Ze(e)), n("    order", () => B(e, t)), n("    insertSelfEdges", () => or(e)), n("    adjustCoordinateSystem", () => nn(e)), n("    position", () => un(e)), n("    positionSelfEdges", () => ir(e)), n("    removeBorderNodes", () => tr(e)), n("    normalize.undo", () => De(e)), n("    fixupEdgeLabelCoords", () => er(e)), n("    undoCoordinateSystem", () => tn(e)), n("    translateGraph", () => Qt(e)), n("    assignNodeIntersects", () => Zt(e)), n("    reversePoints", () => nr(e)), n("    acyclic.undo", () => Se(e));
}
function At(e, n) {
  e.nodes().forEach((t) => {
    let r = e.node(t), o = n.node(t);
    r && (r.x = o.x, r.y = o.y, r.order = o.order, r.rank = o.rank, n.children(t).length && (r.width = o.width, r.height = o.height));
  }), e.edges().forEach((t) => {
    let r = e.edge(t), o = n.edge(t);
    r.points = o.points, Object.hasOwn(o, "x") && (r.x = o.x, r.y = o.y);
  }), e.graph().width = n.graph().width, e.graph().height = n.graph().height;
}
var Vt = ["nodesep", "edgesep", "ranksep", "marginx", "marginy"];
var Wt = { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: "TB", rankalign: "center" };
var Bt = ["acyclicer", "ranker", "rankdir", "align", "rankalign"];
var Yt = ["width", "height", "rank"];
var cn = { width: 0, height: 0 };
var zt = ["minlen", "weight", "width", "height", "labeloffset"];
var Ht = { minlen: 1, weight: 1, width: 0, height: 0, labeloffset: 10, labelpos: "r" };
var qt = ["labelpos"];
function Xt(e) {
  let n = new p({ multigraph: true, compound: true }), t = ce(e.graph());
  return n.setGraph(Object.assign({}, Wt, ue(t, Vt), T(t, Bt))), e.nodes().forEach((r) => {
    let o = ce(e.node(r)), i2 = ue(o, Yt);
    Object.keys(cn).forEach((a) => {
      i2[a] === void 0 && (i2[a] = cn[a]);
    }), n.setNode(r, i2);
    let s = e.parent(r);
    s !== void 0 && n.setParent(r, s);
  }), e.edges().forEach((r) => {
    let o = ce(e.edge(r));
    n.setEdge(r, Object.assign({}, Ht, ue(o, zt), T(o, qt)));
  }), n;
}
function Ut(e) {
  let n = e.graph();
  n.ranksep /= 2, e.edges().forEach((t) => {
    let r = e.edge(t);
    r.minlen *= 2, r.labelpos.toLowerCase() !== "c" && (n.rankdir === "TB" || n.rankdir === "BT" ? r.width += r.labeloffset : r.height += r.labeloffset);
  });
}
function Kt(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.width && t.height) {
      let r = e.node(n.v), i2 = { rank: (e.node(n.w).rank - r.rank) / 2 + r.rank, e: n };
      w(e, "edge-proxy", i2, "_ep");
    }
  });
}
function $t(e) {
  let n = 0;
  e.nodes().forEach((t) => {
    let r = e.node(t);
    r.borderTop && (r.minRank = e.node(r.borderTop).rank, r.maxRank = e.node(r.borderBottom).rank, n = Math.max(n, r.maxRank));
  }), e.graph().maxRank = n;
}
function Jt(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n);
    if (t.dummy === "edge-proxy") {
      let r = t;
      e.edge(r.e).labelRank = t.rank, e.removeNode(n);
    }
  });
}
function Qt(e) {
  let n = Number.POSITIVE_INFINITY, t = 0, r = Number.POSITIVE_INFINITY, o = 0, i2 = e.graph(), s = i2.marginx || 0, a = i2.marginy || 0;
  function d(l) {
    let u = l.x, c = l.y, h = l.width, f = l.height;
    n = Math.min(n, u - h / 2), t = Math.max(t, u + h / 2), r = Math.min(r, c - f / 2), o = Math.max(o, c + f / 2);
  }
  e.nodes().forEach((l) => d(e.node(l))), e.edges().forEach((l) => {
    let u = e.edge(l);
    Object.hasOwn(u, "x") && d(u);
  }), n -= s, r -= a, e.nodes().forEach((l) => {
    let u = e.node(l);
    u.x -= n, u.y -= r;
  }), e.edges().forEach((l) => {
    let u = e.edge(l);
    u.points.forEach((c) => {
      c.x -= n, c.y -= r;
    }), Object.hasOwn(u, "x") && (u.x -= n), Object.hasOwn(u, "y") && (u.y -= r);
  }), i2.width = t - n + s, i2.height = o - r + a;
}
function Zt(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n), r = e.node(n.v), o = e.node(n.w), i2, s;
    t.points ? (i2 = t.points[0], s = t.points[t.points.length - 1]) : (t.points = [], i2 = o, s = r), t.points.unshift(H(r, i2)), t.points.push(H(o, s));
  });
}
function er(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (Object.hasOwn(t, "x")) switch ((t.labelpos === "l" || t.labelpos === "r") && (t.width -= t.labeloffset), t.labelpos) {
      case "l":
        t.x -= t.width / 2 + t.labeloffset;
        break;
      case "r":
        t.x += t.width / 2 + t.labeloffset;
        break;
    }
  });
}
function nr(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    t.reversed && t.points.reverse();
  });
}
function tr(e) {
  e.nodes().forEach((n) => {
    if (e.children(n).length) {
      let t = e.node(n), r = e.node(t.borderTop), o = e.node(t.borderBottom), i2 = e.node(t.borderLeft[t.borderLeft.length - 1]), s = e.node(t.borderRight[t.borderRight.length - 1]);
      t.width = Math.abs(s.x - i2.x), t.height = Math.abs(o.y - r.y), t.x = i2.x + t.width / 2, t.y = r.y + t.height / 2;
    }
  }), e.nodes().forEach((n) => {
    e.node(n).dummy === "border" && e.removeNode(n);
  });
}
function rr(e) {
  e.edges().forEach((n) => {
    if (n.v === n.w) {
      let t = e.node(n.v);
      t.selfEdges || (t.selfEdges = []), t.selfEdges.push({ e: n, label: e.edge(n) }), e.removeEdge(n);
    }
  });
}
function or(e) {
  N(e).forEach((t) => {
    let r = 0;
    t.forEach((o, i2) => {
      let s = e.node(o);
      s.order = i2 + r, (s.selfEdges || []).forEach((a) => {
        w(e, "selfedge", { width: a.label.width, height: a.label.height, rank: s.rank, order: i2 + ++r, e: a.e, label: a.label }, "_se");
      }), delete s.selfEdges;
    });
  });
}
function ir(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n);
    if (t.dummy === "selfedge") {
      let r = t, o = e.node(r.e.v), i2 = o.x + o.width / 2, s = o.y, a = t.x - i2, d = o.height / 2;
      e.setEdge(r.e, r.label), e.removeNode(n), r.label.points = [{ x: i2 + 2 * a / 3, y: s - d }, { x: i2 + 5 * a / 6, y: s - d }, { x: i2 + a, y: s }, { x: i2 + 5 * a / 6, y: s + d }, { x: i2 + 2 * a / 3, y: s + d }], r.label.x = t.x, r.label.y = t.y;
    }
  });
}
function ue(e, n) {
  return O(T(e, n), Number);
}
function ce(e) {
  let n = {};
  return e && Object.entries(e).forEach(([t, r]) => {
    typeof t == "string" && (t = t.toLowerCase()), n[t] = r;
  }), n;
}
function fe(e) {
  let n = N(e), t = new p({ compound: true, multigraph: true }).setGraph({});
  return e.nodes().forEach((r) => {
    t.setNode(r, { label: r }), t.setParent(r, "layer" + e.node(r).rank);
  }), e.edges().forEach((r) => t.setEdge(r.v, r.w, {}, r.name)), n.forEach((r, o) => {
    let i2 = "layer" + o;
    t.setNode(i2, { rank: "same" }), r.reduce((s, a) => (t.setEdge(s, a, { style: "invis" }), a));
  }), t;
}
var sr = { graphlib: z, version: U, layout: he, debug: fe, util: { time: P, notime: M } };
var To = sr;

// kit/lib/layout.mjs
function dims(n) {
  if (n.w && n.h) return { w: n.w, h: n.h };
  switch (n.type) {
    case "box":
      return { w: n.w || 150, h: n.h || 70 };
    case "graphNode": {
      const r = n.r || 34;
      return { w: 2 * r + 40, h: 2 * r + 30 };
    }
    // +espaço p/ label externo
    case "card":
      return { w: n.w || 230, h: n.h || 130 };
    case "chip":
      return { w: n.w || 150, h: 44 };
    case "browserIcon":
    case "serverIcon":
    case "dbIcon": {
      const s = n.scale || 1;
      return { w: 150 * s, h: 120 * s };
    }
    default:
      return { w: n.w || 150, h: n.h || 80 };
  }
}
function center(n) {
  return [n.x, n.y];
}
function edgePoint(from, to, d) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return from.slice();
  const hw = d.w / 2, hh = d.h / 2;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return [from[0] + dx * t, from[1] + dy * t];
}
function topoIds(ids, rels) {
  const indeg = new Map(ids.map((i2) => [i2, 0])), adj = new Map(ids.map((i2) => [i2, []]));
  for (const r of rels) {
    if (adj.has(r.from) && indeg.has(r.to)) {
      adj.get(r.from).push(r.to);
      indeg.set(r.to, indeg.get(r.to) + 1);
    }
  }
  const q2 = ids.filter((i2) => indeg.get(i2) === 0), order = [], seen = /* @__PURE__ */ new Set();
  while (q2.length) {
    const n = q2.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) q2.push(m);
    }
  }
  for (const i2 of ids) if (!seen.has(i2)) order.push(i2);
  return order;
}
function isLinear(parts, rels) {
  const indeg = {}, outdeg = {};
  for (const n of parts) {
    indeg[n.id] = 0;
    outdeg[n.id] = 0;
  }
  for (const r of rels) {
    if (outdeg[r.from] != null) outdeg[r.from]++;
    if (indeg[r.to] != null) indeg[r.to]++;
  }
  return parts.every((n) => indeg[n.id] <= 1 && outdeg[n.id] <= 1);
}
function applyAutoLayout(spec) {
  if (!spec || !spec.layout) return { applied: false };
  const cfg = typeof spec.layout === "object" ? spec.layout : {};
  const rankdir = cfg.rankdir || "LR";
  const nodesep = cfg.nodesep != null ? cfg.nodesep : 70;
  const ranksep = cfg.ranksep != null ? cfg.ranksep : 110;
  const edgeType = cfg.edgeType || "arrow";
  const nodes = spec.nodes || (spec.nodes = []);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rels = spec.relations || spec.edges || [];
  const skip = /* @__PURE__ */ new Set(["arrow", "edge", "frame", "banner"]);
  const parts = nodes.filter((n) => n.id && !n.fixed && !skip.has(n.type) && n.pin == null);
  if (!parts.length) return { applied: false };
  const g = new To.graphlib.Graph();
  g.setGraph({ rankdir, nodesep, ranksep, marginx: 20, marginy: 20, align: cfg.align });
  g.setDefaultEdgeLabel(() => ({}));
  const dimOf = /* @__PURE__ */ new Map();
  for (const n of parts) {
    dimOf.set(n.id, dims(n));
  }
  const wrap = cfg.wrap != null ? cfg.wrap : parts.length >= 7 && isLinear(parts, rels);
  let gw, gh, placed = 0;
  if (wrap) {
    const order = topoIds(parts.map((n) => n.id), rels);
    const cols = typeof wrap === "number" && wrap >= 2 ? wrap : Math.max(2, Math.min(5, Math.round(Math.sqrt(order.length * 1.3))));
    const colW = cfg.colW || 250, rowH = cfg.rowH || 165;
    order.forEach((id, i2) => {
      const n = byId.get(id);
      const row = Math.floor(i2 / cols);
      let c = i2 % cols;
      if (row % 2 === 1) c = cols - 1 - c;
      n.x = c * colW;
      n.y = row * rowH;
    });
    const xs = order.map((id) => byId.get(id).x), ys = order.map((id) => byId.get(id).y);
    const cxg = (Math.min(...xs) + Math.max(...xs)) / 2, cyg = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const id of order) {
      const n = byId.get(id);
      n.x = Math.round(n.x - cxg);
      n.y = Math.round(n.y - cyg);
      placed++;
    }
    gw = Math.max(...xs) - Math.min(...xs) + colW;
    gh = Math.max(...ys) - Math.min(...ys) + rowH;
  } else {
    for (const n of parts) {
      g.setNode(n.id, { width: dimOf.get(n.id).w, height: dimOf.get(n.id).h });
    }
    for (const r of rels) {
      if (byId.has(r.from) && byId.has(r.to)) g.setEdge(r.from, r.to);
    }
    To.layout(g);
    gw = g.graph().width || 0;
    gh = g.graph().height || 0;
    const ox = gw / 2, oy = gh / 2;
    for (const n of parts) {
      const nd = g.node(n.id);
      if (nd) {
        n.x = Math.round(nd.x - ox);
        n.y = Math.round(nd.y - oy);
        placed++;
      }
    }
  }
  const fitW = cfg.fitW || 900, fitH = cfg.fitH || 520;
  let s = 1;
  if (cfg.fit !== false && (gw > fitW || gh > fitH)) s = Math.min(fitW / gw, fitH / gh);
  if (s < 1) {
    for (const n of parts) {
      n.x = Math.round(n.x * s);
      n.y = Math.round(n.y * s);
      const d = dimOf.get(n.id);
      if (n.type === "box") {
        n.w = Math.round(d.w * s);
        n.h = Math.round(d.h * s);
      } else if (n.type === "graphNode") {
        n.r = Math.round((n.r || 34) * s);
      } else if (n.type === "browserIcon" || n.type === "serverIcon" || n.type === "dbIcon" || n.type === "card" || n.type === "chip") {
        if (n.scale != null) n.scale = +(n.scale * s).toFixed(3);
        else n.scale = +s.toFixed(3);
      } else {
        if (n.w) n.w = Math.round(n.w * s);
        if (n.h) n.h = Math.round(n.h * s);
      }
      dimOf.set(n.id, { w: d.w * s, h: d.h * s });
    }
  }
  let generated = 0;
  const relColor = cfg.edgeColor || spec.accent || "#5b8cff";
  const seen = /* @__PURE__ */ new Set();
  for (const n of nodes) {
    if ((n.type === "arrow" || n.type === "edge") && n.from && n.to) seen.add(n.from + ">" + n.to);
  }
  for (const r of rels) {
    const key = r.from + ">" + r.to;
    if (seen.has(key)) continue;
    seen.add(key);
    const A2 = byId.get(r.from), B2 = byId.get(r.to);
    if (!A2 || !B2) continue;
    const cA = center(A2), cB = center(B2);
    const p0 = edgePoint(cA, cB, dimOf.get(A2.id) || { w: 0, h: 0 });
    const p1 = edgePoint(cB, cA, dimOf.get(B2.id) || { w: 0, h: 0 });
    const e = {
      type: edgeType,
      x0: Math.round(p0[0]),
      y0: Math.round(p0[1]),
      x1: Math.round(p1[0]),
      y1: Math.round(p1[1]),
      color: r.color || relColor
    };
    if (cfg.edgeFlow !== false) {
      e.flow = true;
      e.flowColor = r.color || relColor;
    }
    if (spec.story) e.id = "__edge_" + r.from + "_" + r.to;
    if (r.label) e.label = r.label;
    if (r.dashed) e.dashed = true;
    if (edgeType === "arrow") e.arrow = true;
    else if (r.arrow !== false) e.arrow = true;
    if (r.info) e.info = r.info;
    nodes.push(e);
    generated++;
  }
  for (const n of nodes) {
    if ((n.type === "arrow" || n.type === "edge") && n.from && n.to) {
      const A2 = byId.get(n.from), B2 = byId.get(n.to);
      if (!A2 || !B2) continue;
      const p0 = edgePoint(center(A2), center(B2), dimOf.get(A2.id) || { w: 0, h: 0 });
      const p1 = edgePoint(center(B2), center(A2), dimOf.get(B2.id) || { w: 0, h: 0 });
      n.x0 = Math.round(p0[0]);
      n.y0 = Math.round(p0[1]);
      n.x1 = Math.round(p1[0]);
      n.y1 = Math.round(p1[1]);
      delete n.from;
      delete n.to;
    }
  }
  return { applied: true, nodesPlaced: placed, edgesGenerated: generated, rankdir, gw, gh, fitScale: +s.toFixed(3) };
}

// kit/lib/story.mjs
function topoOrder(ids, rels) {
  const indeg = new Map(ids.map((i2) => [i2, 0]));
  const adj = new Map(ids.map((i2) => [i2, []]));
  for (const r of rels) {
    if (adj.has(r.from) && indeg.has(r.to)) {
      adj.get(r.from).push(r.to);
      indeg.set(r.to, indeg.get(r.to) + 1);
    }
  }
  const q2 = ids.filter((i2) => indeg.get(i2) === 0);
  const order = [], seen = /* @__PURE__ */ new Set();
  while (q2.length) {
    const n = q2.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) q2.push(m);
    }
  }
  for (const i2 of ids) if (!seen.has(i2)) order.push(i2);
  return order;
}
function buildStorySteps(spec) {
  if (!spec || !spec.story) return { applied: false };
  if (Array.isArray(spec.scenes) && spec.scenes.length) return { applied: false };
  const cfg = typeof spec.story === "object" ? spec.story : {};
  const nodes = (spec.nodes || []).filter((n) => n.id && n.type !== "arrow" && n.type !== "edge");
  const rels = spec.relations || spec.edges || [];
  if (!nodes.length) return { applied: false };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = topoOrder(nodes.map((n) => n.id), rels);
  const focusZoom = cfg.focusZoom || 1.8;
  const accent = spec.accent || "#5b8cff";
  const eid = (a, b) => "__edge_" + a + "_" + b;
  const revealed = /* @__PURE__ */ new Set(), revEdges = /* @__PURE__ */ new Set();
  const steps = [];
  const pop = cfg.pop !== false;
  for (const id of order) {
    const n = byId.get(id);
    revealed.add(id);
    if (pop && n.scale == null) n.scale = 0.86;
    const newEdges = [];
    for (const r of rels) {
      const k2 = eid(r.from, r.to);
      if (!revEdges.has(k2) && revealed.has(r.from) && revealed.has(r.to)) {
        revEdges.add(k2);
        newEdges.push(k2);
      }
    }
    const step = {
      id,
      title: n.title || n.label || id,
      narration: n.say || n.narration || "",
      camera: { cx: n.x || 0, cy: n.y || 0, zoom: focusZoom, duration: 0.55 },
      reveal: [id, ...newEdges],
      focus: [id]
    };
    if (pop) step.animate = { [id]: { scale: 1 }, duration: 0.5 };
    if (n.tag) step.annotate = [{ target: id, text: n.tag, side: n.tagSide || cfg.annotSide || "top", color: n.tagColor || accent }];
    steps.push(step);
  }
  const allEdges = rels.map((r) => eid(r.from, r.to));
  const bnodes = nodes.filter((n) => n.id && n.type !== "arrow" && n.type !== "edge");
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const n of bnodes) {
    const w2 = n.w || 150, h = n.h || 70, x3 = n.x || 0, y = n.y || 0;
    minx = Math.min(minx, x3 - w2 / 2);
    maxx = Math.max(maxx, x3 + w2 / 2);
    miny = Math.min(miny, y - h / 2);
    maxy = Math.max(maxy, y + h / 2);
  }
  const bw = Math.max(1, maxx - minx), bh = Math.max(1, maxy - miny), cxr = (minx + maxx) / 2, cyr = (miny + maxy) / 2;
  let fill = Math.min(1e3 * 0.92 / bw, 600 * 0.92 / bh);
  fill = Math.max(0.85, Math.min(1.6, fill));
  const recapZoom = cfg.fitZoom != null ? cfg.fitZoom : +fill.toFixed(3);
  steps.push({
    id: "ciclo",
    title: cfg.cicloTitle || "Vis\xE3o completa",
    narration: spec.outro || cfg.outro || "",
    camera: { cx: Math.round(cxr), cy: Math.round(cyr), zoom: recapZoom, duration: 0.7 },
    reveal: nodes.map((n) => n.id).concat(allEdges),
    focus: nodes.map((n) => n.id)
  });
  spec.scenes = [{ id: "story", title: spec.title || "", steps }];
  return { applied: true, steps: steps.length };
}

// kit/lib/geom.mjs
var _num = (v2, d) => typeof v2 === "number" && isFinite(v2) ? v2 : d;
function shapeBounds(sh) {
  if (!sh || !sh.kind) return null;
  switch (sh.kind) {
    case "circle": {
      const cx = _num(sh.cx, 0), cy = _num(sh.cy, 0), r = Math.abs(_num(sh.r, 0));
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case "ellipse": {
      const cx = _num(sh.cx, 0), cy = _num(sh.cy, 0), rx = Math.abs(_num(sh.rx, 0)), ry = Math.abs(_num(sh.ry, 0));
      return [cx - rx, cy - ry, cx + rx, cy + ry];
    }
    case "rect": {
      const x3 = _num(sh.x, 0), y = _num(sh.y, 0), w2 = _num(sh.w, 0), h = _num(sh.h, 0);
      return [Math.min(x3, x3 + w2), Math.min(y, y + h), Math.max(x3, x3 + w2), Math.max(y, y + h)];
    }
    case "line": {
      const x1 = _num(sh.x1, 0), y1 = _num(sh.y1, 0), x22 = _num(sh.x2, 0), y2 = _num(sh.y2, 0);
      return [Math.min(x1, x22), Math.min(y1, y2), Math.max(x1, x22), Math.max(y1, y2)];
    }
    case "polyline":
    case "polygon": {
      const p2 = sh.points || [];
      if (!p2.length) return null;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const pt of p2) {
        a = Math.min(a, pt[0]);
        b = Math.min(b, pt[1]);
        c = Math.max(c, pt[0]);
        d = Math.max(d, pt[1]);
      }
      return [a, b, c, d];
    }
    case "text": {
      const x3 = _num(sh.x, 0), y = _num(sh.y, 0), s = _num(sh.size, 14), w2 = String(sh.text || "").length * s * 0.58;
      let x0 = x3;
      if (sh.align === "center") x0 = x3 - w2 / 2;
      else if (sh.align === "right") x0 = x3 - w2;
      let y0 = y - s * 0.8, y1 = y + s * 0.25;
      if (sh.baseline === "middle") {
        y0 = y - s * 0.5;
        y1 = y + s * 0.5;
      } else if (sh.baseline === "top") {
        y0 = y;
        y1 = y + s;
      }
      return [x0, y0, x0 + w2, y1];
    }
    case "path": {
      const bb = sh.bbox;
      if (Array.isArray(bb) && bb.length === 4) return [bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]];
      return null;
    }
    default:
      return null;
  }
}
function shapesBBox(shapes, opts) {
  const minExtent = opts && opts.minExtent || 0;
  const empty = opts && "empty" in opts ? opts.empty : null;
  const skipText = !!(opts && opts.skipText);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
  for (const sh of shapes || []) {
    if (skipText && sh && sh.kind === "text") continue;
    const b = shapeBounds(sh);
    if (!b) continue;
    any = true;
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  if (!any) return empty;
  if (minExtent > 0) {
    if (x1 - x0 < minExtent) {
      const c = (x0 + x1) / 2, h = minExtent / 2;
      x0 = c - h;
      x1 = c + h;
    }
    if (y1 - y0 < minExtent) {
      const c = (y0 + y1) / 2, h = minExtent / 2;
      y0 = c - h;
      y1 = c + h;
    }
  }
  return [x0, y0, x1, y1];
}

// kit/lib/explode.mjs
var PALETTE = ["#3a5a8c", "#4a6f7a", "#57806a", "#7a6f4a", "#8a5a5a", "#6a5a8a", "#4a7a8a", "#7a7a5a"];
function buildExplodeScenes(spec) {
  if (!spec.explode) return { applied: false };
  const cfg = typeof spec.explode === "object" ? spec.explode : {};
  const layers = spec.layers || [];
  if (!layers.length) return { applied: false };
  const iso = cfg.iso != null ? cfg.iso : !!spec.iso;
  const N2 = layers.length;
  const accent = spec.accent || "#5b8cff";
  const w2 = cfg.w || (iso ? 300 : 380);
  const h = cfg.h || (iso ? 150 : 46);
  const thickness = cfg.thickness || (iso ? 14 : 6);
  const physical = layers.some((L2) => Array.isArray(L2.shapes) && L2.shapes.length);
  const asmGap = cfg.asmGap != null ? cfg.asmGap : physical ? 72 : iso ? 30 : 46;
  const expGap = cfg.expGap != null ? cfg.expGap : physical ? 152 : iso ? 150 : 96;
  const asmY = (i2) => (i2 - (N2 - 1) / 2) * asmGap;
  const expY = (i2) => (i2 - (N2 - 1) / 2) * expGap;
  function localBox(L2) {
    if (Array.isArray(L2.shapes) && L2.shapes.length) {
      const s = L2.artScale != null ? L2.artScale : 1, b = shapesBBox(L2.shapes, { minExtent: 16, empty: [-40, -20, 40, 20], skipText: true });
      return [b[0] * s, b[1] * s, b[2] * s, b[3] * s];
    }
    if (iso) {
      const w22 = w2 / 2, h2 = h / 2, HX = 0.9, HY = 0.46, sx = (w22 + h2) * HX, sy = (w22 + h2) * HY;
      return [-sx, -sy, sx, sy + thickness];
    }
    return [-w2 / 2, -h / 2, w2 / 2, h / 2];
  }
  const used = /* @__PURE__ */ new Set();
  const uniqId = (want, i2) => {
    let id = want && want !== "duration" ? want : "lyr" + i2;
    let k2 = 1;
    while (used.has(id) || id === "duration") {
      id = "lyr" + i2 + "_" + k2++;
    }
    used.add(id);
    return id;
  };
  const nodes = layers.map((L2, i2) => {
    const hasArt = Array.isArray(L2.shapes) && L2.shapes.length;
    const base = {
      id: uniqId(L2.id, i2),
      asmX: 0,
      asmY: asmY(i2),
      expX: 0,
      expY: expY(i2),
      lift: 0,
      label: L2.label || L2.id,
      sublabel: L2.sublabel || "",
      color: L2.color || PALETTE[i2 % PALETTE.length],
      accent: L2.accent || accent,
      info: L2.info || L2.say || L2.sublabel || ""
    };
    return hasArt ? { type: "part", ...base, shapes: L2.shapes, artScale: L2.artScale } : { type: "layer", ...base, w: w2, h, thickness, iso: !!iso, icon: L2.icon };
  });
  spec.nodes = (spec.nodes || []).concat(nodes);
  const ids = nodes.map((n) => n.id);
  const VW = 1040, VH = 720, FILL = 0.82;
  function layerBBox(i2, exploded) {
    const cy = exploded ? expY(i2) : asmY(i2), b = localBox(layers[i2]);
    return [b[0], cy + b[1], b[2] + (layers[i2].label ? 150 : 0), cy + b[3]];
  }
  function stackBBox(exploded) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i2 = 0; i2 < N2; i2++) {
      const b = layerBBox(i2, exploded);
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    }
    return [x0, y0, x1, y1];
  }
  function fit(b) {
    const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
    let z2 = FILL * Math.min(VW / bw, VH / bh);
    z2 = Math.max(0.35, Math.min(1.7, z2));
    return { cx: Math.round((b[0] + b[2]) / 2), cy: Math.round((b[1] + b[3]) / 2), zoom: +z2.toFixed(3) };
  }
  const steps = [];
  {
    const c = fit(stackBBox(false));
    steps.push({
      id: "montado",
      title: cfg.assembledTitle || spec.device || "Montado",
      narration: spec.intro || cfg.intro || "",
      camera: { cx: c.cx, cy: c.cy, zoom: c.zoom, duration: 0.7 },
      fit: false,
      reveal: ids.slice(),
      focus: []
    });
  }
  {
    const c = fit(stackBBox(true));
    const anim = {};
    ids.forEach((id) => anim[id] = { lift: 1 });
    anim.duration = 1.1;
    steps.push({
      id: "explodir",
      title: cfg.explodeTitle || "Desmontando as camadas",
      narration: cfg.explodeSay || "Vamos separar as camadas, como quem desmonta o aparelho, para ver cada pe\xE7a por dentro.",
      camera: { cx: c.cx, cy: c.cy, zoom: c.zoom, duration: 0.9 },
      fit: false,
      reveal: ids.slice(),
      focus: [],
      animate: anim
    });
  }
  layers.forEach((L2, i2) => {
    const c = fit(layerBBox(i2, true));
    const st2 = {
      id: "lyr_" + i2,
      title: L2.label || L2.id,
      narration: L2.say || L2.narration || "",
      camera: { cx: c.cx, cy: c.cy, zoom: c.zoom, duration: 0.6 },
      fit: false,
      reveal: ids.slice(),
      focus: [ids[i2]]
    };
    if (L2.tag) st2.annotate = [{ target: ids[i2], text: L2.tag, side: L2.tagSide || "top", color: L2.tagColor || accent }];
    steps.push(st2);
  });
  {
    const c = fit(stackBBox(false));
    const anim = {};
    ids.forEach((id) => anim[id] = { lift: 0 });
    anim.duration = 1.2;
    steps.push({
      id: "remonta",
      title: cfg.recapTitle || "Tudo junto de novo",
      narration: spec.outro || cfg.outro || "E, remontando, cada camada volta ao seu lugar \u2014 agora voc\xEA sabe o que cada uma faz.",
      camera: { cx: c.cx, cy: c.cy, zoom: c.zoom, duration: 0.9 },
      fit: false,
      reveal: ids.slice(),
      focus: [],
      animate: anim
    });
  }
  spec.scenes = [{ id: "explode", title: spec.title || "", steps }];
  return { applied: true, layers: N2, iso: !!iso, steps: steps.length };
}

// kit/lib/theme-import.mjs
import { readFileSync as readFileSync2 } from "node:fs";
import { extname } from "node:path";

// node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j2 = b[i2]; j2 < b[i2 + 1]; ++j2) {
      r[j2] = j2 - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x2 = (i & 43690) >> 1 | (i & 21845) << 1;
  x2 = (x2 & 52428) >> 2 | (x2 & 13107) << 2;
  x2 = (x2 & 61680) >> 4 | (x2 & 3855) << 4;
  rev[i] = ((x2 & 65280) >> 8 | (x2 & 255) << 8) >> 1;
}
var x2;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le2 = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le2[i2] = le2[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v2 = le2[cd[i2] - 1]++ << r_1;
        for (var m = v2 | (1 << r_1) - 1; v2 <= m; ++v2) {
          co[rev[v2] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le2[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
  }
  return m;
};
var bits = function(d, p2, m) {
  var o = p2 / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p2 & 7) & m;
};
var bits16 = function(d, p2) {
  var o = p2 / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p2 & 7);
};
var shft = function(p2) {
  return (p2 + 7) / 8 | 0;
};
var slc = function(v2, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v2.length)
    e = v2.length;
  return new u8(v2.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt2) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt2)
    throw e;
  return e;
};
var inflt = function(dat, st2, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st2.f && !st2.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st2.i != 2;
  var noSt = st2.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st2.f || 0, pos = st2.p || 0, bt2 = st2.b || 0, lm = st2.l, dm = st2.d, lbt = st2.m, dbt = st2.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt2 + l);
        buf.set(dat.subarray(s, t), bt2);
        st2.b = bt2 += l, st2.p = pos = t * 8, st2.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
          }
        }
        var lt2 = ldt.subarray(0, hLit), dt2 = ldt.subarray(hLit);
        lbt = max(lt2);
        dbt = max(dt2);
        lm = hMap(lt2, lbt, 1);
        dm = hMap(dt2, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt2 + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt2++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt2 = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt2 += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt2 + 131072);
        var end = bt2 + add;
        if (bt2 < dt2) {
          var shift = dl - dt2, dend = Math.min(dt2, end);
          if (shift + bt2 < 0)
            err(3);
          for (; bt2 < dend; ++bt2)
            buf[bt2] = dict[shift + bt2];
        }
        for (; bt2 < end; ++bt2)
          buf[bt2] = buf[bt2 - dt2];
      }
    }
    st2.l = lm, st2.p = lpos, st2.b = bt2, st2.f = final;
    if (lm)
      final = 1, st2.m = lbt, st2.d = dm, st2.n = dbt;
  } while (!final);
  return bt2 != buf.length && noBuf ? slc(buf, 0, bt2) : buf.subarray(0, bt2);
};
var et2 = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et2, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i2 = 0; ; ) {
    var c = d[i2++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i2 + eb > d.length)
      return { s: r, r: slc(d, i2 - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i2++] & 63) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i2++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i2 = 0; i2 < dat.length; i2 += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i2, i2 + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z2) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn2 = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z2, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn2, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z2, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z2 && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z2 < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z2 = b4(data, e - 20) == 117853008;
  if (z2) {
    var ze2 = b4(data, e - 12);
    z2 = b4(data, ze2) == 101075792;
    if (z2) {
      c = b4(data, ze2 + 32);
      o = b4(data, ze2 + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i2 = 0; i2 < c; ++i2) {
    var _a2 = zh(data, o, z2), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn2 = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn2,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn2] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn2] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// kit/lib/theme-import.mjs
function norm(hex) {
  if (!hex) return null;
  hex = String(hex).replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6,8}$/.test(hex)) return null;
  return "#" + hex.slice(0, 6).toUpperCase();
}
function pick(re2, xml) {
  const m = re2.exec(xml);
  return m ? m[1] : null;
}
function slotColor(xml, slot) {
  const seg = new RegExp("<a:" + slot + "\\b[^>]*>([\\s\\S]*?)</a:" + slot + ">").exec(xml);
  const body = seg ? seg[1] : "";
  return norm(pick(/<a:srgbClr\s+val="([0-9a-fA-F]{6,8})"/, body) || pick(/<a:sysClr\b[^>]*lastClr="([0-9a-fA-F]{6})"/, body));
}
function importPptxTheme(pptxPath) {
  const buf = readFileSync2(pptxPath);
  const zip = unzipSync(new Uint8Array(buf));
  let themeKey = Object.keys(zip).find((k2) => /^ppt\/theme\/theme1\.xml$/i.test(k2)) || Object.keys(zip).find((k2) => /^ppt\/theme\/theme\d+\.xml$/i.test(k2));
  if (!themeKey) throw new Error("theme n\xE3o encontrado no .pptx (ppt/theme/themeN.xml ausente)");
  const xml = strFromU8(zip[themeKey]);
  const clr = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(xml);
  const cs = clr ? clr[0] : xml;
  const colors = {};
  for (const slot of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"])
    colors[slot] = slotColor(cs, slot);
  const fnt = /<a:fontScheme[\s\S]*?<\/a:fontScheme>/.exec(xml);
  const fs2 = fnt ? fnt[0] : xml;
  const major = pick(/<a:majorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/, fs2);
  const minor = pick(/<a:minorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/, fs2);
  const theme = toTheme(colors, major, minor, "pptx:" + pptxPath.split(/[\\/]/).pop());
  const fonts = extractPptxFonts(zip);
  if (fonts.length) theme.embeddedFonts = fonts;
  return theme;
}
function extractPptxFonts(zip) {
  const presBuf = zip["ppt/presentation.xml"], relsBuf = zip["ppt/_rels/presentation.xml.rels"];
  if (!presBuf || !relsBuf) return [];
  const px = strFromU8(presBuf), rels = strFromU8(relsBuf);
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*>/g)) relMap[m[1]] = m[2];
  const out = [], seen = /* @__PURE__ */ new Set();
  for (const ef of px.matchAll(/<p:embeddedFont>([\s\S]*?)<\/p:embeddedFont>/g)) {
    const body = ef[1];
    const fam = (/<p:font\b[^>]*typeface="([^"]*)"/.exec(body) || [])[1];
    if (!fam) continue;
    for (const [tag, style, weight] of [["regular", "normal", "400"], ["bold", "normal", "700"], ["italic", "italic", "400"], ["boldItalic", "italic", "700"]]) {
      const rid = (new RegExp("<p:" + tag + '\\b[^>]*r:id="([^"]+)"').exec(body) || [])[1];
      if (!rid) continue;
      let tgt = relMap[rid];
      if (!tgt) continue;
      tgt = tgt.replace(/^\.\.\//, "").replace(/^\//, "");
      const key = tgt.startsWith("ppt/") ? tgt : "ppt/" + tgt;
      const data = zip[key] || zip[tgt];
      if (!data) continue;
      const id = fam + "|" + style + "|" + weight;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ family: fam, style, weight, dataUrl: "data:font/ttf;base64," + Buffer.from(data).toString("base64") });
    }
  }
  return out;
}
function importHtmlTheme(htmlPath) {
  const html = readFileSync2(htmlPath, "utf8");
  const root = /:root\s*\{([\s\S]*?)\}/.exec(html);
  const vars = {};
  if (root) for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|[a-z]+\([^)]*\))/g)) vars[m[1]] = m[2];
  const accent = norm(vars["--accent"] || vars["--primary"] || vars["--brand"] || vars["--color-primary"]);
  const bg = norm(vars["--bg"] || vars["--background"] || vars["--surface-0"]);
  const text = norm(vars["--text"] || vars["--fg"] || vars["--color-text"]);
  const ff = pick(/font-family\s*:\s*([^;]+);/i, html);
  const font = ff ? ff.split(",")[0].replace(/['"]/g, "").trim() : null;
  let accents = [];
  if (!accent) {
    const freq = {};
    for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const c = "#" + m[1].toUpperCase();
      freq[c] = (freq[c] || 0) + 1;
    }
    accents = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x3) => x3[0]);
  }
  const colors = { accent1: accent || accents[0], lt1: bg, dk1: text, accent2: accents[1], accent3: accents[2], accent4: accents[3], accent5: accents[4], accent6: accents[5] };
  return toTheme(colors, font, font, "html:" + htmlPath.split(/[\\/]/).pop());
}
function importTokensTheme(jsonPath) {
  const t = JSON.parse(readFileSync2(jsonPath, "utf8"));
  const g = (...ks) => {
    for (const k2 of ks) {
      const v2 = k2.split(".").reduce((o, p2) => o && o[p2], t);
      if (v2) return v2;
    }
    return null;
  };
  const colors = {
    accent1: norm(g("accent", "colors.accent", "colors.primary", "brand.primary", "primary")),
    lt1: norm(g("bg", "background", "colors.bg", "colors.background")),
    dk1: norm(g("text", "fg", "colors.text"))
  };
  const font = g("font", "fontFamily", "typography.fontFamily", "fonts.body");
  return toTheme(colors, g("fonts.heading", "typography.heading") || font, font, "tokens:" + jsonPath.split(/[\\/]/).pop());
}
function toTheme(c, major, minor, source) {
  const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((k2) => c[k2]).filter(Boolean);
  const dark = c.lt1 && isDark(c.lt1) ? true : c.lt1 ? false : true;
  const bg = c.lt1 || (dark ? "#0d1424" : "#ffffff");
  let text = c.dk1 || (dark ? "#eef3ff" : "#10151f");
  if (isDark(bg) === isDark(text)) text = isDark(bg) ? "#eef3ff" : "#10151f";
  return {
    accent: accents[0] || "#5b8cff",
    accents,
    bg,
    surface: c.lt2 || null,
    text,
    muted: c.dk2 || null,
    fontHead: major || null,
    fontBody: minor || null,
    source
  };
}
function isDark(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
if (process.argv[1] && process.argv[1].endsWith("theme-import.mjs")) {
  const p2 = process.argv[2];
  if (!p2) {
    console.error("uso: node kit/lib/theme-import.mjs <arquivo.pptx|.html|.json>");
    process.exit(1);
  }
  const ext = extname(p2).toLowerCase();
  const t = ext === ".pptx" ? importPptxTheme(p2) : ext === ".html" || ext === ".htm" ? importHtmlTheme(p2) : importTokensTheme(p2);
  console.log(JSON.stringify(t, null, 2));
}

// build-artifact.mjs
var __dirname = dirname(fileURLToPath(import.meta.url));
var KIT = join2(__dirname, "kit");
var read = (p2) => readFileSync3(p2, "utf8");
var escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function safeColor(c, fallback) {
  const s = String(c == null ? "" : c).trim();
  return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$|^rgba?\([\d.,\s%]+\)$/.test(s) ? s : fallback;
}
function accentLight(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return hex;
  const mix = (c) => Math.round(c + (255 - c) * 0.28);
  const [r, g, b] = [0, 2, 4].map((i2) => mix(parseInt(m[1].slice(i2, i2 + 2), 16)));
  return "#" + [r, g, b].map((x3) => x3.toString(16).padStart(2, "0")).join("");
}
function slug(s) {
  return String(s || "arte").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "arte";
}
function desktopDir() {
  return join2(os2.homedir(), "Desktop", "visual-explanations");
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function voxEngineExe() {
  const p2 = join2(os2.homedir(), "AppData", "Local", "vox-engine", "venv", "Scripts", "vox-engine.exe");
  return existsSync2(p2) ? p2 : null;
}
async function ensureMotor() {
  let client = await VoxClient.tryConnect();
  if (client) return client;
  const exe = voxEngineExe();
  if (!exe) return null;
  console.log("motor de voz offline \u2014 subindo o daemon (vox-engine)\u2026");
  try {
    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    return null;
  }
  for (let i2 = 0; i2 < 45; i2++) {
    await sleep(1e3);
    client = await VoxClient.tryConnect();
    if (client) {
      console.log("motor no ar.");
      return client;
    }
  }
  return null;
}
function specHasNarrationText(spec) {
  if (spec.narration && spec.narration.intro || spec.intro) return true;
  if (spec.mode === "board") return (spec.blocks || []).some((b) => b && b.say);
  if (Array.isArray(spec.scenes) && spec.scenes.some((sc) => (sc.steps || []).some((st2) => st2.narration))) return true;
  return (spec.nodes || []).some((n) => n.narration || n.info);
}
function wantsNarration(spec) {
  return spec.narrate === true || !!spec.voice || spec.narrate !== false && specHasNarrationText(spec);
}
function collectAudioClips(a) {
  if (!a) return [];
  const out = [];
  if (a.intro) out.push(a.intro);
  for (const k2 of ["board", "steps", "nodes"]) {
    if (Array.isArray(a[k2])) out.push(...a[k2]);
  }
  return out;
}
function isRealAudioClip(c) {
  return typeof c === "string" && /^data:audio\/(ogg|mpeg|wav);base64,[A-Za-z0-9+/]{100,}/.test(c);
}
async function synthNarration(spec) {
  const allowSilent = process.env.VXK_ALLOW_SILENT === "1";
  const wants = wantsNarration(spec);
  if (!wants) return;
  const client = await ensureMotor();
  if (!client) {
    const msg = "motor de voz (vox-engine) indispon\xEDvel: n\xE3o foi poss\xEDvel assar a narra\xE7\xE3o pelo motor. Instale/suba o vox-engine e rebuilde.";
    if (allowSilent) {
      console.warn("WARN  " + msg + "  (VXK_ALLOW_SILENT=1 \u2192 gerando SEM \xE1udio)");
      return;
    }
    throw new Error(msg + "  (para gerar mudo deliberadamente: defina VXK_ALLOW_SILENT=1)");
  }
  let sayReport = () => {
  };
  try {
    const info = await client.info();
    const catalog = info.tts_voices || [];
    let voice = spec.voice || info.default_voice || null;
    if (voice && catalog.length && !catalog.some((v2) => v2.name === voice)) {
      console.warn('WARN  voz "' + voice + '" n\xE3o instalada; usando a padr\xE3o do motor (' + info.default_voice + ").");
      console.warn("       vozes dispon\xEDveis: " + catalog.map((v2) => v2.name).join(", "));
      voice = info.default_voice || null;
    }
    const fmts = info.encode_formats || ["pcm"];
    const pick2 = ["opus", "mp3", "wav"].find((f) => fmts.includes(f));
    if (!pick2) {
      const m = "motor n\xE3o encoda opus/mp3/wav (s\xF3 " + fmts.join(",") + ").";
      if (allowSilent) {
        console.warn("WARN  " + m + " narra\xE7\xE3o desativada.");
        return;
      }
      throw new Error(m);
    }
    const mime = pick2 === "opus" ? "audio/ogg" : pick2 === "mp3" ? "audio/mpeg" : "audio/wav";
    const engine = info.version || "vox";
    const ttsCache = makeFileCache();
    let nHit = 0, nMiss = 0;
    const synth = cached(ttsCache, { engine, voice: voice || "", format: pick2, speed: 1 }, async (t) => {
      const { header, audio: audio2 } = await client.tts(t, { voice, format: pick2, speed: 1 });
      const buf = Buffer.isBuffer(audio2) ? audio2 : audio2 ? Buffer.from(audio2) : Buffer.alloc(0);
      if (header && (header.event === "error" || header.error)) throw new Error("motor de voz falhou ao assar narra\xE7\xE3o: " + (header.error || header.event));
      if (buf.length === 0) throw new Error('motor de voz devolveu \xE1udio VAZIO (frame de erro?) para: "' + t.slice(0, 48) + '\u2026"');
      return buf;
    });
    const say = async (text) => {
      const t = String(text || "").trim();
      if (!t) return null;
      const { audio: audio2, cached: wasHit } = await synth(t);
      wasHit ? nHit++ : nMiss++;
      return "data:" + mime + ";base64," + Buffer.from(audio2).toString("base64");
    };
    sayReport = () => console.log(`narra\xE7\xE3o: ${nHit + nMiss} clipes (${nHit} do cache, ${nMiss} sintetizados) \u2014 ${ttsCache.dir}`);
    if (spec.mode === "board") {
      const board = [];
      const introClip = await say(spec.intro || spec.narration && spec.narration.intro || "");
      if (introClip) board.push(introClip);
      for (const b of spec.blocks || []) {
        const clip = await say(b && b.say || "");
        if (clip) board.push(clip);
      }
      if (board.length === 0) {
        const m = "nenhum texto de narra\xE7\xE3o (intro / blocks[].say vazios).";
        if (allowSilent) {
          console.warn("WARN  " + m + " sem \xE1udio.");
          return;
        }
        throw new Error(m);
      }
      spec._audio = { voice, mime, format: pick2, board };
      console.log("narra\xE7\xE3o assada (board): voz=" + voice + ", formato=" + pick2 + ", trechos=" + board.length);
      return;
    }
    const introText = spec.narration && spec.narration.intro || spec.intro || "";
    const nodes = spec.nodes || [];
    const hasScenes = Array.isArray(spec.scenes) && spec.scenes.length > 0;
    const audio = { voice, mime, format: pick2, intro: await say(introText), nodes: [] };
    if (hasScenes) {
      audio.steps = [];
      let baked = 0;
      for (const scene of spec.scenes) {
        for (const st2 of scene.steps || []) {
          const clip = await say(st2.narration || "");
          audio.steps.push(clip);
          if (clip) baked++;
        }
      }
      const count = (audio.intro ? 1 : 0) + baked;
      if (count === 0) {
        const m = "nenhum texto de narra\xE7\xE3o (steps[].narration / spec.intro vazios).";
        if (allowSilent) {
          console.warn("WARN  " + m + " sem \xE1udio.");
          return;
        }
        throw new Error(m);
      }
      spec._audio = audio;
      console.log("narra\xE7\xE3o assada (passos): voz=" + voice + ", formato=" + pick2 + ", intro=" + (audio.intro ? 1 : 0) + ", passos=" + baked + "/" + audio.steps.length);
    } else {
      for (const n of nodes) {
        audio.nodes.push(await say(n.narration || n.info || ""));
      }
      const count = (audio.intro ? 1 : 0) + audio.nodes.filter(Boolean).length;
      if (count === 0) {
        const m = "nenhum texto de narra\xE7\xE3o (spec.intro / node.info|narration vazios).";
        if (allowSilent) {
          console.warn("WARN  " + m + " sem \xE1udio.");
          return;
        }
        throw new Error(m);
      }
      spec._audio = audio;
      console.log("narra\xE7\xE3o assada: voz=" + voice + ", formato=" + pick2 + ", trechos=" + count);
    }
  } finally {
    sayReport();
    client.close();
  }
}
function page(spec, headExtra, bodyScripts) {
  return '<!DOCTYPE html>\n<html lang="' + (spec.language || "pt-BR") + '">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + escHtml(spec.title || "Explica\xE7\xE3o visual") + "</title>" + headExtra + '</head>\n<body><div id="vxk-root"></div>\n' + bodyScripts + "\n</body>\n</html>\n";
}
function _isDark(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
function _shade(hex, amt) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return hex;
  let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const f = amt < 0 ? 0 : 255, p2 = Math.abs(amt);
  r = Math.round(r + (f - r) * p2);
  g = Math.round(g + (f - g) * p2);
  b = Math.round(b + (f - b) * p2);
  return "#" + [r, g, b].map((x3) => x3.toString(16).padStart(2, "0")).join("");
}
function _rgba(hex, a) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return "rgba(238,243,255,.5)";
  return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
}
function themeStyle(t) {
  if (!t) return "";
  const bg = safeColor(t.bg, "#0a0e18"), txt = safeColor(t.text, "#e7ecf6");
  const acc = safeColor(t.accent, "#5b8cff"), acc2 = accentLight(acc);
  const surf = t.surface ? safeColor(t.surface, bg) : bg;
  const muted = t.muted ? safeColor(t.muted, "#9aa7c2") : "#9aa7c2";
  const fH = t.fontHead ? '"' + t.fontHead + '",' : "";
  const fB = t.fontBody ? '"' + t.fontBody + '",' : "";
  const faces = (t.embeddedFonts || []).map((f) => '@font-face{font-family:"' + f.family + '";font-style:' + f.style + ";font-weight:" + f.weight + ";src:url(" + f.dataUrl + ') format("truetype");}').join("");
  return "<style>" + faces + ":root{--vxk-accent:" + acc + ";--vxk-accent-2:" + acc2 + ";--vxk-txt:" + txt + ";--vxk-muted:" + muted + ";--vxk-bg:" + bg + ";--vxk-panel:" + surf + ";--accent:" + acc + ";--accent-2:" + acc2 + ";}html,body{background:" + bg + " !important;" + (fB ? "font-family:" + fB + 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif !important;' : "") + "}.vxk-stage{background:" + bg + " !important;}.vxk-topbar,.vxk-aside,.vxk-footer{background:" + surf + " !important;}" + (fH ? ".vxk-title,.bd-h1,h1,h2,h3{font-family:" + fH + 'system-ui,"Segoe UI",sans-serif;}' : "") + "</style>";
}
function resolveTheme(spec, specPath) {
  if (!spec.themeFrom && !spec.theme) return;
  let t = spec.theme || null;
  if (spec.themeFrom) {
    const p2 = resolve(dirname(resolve(specPath)), spec.themeFrom);
    const ext = extname2(p2).toLowerCase();
    t = ext === ".pptx" ? importPptxTheme(p2) : ext === ".html" || ext === ".htm" ? importHtmlTheme(p2) : importTokensTheme(p2);
    console.log("tema importado (" + t.source + "): accent=" + t.accent + ", fontes=" + (t.fontHead || "-") + "/" + (t.fontBody || "-"));
  }
  if (t) {
    if (t.accent) spec.accent = t.accent;
    spec._theme = t;
    const dark = _isDark(t.bg || "#0a0e18");
    const nodeFill = safeColor(t.surface, _shade(t.bg || "#0a0e18", dark ? 0.12 : -0.05));
    const nodeStroke = t.accent ? _rgba(t.accent, 0.55) : null;
    for (const n of spec.nodes || []) {
      if (n.type === "box" && n.color == null) {
        n.color = nodeFill;
        if (nodeStroke && n.stroke == null) n.stroke = nodeStroke;
        if (t.text && n.textColor == null) n.textColor = t.text;
      }
    }
  }
}
function inlineGeom() {
  const g = read(join2(KIT, "lib", "geom.mjs")).replace(/^export\s+function/gm, "function");
  return "(function(){\n" + g + '\nif(typeof window!=="undefined"&&window.VXK) window.VXK.geom={pointInPoly, shapeBounds, shapesBBox};\n})();';
}
function buildVxk(spec) {
  const css = read(join2(KIT, "vxk-core.css"));
  const core = read(join2(KIT, "vxk-core.js"));
  const types = [...new Set((spec.nodes || []).map((n) => n.type))];
  const comps = types.map((t) => {
    const f = join2(KIT, "components", t + ".js");
    if (!existsSync2(f)) throw new Error('Componente ausente no design system: "' + t + '"  -> crie kit/components/' + t + ".js");
    return read(f);
  });
  const head = "<style>" + css + (spec.css || "") + "</style>" + themeStyle(spec._theme);
  const icons = existsSync2(join2(KIT, "lib", "icons.js")) ? read(join2(KIT, "lib", "icons.js")) : "";
  const scripts = "<script>" + core + "</script>\n<script>" + inlineGeom() + "</script>\n" + (icons ? "<script>" + icons + "</script>\n" : "") + comps.map((c) => "<script>" + c + "</script>").join("\n") + "\n<script>VXK.mount(" + JSON.stringify(spec) + ', "#vxk-root");</script>';
  return page(spec, head, scripts);
}
function buildKonva(spec) {
  const adapterPath = join2(KIT, "konva", "konva-adapter.js");
  if (!existsSync2(adapterPath)) throw new Error("Motor Konva ainda n\xE3o implementado (F3): falta kit/konva/konva-adapter.js");
  const konva = read(join2(KIT, "konva", "konva.min.js"));
  const adapter = read(adapterPath);
  const css = read(join2(KIT, "vxk-core.css"));
  const head = "<style>" + css + (spec.css || "") + "</style>";
  const scripts = "<script>" + konva + "</script>\n<script>" + adapter + "</script>\n<script>VXKKonva.mount(" + JSON.stringify(spec) + ', "#vxk-root");</script>';
  return page(spec, head, scripts);
}
function renderBoardBlock(b, i2) {
  b = b || {};
  const id = "blk-" + i2;
  const t = b.type || "html";
  const H2 = (s) => escHtml(s == null ? "" : s);
  const titleH = b.title ? '<h3 class="bd-h">' + H2(b.title) + "</h3>" : "";
  let cls = "bd-block", inner = "";
  switch (t) {
    case "hero":
      cls += " bd-hero";
      inner = '<div class="bd-hero-in">' + (b.kicker ? '<span class="bd-kicker">' + H2(b.kicker) + "</span>" : "") + '<h2 class="bd-hero-title">' + H2(b.title) + "</h2>" + (b.subtitle ? '<p class="bd-hero-sub">' + H2(b.subtitle) + "</p>" : "") + "</div>";
      break;
    case "cards": {
      const cols = [2, 3, 4].includes(b.columns) ? b.columns : 3;
      const items = (b.items || []).map((it2) => '<article class="bd-card">' + (it2.icon ? '<div class="bd-card-ic">' + H2(it2.icon) + "</div>" : "") + '<div class="bd-card-b"><h4 class="bd-card-t">' + H2(it2.title) + (it2.badge ? ' <span class="bd-chip">' + H2(it2.badge) + "</span>" : "") + '</h4><p class="bd-card-p">' + H2(it2.body) + "</p></div></article>").join("");
      inner = titleH + '<div class="bd-cards" style="--cols:' + cols + '">' + items + "</div>";
      break;
    }
    case "compare": {
      const head = "<thead><tr><th></th>" + (b.columns || []).map((c) => "<th>" + H2(c) + "</th>").join("") + "</tr></thead>";
      const rows = (b.rows || []).map((r) => '<tr><th scope="row">' + H2(r.label) + "</th>" + (r.cells || []).map((c) => "<td>" + H2(c) + "</td>").join("") + "</tr>").join("");
      inner = titleH + '<div class="bd-tablewrap"><table class="bd-table bd-compare">' + head + "<tbody>" + rows + "</tbody></table></div>";
      break;
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const cl = b.ordered ? "bd-list bd-ol" : "bd-list bd-ul";
      const items = (b.items || []).map((x3) => "<li>" + H2(x3) + "</li>").join("");
      inner = titleH + "<" + tag + ' class="' + cl + '">' + items + "</" + tag + ">";
      break;
    }
    case "columns": {
      const items = b.items || [];
      const cols = Math.min(Math.max(items.length, 1), 4);
      const cells = items.map((it2) => '<div class="bd-col"><h4 class="bd-col-t">' + H2(it2.title) + '</h4><p class="bd-col-p">' + H2(it2.body) + "</p></div>").join("");
      inner = titleH + '<div class="bd-cols" style="--cols:' + cols + '">' + cells + "</div>";
      break;
    }
    case "callout": {
      const tone = ["info", "good", "warn", "bad"].includes(b.tone) ? b.tone : "info";
      inner = '<aside class="bd-callout bd-tone-' + tone + '" role="note">' + (b.title ? '<div class="bd-callout-t">' + H2(b.title) + "</div>" : "") + '<div class="bd-callout-b">' + H2(b.body) + "</div></aside>";
      break;
    }
    case "steps": {
      const items = (b.items || []).map((it2) => '<li class="bd-step"><div class="bd-step-n"></div><div class="bd-step-b"><h4 class="bd-step-t">' + H2(it2.title) + '</h4><p class="bd-step-p">' + H2(it2.body) + "</p></div></li>").join("");
      inner = titleH + '<ol class="bd-steps">' + items + "</ol>";
      break;
    }
    case "stat": {
      const items = (b.items || []).map((it2) => '<div class="bd-stat"><div class="bd-stat-v">' + H2(it2.value) + '</div><div class="bd-stat-l">' + H2(it2.label) + "</div>" + (it2.hint ? '<div class="bd-stat-h">' + H2(it2.hint) + "</div>" : "") + "</div>").join("");
      inner = titleH + '<div class="bd-stats">' + items + "</div>";
      break;
    }
    case "code":
      inner = titleH + '<div class="bd-codewrap">' + (b.lang ? '<span class="bd-codelang">' + H2(b.lang) + "</span>" : "") + '<pre class="bd-code"><code>' + H2(b.code) + "</code></pre></div>";
      break;
    case "table": {
      const head = "<thead><tr>" + (b.head || []).map((h) => "<th>" + H2(h) + "</th>").join("") + "</tr></thead>";
      const rows = (b.rows || []).map((r) => "<tr>" + (r || []).map((c) => "<td>" + H2(c) + "</td>").join("") + "</tr>").join("");
      inner = titleH + '<div class="bd-tablewrap"><table class="bd-table">' + head + "<tbody>" + rows + "</tbody></table></div>";
      break;
    }
    case "html":
      cls += " bd-raw";
      inner = String(b.html == null ? "" : b.html);
      break;
    default:
      inner = titleH + '<p class="bd-card-p">bloco desconhecido: ' + H2(t) + "</p>";
  }
  return '<section class="' + cls + '" id="' + id + '">' + inner + "</section>";
}
function boardRuntime() {
  return 'function BOARD_NAR(NAR){\n  if(!NAR||!NAR.length) return;\n  var reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;\n  var au=new Audio(), idx=-1, playing=false;\n  var btn=document.querySelector(".bd-explain"), prev=document.querySelector(".bd-prev"),\n      next=document.querySelector(".bd-next"), cnt=document.querySelector(".bd-count");\n  function clear(){ var a=document.querySelectorAll(".active"); for(var i=0;i<a.length;i++) a[i].classList.remove("active"); }\n  function mark(i){ clear(); var el=document.getElementById(NAR[i].id);\n    if(el){ el.classList.add("active"); el.scrollIntoView({behavior:reduce?"auto":"smooth",block:"center"}); }\n    if(cnt) cnt.textContent=(i+1)+" / "+NAR.length; }\n  function setBtn(){ if(btn) btn.textContent=playing?"\u23F8 Pausar":(idx>=0?"\u{1F50A} Continuar":"\u{1F50A} Explicar"); }\n  function play(i){ if(i<0||i>=NAR.length) return; idx=i; mark(i); au.src=NAR[i].audio;\n    au.play().then(function(){ playing=true; setBtn(); }).catch(function(){ playing=false; setBtn(); }); }\n  function pause(){ au.pause(); playing=false; setBtn(); }\n  au.addEventListener("ended", function(){ if(idx+1<NAR.length) play(idx+1); else { playing=false; setBtn(); } });\n  if(btn) btn.addEventListener("click", function(){ if(playing) pause(); else play(idx<0?0:idx); });\n  if(prev) prev.addEventListener("click", function(){ pause(); play(Math.max(0,(idx<0?0:idx)-1)); });\n  if(next) next.addEventListener("click", function(){ pause(); play(Math.min(NAR.length-1,(idx<0?0:idx)+1)); });\n  if(cnt) cnt.textContent="1 / "+NAR.length;\n}';
}
function buildBoard(spec) {
  const css = read(join2(KIT, "board.css"));
  const accent = safeColor(spec.accent, "#5b8cff");
  const blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  const introText = String(spec.intro || "").trim();
  const board = spec._audio && Array.isArray(spec._audio.board) ? spec._audio.board : [];
  const targets = [];
  if (introText) targets.push("bd-lead");
  blocks.forEach((b, i2) => {
    if (String(b && b.say || "").trim()) targets.push("blk-" + i2);
  });
  const nar = [];
  for (let i2 = 0; i2 < targets.length && i2 < board.length; i2++) {
    if (board[i2]) nar.push({ id: targets[i2], audio: board[i2] });
  }
  const narrated = nar.length > 0;
  const parts = [];
  parts.push('<div class="bd">');
  parts.push('<header class="bd-head"><div class="bd-head-in"><div class="bd-brand"><span class="bd-dot"></span><h1>' + escHtml(spec.title || "Board") + "</h1></div>" + (spec.badge ? '<span class="bd-badge">' + escHtml(spec.badge) + "</span>" : "") + "</div></header>");
  parts.push('<main class="bd-main">');
  if (introText) parts.push('<p class="bd-lead" id="bd-lead">' + escHtml(introText) + "</p>");
  blocks.forEach((b, i2) => parts.push(renderBoardBlock(b, i2)));
  parts.push("</main>");
  parts.push('<footer class="bd-foot"><div class="bd-foot-in">');
  if (narrated) {
    parts.push('<button class="bd-explain" type="button">\u{1F50A} Explicar</button><div class="bd-nav"><button class="bd-prev" type="button" aria-label="Se\xE7\xE3o anterior">\u25C0</button><span class="bd-count">1 / ' + nar.length + '</span><button class="bd-next" type="button" aria-label="Pr\xF3xima se\xE7\xE3o">\u25B6</button></div>');
  }
  parts.push('<span class="bd-sig">' + escHtml(spec.badge || spec.title || "") + "</span>");
  parts.push("</div></footer>");
  parts.push("</div>");
  const head = "<style>" + css + "</style>" + themeStyle(spec._theme) + "<style>:root{--accent:" + accent + ";--accent-2:" + accentLight(accent) + "}</style>" + (spec.css ? "<style>" + spec.css + "</style>" : "");
  const scripts = narrated ? "<script>" + boardRuntime() + "\nBOARD_NAR(" + JSON.stringify(nar) + ");</script>" : "";
  return page(spec, head, parts.join("\n") + (scripts ? "\n" + scripts : ""));
}
async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("uso: node build-artifact.mjs <spec.json> [saida.html]");
    process.exit(1);
  }
  const spec = JSON.parse(read(resolve(specPath)));
  resolveTheme(spec, specPath);
  if (spec.story && !spec.layout) spec.layout = { rankdir: typeof spec.story === "object" && spec.story.rankdir || "LR" };
  if (spec.story) {
    const _acc = spec.accent || "#8ab4ff";
    for (const n of spec.nodes || []) {
      if (n.type === "box") {
        if (n.w == null) n.w = n.icon ? 228 : 196;
        if (n.h == null) n.h = n.icon ? 96 : 92;
        if (n.icon && n.iconColor == null) n.iconColor = _acc;
      }
    }
  }
  const lay = applyAutoLayout(spec);
  if (lay.applied) console.log("layout: dagre " + lay.rankdir + " -> " + lay.nodesPlaced + " n\xF3s posicionados, " + lay.edgesGenerated + " arestas geradas");
  const story = spec.explode ? { applied: false } : buildStorySteps(spec);
  if (story.applied) console.log("story: coreografia gerada -> " + story.steps + " passos (build-up + recap)");
  const expl = buildExplodeScenes(spec);
  if (expl.applied) console.log("explode: vista explodida -> " + expl.layers + " camadas, " + expl.steps + " passos (" + (expl.iso ? "iso" : "flat") + ")");
  await synthNarration(spec);
  const engine = spec.engine || "vxk";
  let html;
  if (spec.mode === "board") {
    html = buildBoard(spec);
  } else {
    html = engine === "konva" ? buildKonva(spec) : buildVxk(spec);
  }
  if (wantsNarration(spec) && process.env.VXK_ALLOW_SILENT !== "1") {
    if (engine === "konva") throw new Error('gate de \xE1udio: narra\xE7\xE3o ainda N\xC3O \xE9 suportada no engine "konva" (o player konva n\xE3o reproduz os clipes). Use o engine vxk (padr\xE3o) ou VXK_ALLOW_SILENT=1.');
    const clips = collectAudioClips(spec._audio).filter(isRealAudioClip);
    if (clips.length === 0) throw new Error("gate de \xE1udio: a spec quer narra\xE7\xE3o mas NENHUM clipe real foi assado (data:audio vazio/ausente). Motor de voz falhou ou o pipeline n\xE3o assou. Mudo deliberado: VXK_ALLOW_SILENT=1.");
    if (!/data:audio\/(ogg|mpeg|wav);base64,[A-Za-z0-9+/]{100,}/.test(html)) throw new Error("gate de \xE1udio: clipes assados n\xE3o foram embutidos no HTML (regress\xE3o de build). Mudo deliberado: VXK_ALLOW_SILENT=1.");
  }
  let out = process.argv[3];
  if (!out) {
    const d = desktopDir();
    if (!existsSync2(d)) mkdirSync2(d, { recursive: true });
    out = join2(d, slug(spec.slug || spec.title) + ".html");
  }
  writeFileSync2(out, html, "utf8");
  const tag = spec.mode === "board" ? "mode=board, blocos=" + (spec.blocks || []).length : "engine=" + engine + ", componentes=" + [...new Set((spec.nodes || []).map((n) => n.type))].join(",");
  console.log("OK  " + out + "  (" + Buffer.byteLength(html, "utf8") + " bytes, " + tag + (spec._audio ? ", narrado" : "") + ")");
}
main().catch((err2) => {
  console.error("ERRO  " + (err2 && err2.message || err2));
  process.exit(1);
});
/*! Bundled license information:

@dagrejs/dagre/dist/dagre.esm.js:
  (*! For license information please see dagre.esm.js.LEGAL.txt *)
*/
