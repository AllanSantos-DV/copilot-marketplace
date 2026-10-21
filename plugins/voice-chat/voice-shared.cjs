'use strict';
// Contrato CROSS-PROCESS compartilhado pelo hook (voice-summary-stop.cjs, CommonJS) E pela extensão
// (extension.mjs, ESM que importa este .cjs). Centraliza a resolução do data dir, a sanitização de sid
// e os derivadores de path das filas/estado em disco — para que os DOIS processos NUNCA divirjam.
// (A v1.5.15 teve bug real por `resolveDataDir`/heartbeat divergirem entre extensão e hook; aqui isso
// deixa de ser possível por construção.) Regra: é o ÚNICO lugar onde esses paths/shape são definidos.

const path = require('path');
const os = require('os');

// Resolve o data dir: honra VOICE_DATA_DIR; senão o marcador ".copilot" a partir do dir DESTE arquivo
// (o hook e a extensão vivem no MESMO diretório do plugin), com fallback p/ ~/.copilot.
function resolveDataDir() {
  if (process.env.VOICE_DATA_DIR) return process.env.VOICE_DATA_DIR;
  const marker = path.sep + '.copilot' + path.sep;
  const i = __dirname.indexOf(marker);
  const home = i >= 0 ? __dirname.slice(0, i + marker.length - 1) : path.join(os.homedir(), '.copilot');
  return path.join(home, 'voice-chat-data');
}

// Sanitiza um sid para nome de arquivo seguro (anti path-traversal). IDÊNTICO nos dois processos.
function sanitizeSid(sid) {
  return String(sid || 'nosid').replace(/[^A-Za-z0-9._-]/g, '_');
}

// Derivadores de path (o dataDir é passado pelo chamador: a extensão pode ter migrado o legacy
// artifacts/, então cada processo passa o SEU ARTIFACTS já resolvido — mas o SHAPE é único aqui).
function forksDir(dataDir) { return path.join(dataDir, 'forks'); }
function forkHeartbeatFile(dataDir, sid) { return path.join(forksDir(dataDir), sanitizeSid(sid) + '.json'); }
function pendingDir(dataDir) { return path.join(dataDir, 'pending'); }
function pendingSpeakFile(dataDir, sid) { return path.join(pendingDir(dataDir), sanitizeSid(sid) + '.jsonl'); }
function hookStateFile(dataDir, sid) { return path.join(dataDir, 'hook-state-' + sanitizeSid(sid) + '.json'); }
function hookWarningReceiptFile(dataDir, sid, key) { return path.join(dataDir, 'hook-warning-seen-' + sanitizeSid(sid) + '-' + key + '.json'); }
// Modo POR SESSÃO (fullRead / voiceEnabled): diferente dos demais toggles (globais no
// settings.json), estes flags são PER-SID — ligar num painel não afeta as outras sessões.
// Arquivo modes/<sid>.json = { fullRead?: bool, voiceEnabled?: bool }. ÚNICA fonte do path
// (hook + extensão leem o MESMO arquivo -> nunca divergem).
// Defaults: fullRead=false (resumo), voiceEnabled=true (voz ligada).
function sessionModesDir(dataDir) { return path.join(dataDir, 'modes'); }
function sessionModeFile(dataDir, sid) { return path.join(sessionModesDir(dataDir), sanitizeSid(sid) + '.json'); }

const MODE_DEFAULTS = { fullRead: false, voiceEnabled: true };

// Leitura ESTRITA p/ API/UI/write: arquivo ausente -> defaults; JSON inválido -> throw
// (nunca inventa ON saudável a partir de lixo). sid vazio -> throw.
function readSessionModeStrict(dataDir, sid) {
  if (!sid) throw new Error('missing sid');
  const fs = require('fs');
  const fp = sessionModeFile(dataDir, sid);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ...MODE_DEFAULTS };
    throw e;
  }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) {
    const err = new Error('invalid session mode json');
    err.code = 'INVALID_MODE_JSON';
    err.cause = e;
    throw err;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    const err = new Error('invalid session mode json');
    err.code = 'INVALID_MODE_JSON';
    throw err;
  }
  return {
    fullRead: m.fullRead === true,
    // ausente => default ON (retrocompat com modes/<sid> só de fullRead)
    voiceEnabled: m.voiceEnabled !== false,
  };
}

// Leitura PERMISSIVA p/ runtime de hooks/tool: fail-open. sid vazio / ausente / lixo -> true
// (voz ligada = comportamento legado; só OFF EXPLÍCITO desliga). Loga parse inválido.
function readSessionVoiceEnabled(dataDir, sid) {
  if (!sid) return true;
  try {
    return readSessionModeStrict(dataDir, sid).voiceEnabled !== false;
  } catch (e) {
    if (e && e.code === 'INVALID_MODE_JSON') {
      try { console.error('[voice-shared] modes/' + sanitizeSid(sid) + '.json inválido — voiceEnabled fail-open true'); } catch { /* ignore */ }
    }
    return true;
  }
}

// Leitura resiliente de fullRead: sid vazio / ausente / corrompido -> false (resumo).
function readSessionFullRead(dataDir, sid) {
  if (!sid) return false;
  try {
    return !!readSessionModeStrict(dataDir, sid).fullRead;
  } catch { return false; }
}

// Merge-write: lê o arquivo existente (strict), aplica patch, grava. NÃO repara JSON corrompido
// (write falha e o arquivo lixo fica intacto). sid vazio -> false.
function writeSessionModePatch(dataDir, sid, patch) {
  if (!sid) return false;
  const fs = require('fs');
  const fp = sessionModeFile(dataDir, sid);
  let cur;
  try {
    cur = readSessionModeStrict(dataDir, sid);
  } catch (e) {
    // ENOENT já vira defaults em strict; qualquer outro (incl. INVALID_MODE_JSON) = não grava
    return false;
  }
  const next = {
    fullRead: Object.prototype.hasOwnProperty.call(patch, 'fullRead') ? !!patch.fullRead : !!cur.fullRead,
    voiceEnabled: Object.prototype.hasOwnProperty.call(patch, 'voiceEnabled') ? !!patch.voiceEnabled : (cur.voiceEnabled !== false),
  };
  try {
    fs.mkdirSync(sessionModesDir(dataDir), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(next));
    return true;
  } catch { return false; }
}

function writeSessionFullRead(dataDir, sid, val) {
  return writeSessionModePatch(dataDir, sid, { fullRead: !!val });
}

function writeSessionVoiceEnabled(dataDir, sid, val) {
  return writeSessionModePatch(dataDir, sid, { voiceEnabled: !!val });
}

// Cobrança de resumo é GLOBAL e independente de voiceEnabled/TTS. Fora do pacote e do
// settings.json (que a extensão regrava): OFF sobrevive a reload, novas sessões e upgrades.
function hookPreferencesFile(dataDir) { return path.join(dataDir, 'hook-preferences.json'); }
function readHookPreferencesStrict(dataDir) {
  const fs = require('fs');
  let raw;
  try { raw = fs.readFileSync(hookPreferencesFile(dataDir), 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { summaryEnforcement: true };
    throw e;
  }
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.prototype.hasOwnProperty.call(value, 'summaryEnforcement') && typeof value.summaryEnforcement !== 'boolean')) {
    throw new Error('invalid hook preferences');
  }
  return { summaryEnforcement: true, ...value };
}
// API administrativa: boolean estrito, preserva outros campos, não repara configuração
// inválida silenciosamente. Rename no mesmo diretório evita expor JSON parcial ao hook.
// Retorna o objeto gravado; falhas de leitura/escrita são lançadas ao chamador.
function writeSummaryEnforcement(dataDir, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('summaryEnforcement must be boolean');
  const fs = require('fs');
  const next = { ...readHookPreferencesStrict(dataDir), summaryEnforcement: enabled };
  fs.mkdirSync(dataDir, { recursive: true });
  const target = hookPreferencesFile(dataDir);
  const temp = target + '.' + require('crypto').randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* já renomeado, ou criação falhou */ }
  }
  return next;
}

module.exports = {
  resolveDataDir, sanitizeSid,
  hookPreferencesFile, readHookPreferencesStrict, writeSummaryEnforcement,
  forksDir, forkHeartbeatFile, pendingDir, pendingSpeakFile, hookStateFile, hookWarningReceiptFile,
  sessionModesDir, sessionModeFile, MODE_DEFAULTS,
  readSessionModeStrict, readSessionVoiceEnabled, readSessionFullRead,
  writeSessionModePatch, writeSessionFullRead, writeSessionVoiceEnabled,
};
