#!/usr/bin/env node
'use strict';

// Stop hook DO voice-chat (empacotado no plugin — quem instala o voice-chat ganha ele).
// Registrado sob "agentStop" — o evento de fim-de-turno REAL do Copilot CLI (o público "Stop"
// do VS Code é DESCARTADO pelo CLI; o set válido é camelCase: sessionStart/agentStop/...).
// Payload REAL do CLI (1.0.71): { sessionId, transcriptPath, cwd, timestamp, stopReason } — camelCase.
// Modelo v1.5.16 (por TOOL): quem produz áudio é a TOOL `falar` da extensão (o agente chama quando
// quiser, várias vezes por turno, inclusive antes de uma pergunta). O hook NÃO coleta mais texto —
// ele só faz DUAS coisas, ambas via transcript/estado em disco:
//   1) ENFORCEMENT: se o turno teve resposta textual mas NÃO chamou a tool `falar`, BLOQUEIA pedindo
//      pra chamar (cap de blocks CONSECUTIVOS evita loop).
//   2) ADVISOR de canvas caído: heartbeat do fork com PID morto -> avisa o agente a rodar extensions_reload.

const fs = require('fs');
// Contrato cross-process (data dir, sanitização de sid, paths das filas) — ÚNICA fonte, igual à extensão.
const shared = require('./voice-shared.cjs');

const DATA_DIR = shared.resolveDataDir();

// ---- enforcement da tool `falar`: este turno chamou a tool de fala? ----------------------------
// Passada ÚNICA para frente, parseando CADA linha como JSON e resetando o escopo a cada evento cujo
// TOP-LEVEL .type === "user.message" (o turno atual = o último bloco após o último user.message). NÃO
// usa substring '"user.message"': args de OUTRAS tools podem conter esse literal aninhado UNESCAPED e
// falsear a fronteira do turno (-> false block/false ok). Detecta tool.execution_start cujo toolName
// CASA `falar` (token, tolera prefixo do CLI) -> spoke; e assistant.message com conteúdo -> hadText.
function isFalarTool(name) { return /(?:^|[^a-z0-9])falar$/i.test(String(name)); }
function readTurnSpeak(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); }
  catch { return { readable: false }; }
  // `spoke` = houve ALGUM `falar` no turno (mantido p/ compat + reset do contador). `unspokenTail` =
  // tamanho do texto do assistente que veio DEPOIS do ÚLTIMO `falar` (o resumo NÃO-falado do fim). Um
  // `falar` "cobre" o texto até ele -> zeramos o tail nele. Assim `falar` no COMEÇO não satisfaz o
  // resumo do FIM: o furo real (cue inicial contava como resumo) some.
  let sawUser = false, spoke = false, hadText = false, unspokenTail = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || !e.type) continue;
    if (e.type === 'user.message') { sawUser = true; spoke = false; hadText = false; unspokenTail = 0; continue; }   // novo turno -> zera o escopo
    if (e.type === 'tool.execution_start' && e.data && typeof e.data.toolName === 'string' && isFalarTool(e.data.toolName)) { spoke = true; unspokenTail = 0; }   // `falar` cobre o texto até aqui
    else if (e.type === 'assistant.message' && e.data && typeof e.data.content === 'string' && e.data.content.trim()) { hadText = true; unspokenTail += e.data.content.trim().length; }   // texto não-falado desde o último `falar`
  }
  return { readable: true, sawUser, spoke, hadText, unspokenTail };
}
// Piso do resumo FALÁVEL: texto não-falado no fim ABAIXO disso é fecho trivial (ex.: "pronto, commitado")
// e NÃO cobra; a partir daqui é conteúdo com valor que deve virar áudio. Tunável.
const SUMMARY_MIN_CHARS = 40;
// PURO (testável): 'ok' | 'block'. Bloqueia só quando há texto SUBSTANCIAL não-falado no FIM do turno
// (mede `unspokenTail`, não "chamou falar em algum lugar") — corrige o furo do cue inicial.
function decideSpeakEnforcement(state, suppressBlock) {
  if (!state || !state.readable) return 'ok';                              // sem transcript legível -> não trava o turno
  if (!state.sawUser || !state.hadText) return 'ok';                       // turno sem resposta textual -> nada a falar
  if ((Number(state.unspokenTail) || 0) < SUMMARY_MIN_CHARS) return 'ok';  // resumo final já falado, ou só fecho trivial
  if (suppressBlock) return 'ok';                                          // cap consecutivo estourou -> desiste (anti-loop)
  return 'block';
}
const SPEAK_REASON = 'Você respondeu sem produzir áudio para o usuário (a mensagem foi capturada por VOZ). Chame AGORA a ferramenta `falar` passando um texto natural em português do Brasil (1 a 3 frases curtas, sem markdown, sem listas, sem código e sem emojis) resumindo o essencial da sua resposta. É a tool `falar` que gera a voz.';

// ---- advisor DETERMINÍSTICO de canvas caído (caminho A->B->C: hook detecta -> avisa -> agente recarrega)
// O canvas é registrado pelo joinSession do fork da extensão e MORRE com o processo. Logo
// "canvas registrado <=> processo do fork vivo". A extensão grava forks/<sid>.json={pid,ts} e
// atualiza a cada 5s. Aqui checamos: PID vivo? (fato do SO) E heartbeat fresco? Se o PID está
// MORTO (ou o ts velho = fork travado / PID reusado), o canvas caiu -> avisamos o agente a rodar
// extensions_reload. Ausência do arquivo = voz nunca aberta nesta sessão -> não avisa (zero nag).
const HEARTBEAT_STALE_MS = 90000;   // fork atualiza a cada 5s; 90s tolera GC/stall/wake de sleep sem falso "caído"
const ADVISOR_MAX = 5;              // teto absoluto de avisos de reload por sessão (backstop anti-loop patológico)
function readForkHeartbeat(sid) {
  try {
    const hb = JSON.parse(fs.readFileSync(shared.forkHeartbeatFile(DATA_DIR, sid), 'utf8'));
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
// ---- estado por sessão (disco): anti block-storm por CONTADOR CONSECUTIVO -----------------------
// O CLI NÃO manda stop_hook_active E re-injeta o motivo do block como um NOVO prompt. Um cap por
// JANELA DE TEMPO falha: se os re-prompts vêm espaçados (turno lento), poucos blocks caem na janela
// e ele NUNCA estoura -> loop infinito. Então o cap é ABSOLUTO: nº de blocks CONSECUTIVOS por sid
// desde o último sucesso; ao chegar em MAX_BLOCKS, desiste (skip) — independente do tempo. Um turno
// que chamou `falar` (ou o próprio cap) ZERA o contador.
const MAX_BLOCKS = 3;
function stateFile(sid) {
  return shared.hookStateFile(DATA_DIR, sid);
}
function readState(sid) { try { return JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')) || {}; } catch { return {}; } }
function writeState(sid, st) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(stateFile(sid), JSON.stringify(st)); return true; }
  catch { return false; }   // não conseguiu PERSISTIR -> o chamador decide (fail-open p/ não dar block-storm)
}
function emitBlock(reason) {
  const out = { decision: 'block', reason, hookSpecificOutput: { hookEventName: 'agentStop', decision: 'block', reason } };
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(data); } catch { process.exit(0); }
    const sid = p.sessionId || p.session_id || '';
    const tp = p.transcriptPath || p.transcript_path || '';
    const st = sid ? readState(sid) : {};

    // Liveness do fork do canvas (fato do SO) — reusado no enforcement E no advisor. A tool `falar` VIVE
    // no fork; se ele morreu, pedir `falar` é IMPOSSÍVEL -> pulamos o enforcement e deixamos o advisor
    // pedir o reload (senão o usuário come 3 nags inúteis antes da dica que resolve).
    const hb = sid ? readForkHeartbeat(sid) : null;
    const forkAlive = hb ? (pidAlive(hb.pid) && (Date.now() - hb.ts) < HEARTBEAT_STALE_MS) : true;
    const forkDead = !!hb && !forkAlive;

    // 1) ENFORCEMENT da tool `falar` (cap CONSECUTIVO anti-loop). Pulado se o fork está morto. Fail-open
    //    se não der pra PERSISTIR o contador (sem persistência o cap não segura -> não bloqueia).
    const turn = readTurnSpeak(tp);
    const consec = Number(st.consecBlocks) || 0;
    const enf = forkDead ? 'ok' : decideSpeakEnforcement(turn, consec >= MAX_BLOCKS);
    if (enf === 'block') {
      if (!sid || !writeState(sid, { ...st, consecBlocks: consec + 1 })) process.exit(0);
      emitBlock(SPEAK_REASON);
      process.exit(0);
    }
    // Zera o contador só quando o turno CUMPRIU: teve texto E nada substancial ficou não-falado no fim
    // (resumo falado, ou tail trivial). NÃO no suppress (unspokenTail ainda alto -> compliant=false),
    // senão re-arma o storm; nem em turno sem texto (não é vitória de fala).
    const compliant = !!(turn && turn.hadText && (Number(turn.unspokenTail) || 0) < SUMMARY_MIN_CHARS);
    if (compliant && consec !== 0) st.consecBlocks = 0;

    // 2) ADVISOR determinístico de canvas caído (independente). Deduplicado por queda + teto ABSOLUTO
    //    ADVISOR_MAX por SESSÃO (NÃO reabastece em turno saudável: senão alternar saudável/morto burla o
    //    cap -> storm ilimitado). advisedCount = nº de quedas DISTINTAS já avisadas; conta só pra cima.
    //    Fail-open igual: só emite se conseguiu persistir o advisedCount.
    if (sid) {
      const advisedCount = Number(st.advisedCount) || 0;
      const adv = decideCanvasAdvisor(hb, forkAlive, st.advisedDropKey);
      if (adv.advise && advisedCount < ADVISOR_MAX) {
        if (writeState(sid, { ...st, advisedDropKey: adv.key, advisedCount: advisedCount + 1 })) emitBlock(CANVAS_RELOAD_REASON);
        process.exit(0);
      }
    }

    if (sid) writeState(sid, st);   // persiste resets (consecBlocks / advisedCount)
    process.exit(0);
  });
}

module.exports = { decideSpeakEnforcement, readTurnSpeak, isFalarTool, decideCanvasAdvisor, SUMMARY_MIN_CHARS };
