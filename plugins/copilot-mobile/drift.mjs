// Pure phone→PC drift detection for the in-app bridge. NO I/O — the caller passes the measured
// counts, so this is fully unit-testable. Empirical basis (probe-bridge-detect, 3× runs):
//   • At onUserPromptSubmitted time the user's CURRENT prompt is NOT yet counted as a user.message
//     on disk (the parsed user.message count excludes it), and it is NOT yet in the app's live head.
//   • The app's live head NEVER sees the phone's turns — they go through the daemon's SEPARATE
//     runtime and only land on disk (cross-process isolation, proven).
// Therefore, with appHeadUsers = the count of user.message the app's runtime has processed:
//   drift = diskUsers - appHeadUsers   (>0 ⇒ that many phone turns the app's memory is missing)
// A guard discounts the rare race where the current prompt already flushed as the LAST disk user
// message (so it would otherwise be counted as +1 phantom drift).

const norm = (s) => String(s == null ? "" : s).trim();

/**
 * @param {object} p
 * @param {number} p.diskUsers       parsed user.message count in events.jsonl (-1 if unreadable)
 * @param {number} p.appHeadUsers    user.message count the app runtime has processed (-1 if unknown)
 * @param {string} [p.lastDiskUserText] text of the last user.message on disk (for the race guard)
 * @param {string} [p.currentPrompt]  the prompt being submitted now (for the race guard)
 * @returns {{drift:number, reason:string}} drift>=0; reason ∈ disk-unreadable|head-unknown|in-sync|phone-drift
 */
export function decidePhoneDrift({ diskUsers, appHeadUsers, lastDiskUserText, currentPrompt } = {}) {
  if (!Number.isFinite(diskUsers) || diskUsers < 0) return { drift: 0, reason: "disk-unreadable" };
  if (!Number.isFinite(appHeadUsers) || appHeadUsers < 0) return { drift: 0, reason: "head-unknown" };
  let extra = diskUsers - appHeadUsers;
  if (extra >= 1 && lastDiskUserText != null && currentPrompt != null && norm(lastDiskUserText) === norm(currentPrompt) && norm(currentPrompt) !== "") {
    extra -= 1; // the current prompt already flushed as the last disk turn → it's ours, not a phone turn
  }
  if (extra <= 0) return { drift: 0, reason: "in-sync" };
  return { drift: extra, reason: "phone-drift" };
}

/** Human warning shown to the user (visible) when drift is detected. */
export function driftUserMessage(n) {
  const m = n === 1 ? "1 mensagem recente do celular" : `${n} mensagens recentes do celular`;
  return `🔄 Esta sessão tem ${m} que ainda não está na memória deste chat. Reinicie o app (feche e abra) para sincronizar antes de continuar.`;
}

/** Hidden guidance appended to the agent's context so it proactively tells the user to resync. */
export function driftAgentContext(n) {
  return `NOTA DE SINCRONIA (sistema): há ${n} mensagem(ns) recente(s) que o usuário enviou pelo celular e que NÃO estão na sua memória desta sessão (seu contexto está incompleto). Antes de responder, avise o usuário para reiniciar o app (fechar e abrir) para sincronizar, e deixe claro que sua resposta pode não considerar essas mensagens.`;
}
