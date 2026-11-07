#!/usr/bin/env node
'use strict';

// Stop hook DO voice-chat (empacotado no plugin — quem instala o voice-chat ganha ele).
// Registrado sob "agentStop" — o evento de fim-de-turno REAL do Copilot CLI (o público "Stop"
// do VS Code é DESCARTADO pelo CLI; o set válido é camelCase: sessionStart/agentStop/...).
// Payload REAL do CLI (1.0.71): { sessionId, transcriptPath, cwd, timestamp, stopReason } — camelCase.
// Modelo v1.5.16 (por TOOL): quem produz áudio é a TOOL `falar` da extensão (o agente chama quando
// quiser, várias vezes por turno, inclusive antes de uma pergunta). O hook NÃO coleta mais texto —
// ele só faz DUAS coisas, ambas via transcript/estado em disco (cobrança configurável):
//   1) ENFORCEMENT: se o turno teve resposta textual mas NÃO chamou a tool `falar`, BLOQUEIA pedindo
//      pra chamar (cap de blocks CONSECUTIVOS evita loop).
//   2) Infra indisponível/desconhecida: aviso persistente + skip (NUNCA block).

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
// Piso do resumo FALÁVEL: texto não-falado no fim ABAIXO disso é fecho trivial (sign-off) e NÃO
// cobra; a partir daqui é conteúdo com valor que deveria ter virado áudio. Tunável por env
// (VOICE_SUMMARY_MIN_CHARS) p/ ajuste SEM release. Default alto o bastante para NÃO pegar fechos
// curtos ("Concluído, à disposição") — só um resumo real de fim de turno (parágrafo) dispara.
const SUMMARY_MIN_CHARS = (() => {
  const n = parseInt(process.env.VOICE_SUMMARY_MIN_CHARS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
})();
// PURO (testável): 'ok' | 'block'. Em modo RESUMO (fullRead=false) bloqueia só quando há texto
// SUBSTANCIAL não-falado no FIM do turno (mede `unspokenTail`). Em modo FALA COMPLETA (fullRead=true) a
// resposta É áudio via `falar` e o texto é só artefato — então NÃO cobra a cauda; só cobra se o turno
// produziu texto mas NÃO chamou `falar` NENHUMA vez (nada virou áudio).
function decideSpeakEnforcement(state, suppressBlock, fullRead) {
  if (!state || !state.readable) return 'ok';                              // sem transcript legível -> não trava o turno
  if (!state.sawUser || !state.hadText) return 'ok';                       // turno sem resposta textual -> nada a falar
  if (fullRead) {
    if (state.spoke) return 'ok';                                          // completo: houve `falar` -> ok (texto = artefato)
    if (suppressBlock) return 'ok';                                        // cap consecutivo estourou -> desiste (anti-loop)
    return 'block';                                                        // completo: produziu texto e NÃO falou nada
  }
  if ((Number(state.unspokenTail) || 0) < SUMMARY_MIN_CHARS) return 'ok';  // resumo final já falado, ou só fecho trivial
  if (suppressBlock) return 'ok';                                          // cap consecutivo estourou -> desiste (anti-loop)
  return 'block';
}
// Agente-facing -> INGLÊS e ENXUTO (o contrato de FORMATO vive na tool `falar`, não aqui; aqui só a
// regra de fim-de-turno). Rotulado `[voice-chat hook]` para o usuário ver que é o hook e não ele
// digitando. NOTA (pesquisa oficial Copilot CLI hooks-reference): p/ o agentStop FAZER o agente agir,
// o ÚNICO canal é decision:block + reason — que o CLI injeta como CONTINUAÇÃO do turno. NÃO há
// `additionalContext` no agentStop, e o "auto-submit como se o usuário tivesse digitado" é EXCLUSIVO do
// tipo de hook `prompt` no sessionStart. Logo a injeção visível é inevitável p/ enforcement de fim de
// turno; o que dá é (a) ser RARO (o caminho ideal chama `falar` por último e não dispara nada) e
// (b) no reblock, mandar falar SÓ o delta — nunca "refala tudo".
// Caso A — NENHUM `falar` no turno (resposta totalmente muda): fale a resposta.
const SPEAK_REASON_NONE = '[voice-chat hook] Voice session — every turn MUST end with a short spoken summary via the `falar` tool, then stop. This turn produced text but never called `falar`, so the user heard nothing. Call `falar` now to speak your reply, then write NO further assistant text. (Speaking format is in the `falar` tool description.)';
// Caso B — JÁ houve `falar`, mas você escreveu texto NOVO depois dele (o usuário NÃO ouviu esse trecho):
// fale SÓ o delta, sem repetir o que já foi falado. Corrige o "refala tudo de novo" que o dono relatou.
const SPEAK_REASON_TAIL = '[voice-chat hook] Voice session — you ALREADY spoke via `falar`, but then wrote NEW text AFTER your last `falar` that the user did not hear. Call `falar` now to speak ONLY that new part — a short spoken version of just what you added AFTER the last `falar`. Do NOT repeat what you already spoke. Then write NO further assistant text. Tip: next time put the final note INSIDE the `falar` call so nothing trails after it.';
// PURO (testável): escolhe o aviso conforme JÁ houve fala no turno. spoke=true -> houve `falar` e sobrou
// texto novo depois (fale só o delta); spoke=false -> turno mudo (fale a resposta).
function speakReasonFor(turn) { return (turn && turn.spoke) ? SPEAK_REASON_TAIL : SPEAK_REASON_NONE; }

// ---- prontidão POSITIVA: desconhecido nunca autoriza cobrança -----------------------------
const HEARTBEAT_STALE_MS = 90000;   // produtor atualiza a cada 5s
const ADVISOR_MAX = 5;              // teto absoluto de avisos persistidos por sessão
function readForkReadiness(sid) {
  if (typeof sid !== 'string' || !sid.trim()) return { ready: false, reason: 'missing-session', key: 'missing-session' };
  let hb;
  try { hb = JSON.parse(fs.readFileSync(shared.forkHeartbeatFile(DATA_DIR, sid), 'utf8')); }
  catch (e) {
    const reason = e && e.code === 'ENOENT' ? 'heartbeat-absent' : 'heartbeat-unreadable';
    return { ready: false, reason, key: reason };
  }
  return decideForkReadiness(hb, Date.now(), pidAlive);
}
// A prova de PID é injetada; shape, status e relógio são avaliados sem I/O.
function decideForkReadiness(hb, now, isPidAlive) {
  const invalid = { ready: false, reason: 'heartbeat-invalid', key: 'heartbeat-invalid' };
  if (!hb || typeof hb !== 'object' || Array.isArray(hb) ||
      !Number.isSafeInteger(hb.pid) || hb.pid <= 0 ||
      typeof hb.ts !== 'number' || !Number.isFinite(hb.ts) || hb.ts <= 0) return invalid;
  const key = hb.pid + ':' + hb.ts;
  let reason;
  if (hb.status !== 'ready') reason = 'heartbeat-not-ready';
  else if (now < hb.ts || now - hb.ts >= HEARTBEAT_STALE_MS) reason = 'heartbeat-stale';
  else if (!isPidAlive(hb.pid)) reason = 'heartbeat-dead-pid';
  return reason ? { ready: false, reason, key } : { ready: true };
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }   // inclusive EPERM: não temos prova positiva de prontidão
}
function decideCanvasAdvisor(readiness, alreadyAdvisedKey) {
  if (readiness.ready || readiness.key === alreadyAdvisedKey) return { advise: false };
  return { advise: true, key: readiness.key };
}
// agentStop não oferece additionalContext não bloqueante. O aviso suportado aqui é o
// diagnóstico PERSISTENTE em hook-state-<sid>.json.warning, consumido pela extensão no
// próximo onUserPromptSubmitted (additionalContext + session.log); stderr é redundância.
// Nunca emite decision:block por infraestrutura, nem ordena reload/uso de ferramentas.
function warnAndSkip(sid, st, readiness) {
  const advisedCount = Number(st.advisedCount) || 0;
  const adv = decideCanvasAdvisor(readiness, st.advisedDropKey);
  if (!adv.advise || advisedCount >= ADVISOR_MAX) return;
  const warning = {
    hook: 'agentStop', code: readiness.reason, timestamp: Date.now(),
    message: '[voice-chat hook] Cobrança de fala pulada: prontidão não comprovada (' + readiness.reason + '). Ferramentas e sessão liberadas. Verifique a configuração/host de voz se quiser reativar a cobrança.',
  };
  const persisted = writeState(sid, { ...st, advisedDropKey: adv.key, advisedCount: advisedCount + 1, warning });
  console.error(warning.message + (persisted ? ' Aviso salvo em ' + stateFile(sid) : ' Não foi possível persistir o aviso.'));
}
// ---- estado por sessão (disco): anti block-storm por CONTADOR CONSECUTIVO -----------------------
// O CLI NÃO manda stop_hook_active E re-injeta o motivo do block como um NOVO prompt. Um cap por
// JANELA DE TEMPO falha: se os re-prompts vêm espaçados (turno lento), poucos blocks caem na janela
// e ele NUNCA estoura -> loop infinito. Então o cap é ABSOLUTO: nº de blocks CONSECUTIVOS por sid
// desde o último sucesso; ao chegar em MAX_BLOCKS, desiste (skip) — independente do tempo. Um turno
// conforme ZERA o contador; atingir o cap NÃO o rearma.
// MAX_BLOCKS=1: UM único bloqueio por queda de fala, SEM escalar. Re-nag não compensa — o 2º/3º stop
// só arranca um "ok" degradado (ou repetição do que já foi dito), e o Voice Chat já guarda o histórico
// de áudios (até ~30 turnos), então re-cobrar a fala é redundante. Bloqueia 1x com a nova diretriz e para.
const MAX_BLOCKS = 1;
function stateFile(sid) {
  return shared.hookStateFile(DATA_DIR, sid);
}
function readState(sid) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
    if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('invalid hook state');
    for (const key of ['consecBlocks', 'advisedCount']) {
      if (st[key] !== undefined && (!Number.isSafeInteger(st[key]) || st[key] < 0)) throw new Error('invalid hook counter');
    }
    return st;
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e; // contador desconhecido NÃO rearma o budget de bloqueios
  }
}
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
    if (!p || typeof p !== 'object' || Array.isArray(p)) process.exit(0);
    const rawSid = p.sessionId || p.session_id;
    const sid = typeof rawSid === 'string' && rawSid.trim() ? rawSid : '';
    const tp = p.transcriptPath || p.transcript_path || '';
    let preferences;
    try { preferences = shared.readHookPreferencesStrict(DATA_DIR); }
    catch { /* erro vira aviso após recuperar o budget persistido, sem zerá-lo */ }
    if (preferences && !preferences.summaryEnforcement) process.exit(0); // só cobrança OFF: nenhum efeito sobre áudio

    let st;
    try { st = readState(sid); }
    catch {
      // Não sobrescrever contador corrompido, nem presumir budget disponível.
      console.error('[voice-chat hook] Estado anti-loop ilegível; cobrança pulada, ferramentas e sessão liberadas.');
      process.exit(0);
    }
    if (!preferences) { warnAndSkip(sid, st, { ready: false, reason: 'preferences-unreadable', key: 'preferences-unreadable' }); process.exit(0); }
    let mode;
    try { mode = sid ? shared.readSessionModeStrict(DATA_DIR, sid) : shared.MODE_DEFAULTS; }
    catch { warnAndSkip(sid, st, { ready: false, reason: 'session-mode-unreadable', key: 'session-mode-unreadable' }); process.exit(0); }
    if (!mode.voiceEnabled) process.exit(0); // conserva o OFF de voz legado por sessão

    const readiness = readForkReadiness(sid);
    if (!readiness.ready) { warnAndSkip(sid, st, readiness); process.exit(0); }

    // Cobrança só com preferência ON + sid + heartbeat válido/fresco/ready + PID vivo.
    // Falha em persistir o contador também libera o turno (anti-loop).
    const turn = readTurnSpeak(tp);
    // modo FALA COMPLETA é POR SESSÃO (modes/<sid>.json): a resposta é ÁUDIO via `falar`; o texto do chat
    // é só artefato (código/tabela/imagem), que NÃO se cobra como fala.
    const fullRead = mode.fullRead;
    const consec = Number(st.consecBlocks) || 0;
    const enf = decideSpeakEnforcement(turn, consec >= MAX_BLOCKS, fullRead);
    if (enf === 'block') {
      if (!sid || !writeState(sid, { ...st, consecBlocks: consec + 1 })) process.exit(0);
      emitBlock(speakReasonFor(turn));   // Caso B (já falou, sobrou texto) -> fala SÓ o delta; Caso A -> fala a resposta
      process.exit(0);
    }
    // Zera o contador só quando o turno CUMPRIU. Em RESUMO: teve texto E nada substancial ficou não-falado
    // no fim. Em FALA COMPLETA: houve ao menos um `falar` (a resposta virou áudio; o texto é artefato).
    // NÃO no suppress (senão re-arma o storm); nem em turno sem texto (não é vitória de fala).
    const compliant = fullRead
      ? !!(turn && turn.spoke)
      : !!(turn && turn.hadText && (Number(turn.unspokenTail) || 0) < SUMMARY_MIN_CHARS);
    if (compliant && consec !== 0) st.consecBlocks = 0;

    if (sid) writeState(sid, st);   // persiste resets (consecBlocks / advisedCount)
    process.exit(0);
  });
}

module.exports = { decideSpeakEnforcement, readTurnSpeak, isFalarTool, decideCanvasAdvisor, decideForkReadiness, SUMMARY_MIN_CHARS, speakReasonFor };
