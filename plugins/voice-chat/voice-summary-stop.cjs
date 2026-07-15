#!/usr/bin/env node
'use strict';

// Stop hook DO voice-chat (empacotado no plugin — quem instala o voice-chat ganha ele).
// Registrado sob "agentStop" — o evento de fim-de-turno REAL do Copilot CLI (o público "Stop"
// do VS Code é DESCARTADO pelo CLI; o set válido é camelCase: sessionStart/agentStop/...).
// Payload REAL do CLI (1.0.71): { sessionId, transcriptPath, cwd, timestamp, stopReason } —
// camelCase, SEM last_assistant_message e SEM stop_hook_active. Por isso a última mensagem sai
// do transcript (JSONL) e o anti-loop usa um contador em disco (não o flag inexistente).
// Objetivo: garantir que TODA resposta termine com o resumo falado (linha "🔊 …") E coletar
// esse resumo numa FILA EM ARQUIVO por sessão — SEM depender de servidor/canvas no ar.
//   - Falta o 🔊  -> BLOQUEIA o Stop e pede o resumo. SEMPRE bloqueia (em qualquer sessão); só um
//                    cap de blocks CONSECUTIVOS (por sid) evita loop infinito se nunca vier o 🔊.
//   - Tem o 🔊    -> escreve o texto em <voice-chat-data>/pending/<sid>.jsonl.
// A EXTENSÃO — quando o canvas carrega, quando o servidor ativa E num sweep periódico — drena esse
// arquivo, sintetiza e toca; ao COMEÇAR a tocar marca como lido. Quem COLETA é o hook (roda a cada
// Stop, em QUALQUER sessão); a extensão só CONSOME/toca — funciona com canvas fechado / servidor caído.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Resolve o data dir IGUAL à extensão (extension.mjs resolveDataDir): honra VOICE_DATA_DIR, senão
// o marcador ".copilot" a partir do dir do plugin (__dirname). Se divergisse, o drain leria uma
// pasta vazia e todo resumo se perderia em silêncio (instalação fora de ~/.copilot).
function resolveDataDir() {
  if (process.env.VOICE_DATA_DIR) return process.env.VOICE_DATA_DIR;
  const marker = path.sep + '.copilot' + path.sep;
  const i = __dirname.indexOf(marker);
  const home = i >= 0 ? __dirname.slice(0, i + marker.length - 1) : path.join(os.homedir(), '.copilot');
  return path.join(home, 'voice-chat-data');
}
const DATA_DIR = resolveDataDir();
const PENDING_DIR = path.join(DATA_DIR, 'pending');

// ---- núcleo PURO (testável): decide o que fazer com a última mensagem do assistente ----
// Devolve { action: 'enqueue'|'block'|'skip', summary?, reason? }.
function decideVoiceSummary(msg, stopHookActive) {
  const text = typeof msg === 'string' ? msg : '';
  // O resumo falado TEM que ser a ÚLTIMA linha não-vazia da resposta. Se o 🔊 aparecer no meio,
  // dentro de um code fence, ou numa citação (com conteúdo real depois), NÃO é o resumo final:
  // não coleta (seria o texto errado) e não satisfaz o enforcement (exige o resumo de verdade).
  const lines = text.split(/\r?\n/);
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { last = lines[i]; break; } }
  if (!last) return { action: 'skip' };   // turno sem texto (só tool calls) -> não exige resumo
  const m = last.match(/^[^\S\r\n]*🔊[^\S\r\n]*(\S.*?)[^\S\r\n]*$/u);
  if (m) {
    const summary = m[1].trim();
    // Precisa ter conteúdo FALÁVEL de verdade (ao menos 1 letra/número) DEPOIS de tirar tags HTML.
    // "🔊 **✅**" ou "🔊 <b></b>" limpariam pra vazio no cleanForSpeech do /speak -> áudio mudo:
    // trata como resumo AUSENTE (o texto cru vai pro /speak; o servidor faz a limpeza completa).
    if (/[\p{L}\p{N}]/u.test(summary.replace(/<[^>]+>/g, ''))) return { action: 'enqueue', summary };
  }
  if (stopHookActive) return { action: 'skip' };   // já bloqueou ESTA mensagem -> não loopar
  return {
    action: 'block',
    reason: 'Adicione ao FINAL da resposta uma ÚLTIMA linha começando exatamente com "🔊 " seguida de 1 a 3 frases curtas em português do Brasil, naturais e completas, resumindo a sua resposta. Sem markdown, sem listas, sem código e sem outros emojis. Essa linha é o que vira áudio na voz.',
  };
}

// ---- última mensagem do assistente: SEMPRE do transcript (JSONL) — fonte autoritativa do CLI.
// O CLI 1.0.71 NÃO manda last_assistant_message; NÃO confiamos nesse campo (evita um payload
// legado/forjado sobrepor o transcript real). O caminho é transcriptPath (camelCase; fallback snake).
// Devolve { content, id } — o id (messageId do evento) é a chave de dedup: dois turnos com texto
// IDÊNTICO têm messageIds DIFERENTES (ambos coletam); um re-fire do mesmo turno tem o mesmo id.
function lastAssistant(payload) {
  const tp = payload && (payload.transcriptPath || payload.transcript_path);
  if (tp && fs.existsSync(tp)) {
    try {
      const lines = fs.readFileSync(tp, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t) continue;
        let e;
        try { e = JSON.parse(t); } catch { continue; }
        if (e && e.type === 'assistant.message' && e.data && typeof e.data.content === 'string' && e.data.content.trim()) {
          return { content: e.data.content, id: String(e.data.messageId || '') };
        }
      }
    } catch { /* fail-open */ }
  }
  return { content: '', id: '' };
}
function lastAssistantMessage(payload) { return lastAssistant(payload).content; }

// ---- coleta: FILA EM ARQUIVO por sessão (não depende de servidor nem de canvas) --------------
// O hook só ESCREVE o texto do resumo aqui; a extensão drena/sintetiza/toca quando sobe.
function pendingFile(sid) {
  return path.join(PENDING_DIR, String(sid || 'nosid').replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl');
}
function appendPending(sid, summary, id) {
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.appendFileSync(pendingFile(sid), JSON.stringify({ sid, id, spoken: summary, ts: Date.now() }) + '\n');
    return true;
  } catch { return false; }
}
// ---- estado por sessão (disco): anti block-storm por CONTADOR CONSECUTIVO + dedup de escrita ----
// O CLI NÃO manda stop_hook_active E re-injeta o motivo do block como um NOVO prompt. Um cap por
// JANELA DE TEMPO falha: se os re-prompts vêm espaçados (turno lento), poucos blocks caem na janela
// e ele NUNCA estoura -> loop infinito. Então o cap é ABSOLUTO: nº de blocks CONSECUTIVOS por sid
// desde o último sucesso; ao chegar em MAX_BLOCKS, desiste (skip) — independente do tempo. Um enqueue
// (🔊 veio) ZERA o contador. O enqueuedKey (messageId) evita escrever o MESMO resumo 2x num re-fire.
const MAX_BLOCKS = 3;
function hashMsg(msg) { return crypto.createHash('sha256').update(String(msg || '')).digest('hex'); }
function stateFile(sid) {
  return path.join(DATA_DIR, 'hook-state-' + String(sid || 'nosid').replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
}
function readState(sid) { try { return JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')) || {}; } catch { return {}; } }
function writeState(sid, st) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(stateFile(sid), JSON.stringify(st)); } catch { /* best-effort */ }
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(data); } catch { process.exit(0); }
    const sid = p.sessionId || p.session_id || '';
    const { content: msg, id: msgId } = lastAssistant(p);
    const dedupKey = msgId || hashMsg(msg);   // messageId do CLI; fallback = hash do conteúdo
    const st = sid ? readState(sid) : {};

    // anti block-storm: blocks CONSECUTIVOS desde o último sucesso; no cap, suprime o block (skip).
    const consec = Number(st.consecBlocks) || 0;
    const decision = decideVoiceSummary(msg, consec >= MAX_BLOCKS);   // no cap -> skip no lugar de block
    if (decision.action === 'skip') process.exit(0);

    // BLOCK: SEMPRE bloqueia se faltar o 🔊 — em QUALQUER sessão, SEM depender de servidor/canvas.
    if (decision.action === 'block') {
      if (sid) writeState(sid, { ...st, consecBlocks: consec + 1 });
      const out = {
        decision: 'block', reason: decision.reason,
        hookSpecificOutput: { hookEventName: 'agentStop', decision: 'block', reason: decision.reason },
      };
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(0);
    }

    // COLETA: escreve o resumo na FILA EM ARQUIVO por sid (independente de servidor/canvas).
    // A extensão drena/sintetiza/toca quando o canvas carrega, quando o servidor ativa e no sweep.
    if (!sid) process.exit(0);
    if (dedupKey && st.enqueuedKey === dedupKey) process.exit(0);   // dedup: mesmo resumo já escrito
    appendPending(sid, decision.summary, dedupKey);
    writeState(sid, { consecBlocks: 0, enqueuedKey: dedupKey });   // sucesso -> zera o contador de block
    process.exit(0);
  });
}

module.exports = { decideVoiceSummary, lastAssistantMessage };
