// kit/lib/tts_cache.mjs — cache endereçado por conteúdo para narração TTS (PURO, sem dep).
//
// HEXAGONAL:
//   • PORT   : cache = { get(key)->Buffer|null, put(key,Buffer) }  (injetável; testável em memória)
//   • ADAPTER: makeFileCache(dir) — implementa a PORT sobre o filesystem (única parte com I/O)
//   • CORE   : ttsKey() (hash puro) + cached() (decorator puro sobre a PORT + uma synthFn injetada)
//
// A chave inclui engineVersion+voice+format+speed → trocar de motor/voz gera MISS natural
// (invalidação correta, sem precisar limpar o cache). synthFn é a porta do motor (bytes de áudio).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// CORE — chave determinística. \u0000 separa campos (não colide com texto).
// CACHE_SCHEMA: bump se o formato de chave/envelope mudar (busta o cache antigo de propósito).
export const CACHE_SCHEMA = 'v1';
export function ttsKey({ engine = '', voice = '', format = '', speed = 1, text = '' }) {
  return createHash('sha256')
    .update([CACHE_SCHEMA, String(engine), String(voice), String(format), String(speed), String(text)].join('\u0000'))
    .digest('hex');
}

// diretório default do cache (override por env). Windows: %USERPROFILE%\.cache\vxk-tts
export function defaultCacheDir() {
  return process.env.VXK_TTS_CACHE_DIR || join(os.homedir(), '.cache', 'vxk-tts');
}

// ADAPTER de filesystem para a PORT {get,put}. Escrita ATÔMICA (tmp+rename); valida bytes>0.
export function makeFileCache(dir = defaultCacheDir()) {
  let ready = false;
  const ensure = () => { if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; } };
  return {
    dir,
    get(key) {
      const p = join(dir, key + '.bin');
      if (!existsSync(p)) return null;
      try { if (statSync(p).size === 0) return null; return readFileSync(p); } // vazio = miss
      catch { return null; }
    },
    put(key, buf) {
      if (!buf || buf.length === 0) return;                 // nunca cacheia vazio
      ensure();
      const final = join(dir, key + '.bin');
      const tmp = join(dir, key + '.' + process.pid + '.' + Date.now() + '.tmp');
      try {
        writeFileSync(tmp, buf);
        renameSync(tmp, final);                              // atômico no mesmo volume
      } catch (e) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* noop */ }  // não deixa .tmp órfão
        throw e;
      }
    },
  };
}

// CORE — decorator: envolve synthFn(text)->Promise<Buffer> com a PORT de cache.
// Fail-OPEN: qualquer erro no cache jamais quebra o build (sintetiza e segue).
// VXK_NO_CACHE=1 desliga (bypass total).
export function cached(cache, meta, synthFn) {
  const off = process.env.VXK_NO_CACHE === '1';
  let warned = false;
  const warnOnce = (e) => { if (!warned) { warned = true; console.warn('WARN  cache TTS indisponível (seguindo sem cache): ' + (e && e.message || e)); } };
  return async (text) => {
    if (off) return { audio: await synthFn(text), cached: false };
    const key = ttsKey({ ...meta, text });
    let hit = null;
    try { hit = cache.get(key); } catch (e) { warnOnce(e); hit = null; }
    if (hit) return { audio: hit, cached: true };
    const audio = await synthFn(text);
    try { cache.put(key, audio); } catch (e) { warnOnce(e); }   // fail-open: não cacheou, tudo bem
    return { audio, cached: false };
  };
}
