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

// ---- advisor DETERMINÍSTICO de canvas caído (caminho A->B->C: hook detecta -> avisa -> agente recarrega)
// O canvas é registrado pelo joinSession do fork da extensão e MORRE com o processo. Logo
// "canvas registrado <=> processo do fork vivo". A extensão grava forks/<sid>.json={pid,ts} e
// atualiza a cada 5s. Aqui checamos: PID vivo? (fato do SO) E heartbeat fresco? Se o PID está
// MORTO (ou o ts velho = fork travado / PID reusado), o canvas caiu -> avisamos o agente a rodar
// extensions_reload. Ausência do arquivo = voz nunca aberta nesta sessão -> não avisa (zero nag).
const FORKS_DIR = path.join(DATA_DIR, 'forks');
const HEARTBEAT_STALE_MS = 90000;   // fork atualiza a cada 5s; 90s tolera GC/stall/wake de sleep sem falso "caído"
const ADVISOR_MAX = 5;              // teto absoluto de avisos de reload por sessão (backstop anti-loop patológico)
function readForkHeartbeat(sid) {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(FORKS_DIR, String(sid || 'nosid').replace(/[^A-Za-z0-9._-]/g, '_') + '.json'), 'utf8'));
    if (hb && typeof hb.pid === 'number' && hb.pid > 0 && Number(hb.ts) > 0) return { pid: hb.pid, ts: Number(hb.ts) };
  } catch { /* ausente/corrompido = voz nunca aberta aqui -> não avisa */ }
  return null;
}
function pidAlive(pid) {
  if (!pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; }        // sinal 0 = só testa existência (fato do SO)
  catch (e) { return !!(e && e.code === 'EPERM'); }  // EPERM = existe sem permissão -> vivo; ESRCH -> morto
}
// PURO (testável): decide se avisa o reload. `alive` já resolvido pelo chamador (PID + frescor).
function decideCanvasAdvisor(hb, alive, alreadyAdvisedKey) {
  if (!hb || !hb.pid) return { advise: false };   // sem heartbeat -> voz nunca aberta -> não avisa
  if (alive) return { advise: false };            // fork vivo -> canvas registrado -> nada a fazer
  const key = hb.pid + ':' + (hb.ts || 0);        // instância única do fork morto (dedup por queda)
  if (key === alreadyAdvisedKey) return { advise: false };   // já avisou ESTA queda -> não repete
  return { advise: true, key };
}
const CANVAS_RELOAD_REASON = 'O canvas de voz desta sessão caiu: o processo do host da extensão que registrava o canvas morreu (por isso apareceria "Canvas not registered" ao abrir o painel). Rode AGORA a ferramenta extensions_reload para re-lançar o host e re-registrar o canvas de voz desta sessão.';
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

    // BLOCK do 🔊 tem PRIORIDADE (não perder o resumo). O advisor de canvas espera o próximo turno.
    if (decision.action === 'block') {
      if (sid) writeState(sid, { ...st, consecBlocks: consec + 1 });
      const out = {
        decision: 'block', reason: decision.reason,
        hookSpecificOutput: { hookEventName: 'agentStop', decision: 'block', reason: decision.reason },
      };
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(0);
    }

    // COLETA (enqueue): escreve o resumo na FILA EM ARQUIVO por sid (mutando st; persistido abaixo).
    if (decision.action === 'enqueue' && sid) {
      if (!(dedupKey && st.enqueuedKey === dedupKey)) appendPending(sid, decision.summary, dedupKey);
      st.consecBlocks = 0; st.enqueuedKey = dedupKey;
    }

    // ADVISOR determinístico (A->B->C): canvas caído (PID do fork morto)? -> avisa o agente a recarregar.
    // Roda tanto no 'skip' (turno só-tool) quanto após coletar o 🔊. Deduplicado por queda (uma vez só)
    // + teto absoluto ADVISOR_MAX por sessão (backstop se o reload nunca estabilizar a fork).
    if (sid) {
      const hb = readForkHeartbeat(sid);
      const alive = hb ? (pidAlive(hb.pid) && (Date.now() - hb.ts) < HEARTBEAT_STALE_MS) : true;
      if (hb && alive && (Number(st.advisedCount) || 0) !== 0) st.advisedCount = 0;   // fork saudável -> reabastece o teto
      const advisedCount = Number(st.advisedCount) || 0;
      const adv = decideCanvasAdvisor(hb, alive, st.advisedDropKey);
      if (adv.advise && advisedCount < ADVISOR_MAX) {
        writeState(sid, { ...st, advisedDropKey: adv.key, advisedCount: advisedCount + 1 });   // persiste tudo
        const out = {
          decision: 'block', reason: CANVAS_RELOAD_REASON,
          hookSpecificOutput: { hookEventName: 'agentStop', decision: 'block', reason: CANVAS_RELOAD_REASON },
        };
        process.stdout.write(JSON.stringify(out) + '\n');
        process.exit(0);
      }
    }

    // persiste o estado do enqueue (ou o reset do advisedCount) e sai.
    if (sid && (decision.action === 'enqueue' || st.advisedCount === 0)) writeState(sid, st);
    process.exit(0);
  });
}

module.exports = { decideVoiceSummary, lastAssistantMessage, decideCanvasAdvisor };
