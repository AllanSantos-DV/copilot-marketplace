// VENDORADO de vox-engine (src/vox_engine/client/node/vox_client.mjs) — nao editar a mao.
// Usado pelo build-artifact.mjs para sintetizar narracao (tts) no build. Standalone (so 'net').
// Cliente Node de referência do vox-engine (named pipe do Windows).
//
// Mesma fita binária do protocolo Python (protocol.py):
//   [uint32 BE json_len][uint32 BE audio_len][json utf-8][audio float32 LE]
//
// Roteia respostas por `req_id`, então suporta vários pedidos em voo (multissessão
// e testes de concorrência). Feito para consumidores Node puros (ex.: uma extensão
// que fale direto com o motor único em vez de subir o seu próprio engine).
import net from "node:net";

export const DEFAULT_PIPE = "\\\\.\\pipe\\vox";

const MAX_JSON = 4 * 1024 * 1024;
const MAX_AUDIO = 512 * 1024 * 1024;

export function encode(header, audio = Buffer.alloc(0)) {
  const jb = Buffer.from(JSON.stringify(header), "utf8");
  if (jb.length === 0 || jb.length > MAX_JSON) throw new Error(`json_len inválido: ${jb.length}`);
  if (audio.length > MAX_AUDIO) throw new Error(`audio muito grande: ${audio.length}`);
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(jb.length, 0);
  head.writeUInt32BE(audio.length, 4);
  return Buffer.concat([head, jb, audio]);
}

// Decodificador incremental: acumula chunks e emite frames completos.
export class FrameDecoder {
  constructor(onFrame) {
    this._buf = Buffer.alloc(0);
    this._onFrame = onFrame;
  }
  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      if (this._buf.length < 8) return;
      const jsonLen = this._buf.readUInt32BE(0);
      const audioLen = this._buf.readUInt32BE(4);
      if (jsonLen === 0 || jsonLen > MAX_JSON || audioLen > MAX_AUDIO) {
        throw new Error(`frame fora dos limites (json=${jsonLen}, audio=${audioLen})`);
      }
      const total = 8 + jsonLen + audioLen;
      if (this._buf.length < total) return;
      const header = JSON.parse(this._buf.subarray(8, 8 + jsonLen).toString("utf8"));
      const audio = Buffer.from(this._buf.subarray(8 + jsonLen, total)); // cópia (destaca do buf)
      this._buf = this._buf.subarray(total);
      this._onFrame(header, audio);
    }
  }
}

export class VoxClient {
  constructor(sock) {
    this.sock = sock;
    this.alive = true;
    this._ids = 0;
    this._pending = new Map();
    this._dec = new FrameDecoder((h, a) => this._onFrame(h, a));
    sock.on("data", (c) => {
      try {
        this._dec.push(c);
      } catch (e) {
        this._fail(e);
        try { sock.destroy(); } catch { /* noop */ }
      }
    });
    sock.on("close", () => this._fail(new Error("pipe fechado")));
    sock.on("error", () => { /* tratado via close */ });
  }

  static connect(pipeName = DEFAULT_PIPE, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: pipeName });
      const to = setTimeout(() => { sock.destroy(); reject(new Error("timeout ao conectar")); }, timeoutMs);
      sock.once("connect", () => { clearTimeout(to); resolve(new VoxClient(sock)); });
      sock.once("error", (e) => { clearTimeout(to); reject(e); });
    });
  }

  // Conecta se o daemon existir; senão resolve para null (reusa-se-existe).
  static async tryConnect(pipeName = DEFAULT_PIPE, opts = {}) {
    try {
      return await VoxClient.connect(pipeName, opts);
    } catch {
      return null;
    }
  }

  _onFrame(header, audio) {
    const rid = header.req_id;
    const p = rid != null ? this._pending.get(rid) : undefined;
    if (p) {
      clearTimeout(p.timer);
      this._pending.delete(rid);
      p.resolve({ header, audio });
    }
  }

  _fail(err) {
    if (!this.alive && this._pending.size === 0) return;
    this.alive = false;
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  request(header, audio = Buffer.alloc(0), { timeoutMs = 60000 } = {}) {
    const rid = header.req_id || `r${++this._ids}`;
    const framed = { ...header, req_id: rid };
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("cliente desconectado"));
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        reject(new Error(`timeout: ${header.cmd}`));
      }, timeoutMs);
      this._pending.set(rid, { resolve, reject, timer });
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

  async ping({ timeoutMs = 5000 } = {}) {
    const { header } = await this.request({ cmd: "ping" }, undefined, { timeoutMs });
    return header.event === "pong";
  }

  async info({ timeoutMs = 5000 } = {}) {
    return (await this.request({ cmd: "info" }, undefined, { timeoutMs })).header;
  }

  async openSession(session, defaults = {}) {
    return (await this.request({ cmd: "open_session", session, ...defaults })).header;
  }

  async set(session = "default", { lang, voice, priority } = {}, { timeoutMs = 5000 } = {}) {
    const p = { cmd: "set", session };
    if (lang != null) p.lang = lang;
    if (voice != null) p.voice = voice;
    if (priority != null) p.priority = priority;
    return (await this.request(p, undefined, { timeoutMs })).header;
  }

  async closeSession(session) {
    return (await this.request({ cmd: "close_session", session })).header;
  }

  async transcribe(samples, { lang = "", session = "default", priority = "interactive", timeoutMs = 120000 } = {}) {
    const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    const audio = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    const { header } = await this.request({ cmd: "transcribe", session, lang, priority }, audio, { timeoutMs });
    return header;
  }

  async tts(text, { voice = null, speed = 1.0, session = "default", priority = "interactive", format = "pcm", timeoutMs = 120000 } = {}) {
    const req = { cmd: "tts", session, text, voice, speed, priority };
    if (format && format !== "pcm") req.format = format;
    const { header, audio } = await this.request(req, undefined, { timeoutMs });
    if (format && format !== "pcm") return { header, audio };   // bytes codificados (Buffer)
    const n = Math.floor(audio.length / 4);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = audio.readFloatLE(i * 4);
    return { header, audio: f };
  }

  async encodeFormats({ timeoutMs = 5000 } = {}) {
    const info = (await this.request({ cmd: "info" }, undefined, { timeoutMs })).header;
    return info.encode_formats || ["pcm"];
  }

  close() {
    this.alive = false;
    try { this.sock.destroy(); } catch { /* noop */ }
  }
}

export async function isDaemonAvailable(pipeName = DEFAULT_PIPE, { timeoutMs = 500 } = {}) {
  const c = await VoxClient.tryConnect(pipeName, { timeoutMs });
  if (!c) return false;
  c.close();
  return true;
}

