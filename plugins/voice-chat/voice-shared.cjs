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

module.exports = {
  resolveDataDir, sanitizeSid,
  forksDir, forkHeartbeatFile, pendingDir, pendingSpeakFile, hookStateFile,
};
