#!/usr/bin/env node
'use strict';

// postToolUseFailure hook DO voice-chat (empacotado no plugin — quem instala ganha ele).
// Registrado sob "postToolUseFailure": o evento DECLARATIVO/nativo do Copilot CLI que roda
// como PROCESSO EXTERNO, carregado globalmente pelo host — INDEPENDENTE do fork da extensão.
// Por isso ele dispara MESMO quando o canvas "voice-chat" não está registrado (é exatamente
// a hora em que o fork está relançando e o fork-in-process morreu com o canvas).
//
// Motivo (bug do usuário): quando `open_canvas`/`invoke_canvas_action` falha com "Canvas
// voice-chat is not registered" / "instance ... is not open", o agente NÃO recebia instrução
// de recuperação e DESISTIA. Aqui, no INSTANTE da falha, injetamos additionalContext dizendo
// pra REPETIR o open_canvas (o host está relançando; é transitório) em vez de desistir. O host
// anexa esse additionalContext ao resultado falho da tool (o modelo vê). (agent-author.md,
// copilot-win32-x64/sdk/index.d.ts HooksObject.postToolUseFailure L9092 + appendPostToolUse
// FailureContext L780.)

// Tools de canvas do host cuja falha nos interessa.
const CANVAS_TOOLS = new Set(['open_canvas', 'invoke_canvas_action', 'list_canvas_capabilities']);

// Assinatura do erro do host de canvas (CanvasRuntimeError) para os casos "ainda não pronto".
// Cobre: "No canvas \"voice-chat\" is registered." / "instance ... is not open. No canvases are
// currently open" — todos transitórios durante o relaunch do host de extensão.
const NOT_READY_RE = /(canvasruntimeerror|is not open|no canvases? are currently open|no canvas[\s\S]*is registered|not registered)/i;

// Duas CAUSAS do "not registered", com remédios diferentes:
//  (A) TRANSITÓRIO: host relançando ao TROCAR de sessão (~1-2s) -> repetir open_canvas cura sozinho.
//  (B) UPDATE staged (mudou a LÓGICA -> restart pendente): o fork antigo largou o canvas e ele NÃO
//      volta repetindo open_canvas; só `extensions_reload` (reimporta a lógica + re-registra) cura.
//      É o caso do usuário: "atualizei a voz sem fechar o app e o painel não reabre — precisa reload".
// A distinção vem do update-state.json (pendingVersion) — ver detectPendingRestart().
const RECOVERY_TRANSIENT =
  'O host de extensão está RELANÇANDO a voz (janela de ~1-2s, típica ao TROCAR de sessão): por isso o ' +
  'canvas "voice-chat" aparece como não registrado / instância não aberta. É TRANSITÓRIO — não é erro seu, ' +
  'nem falha de instalação, e NÃO precisa trocar de abordagem nem desistir. Aguarde ~1.5s e CHAME open_canvas ' +
  'de novo (canvasId "voice-chat"). Se falhar de novo, rode extensions_reload UMA vez (re-registra o canvas a ' +
  'partir do disco) e chame open_canvas mais uma vez.';
const RECOVERY_UPDATE =
  'Um UPDATE da extensão de voz foi baixado e mudou a LÓGICA (restart pendente): o fork antigo largou o canvas ' +
  '"voice-chat" e ele NÃO volta só repetindo open_canvas. AÇÃO AGORA: rode extensions_reload (reimporta a ' +
  'lógica nova e RE-REGISTRA o canvas) e então chame open_canvas (canvasId "voice-chat"). Só se AINDA falhar, ' +
  'peça ao usuário para reiniciar o app do Copilot. NÃO desista e NÃO fique repetindo open_canvas.';
// Alias retrocompat (algum consumidor externo pode importar RECOVERY).
const RECOVERY = RECOVERY_TRANSIENT;

// --- extração defensiva do payload (camelCase CLI 1.0.71 + variações de shape) -------------------
function extractToolName(p) {
  return String((p && (p.toolName || p.tool_name || (p.toolCall && p.toolCall.toolName))) || '');
}
// Junta todo texto onde a assinatura do erro pode aparecer (falha=error string; ou result object).
function extractBlob(p) {
  const parts = [];
  if (p) {
    if (typeof p.error === 'string') parts.push(p.error);
    const r = p.toolResult || p.tool_response || p.toolResponse || p.result;
    if (typeof r === 'string') parts.push(r);
    else if (r && typeof r === 'object') {
      for (const k of ['textResultForLlm', 'error', 'message', 'content', 'output', 'summary', 'text']) {
        if (typeof r[k] === 'string') parts.push(r[k]);
      }
    }
    const a = p.toolArgs || p.tool_input || p.toolInput || p.arguments;
    if (a) { try { parts.push(JSON.stringify(a)); } catch { /* ignore */ } }
  }
  return parts.join(' \n ');
}

// PURO (testável): injeta o recovery só quando é uma tool de canvas, a assinatura é "não pronto"
// E o alvo é o canvas da VOZ (não age por canvas de outra extensão). `pendingRestart` escolhe a
// orientação: true => há update de LÓGICA staged (só reload cura) => RECOVERY_UPDATE; senão o caso
// transitório de troca de sessão => RECOVERY_TRANSIENT.
function decideCanvasRecovery(toolName, blob, pendingRestart) {
  if (!CANVAS_TOOLS.has(toolName)) return { inject: false };
  if (!NOT_READY_RE.test(String(blob || ''))) return { inject: false };
  if (!/voice-chat/i.test(String(blob || ''))) return { inject: false };
  return { inject: true, context: pendingRestart ? RECOVERY_UPDATE : RECOVERY_TRANSIENT };
}

// EFEITO (runtime): há um app-restart pendente? Lê o update-state.json pelo MESMO resolveDataDir que a
// extensão usa (voice-shared.cjs vive no mesmo dir do hook). A extensão grava {pendingVersion} SEM
// appliedVersion ao stagear um update de LÓGICA, e limpa pendingVersion quando a versão em execução já
// alcançou (branch uptodate) — então a presença de pendingVersion é sinal honesto de "reinício pendente".
// Best-effort: qualquer erro (sem state, sem shared, sid diferente) => false (cai no fluxo transitório).
function detectPendingRestart() {
  try {
    const fs = require('fs');
    const path = require('path');
    const shared = require('./voice-shared.cjs');
    const st = JSON.parse(fs.readFileSync(path.join(shared.resolveDataDir(), 'update-state.json'), 'utf8'));
    return !!(st && st.pendingVersion);
  } catch { return false; }
}

function emit(context) {
  const out = {
    additionalContext: context,
    hookSpecificOutput: { hookEventName: 'postToolUseFailure', additionalContext: context },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(data); } catch { process.exit(0); }
    const d = decideCanvasRecovery(extractToolName(p), extractBlob(p), detectPendingRestart());
    if (d.inject) emit(d.context);
    process.exit(0);
  });
}

module.exports = { decideCanvasRecovery, detectPendingRestart, extractToolName, extractBlob, RECOVERY, RECOVERY_TRANSIENT, RECOVERY_UPDATE, NOT_READY_RE };
