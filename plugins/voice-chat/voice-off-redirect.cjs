'use strict';
// Lógica PURA: quando voiceEnabled=false e o agente chama `falar`, intercepta e devolve
// o texto para o modelo publicar no chat (PreToolUse deny + handler de segurança).
// Sem I/O, sem SDK — testável e reutilizável pelo extension.mjs.

function isFalarToolName(name) {
  return /(?:^|[^a-z0-9])falar$/i.test(String(name || ''));
}

function extractFalarText(args) {
  let a = args;
  // Host às vezes manda JSON-string, ou envelopa em arguments/input/toolArgs.
  if (typeof a === 'string') {
    const s = a.trim();
    if (!s) return '';
    try { a = JSON.parse(s); } catch { return s; }
  }
  if (!a || typeof a !== 'object') return '';
  if (typeof a.texto === 'string' || typeof a.text === 'string') {
    return String(a.texto ?? a.text ?? '').trim();
  }
  for (const k of ['arguments', 'input', 'toolArgs', 'tool_input', 'toolInput', 'params', 'parameters']) {
    if (a[k] != null && a[k] !== a) {
      const inner = extractFalarText(a[k]);
      if (inner) return inner;
    }
  }
  return '';
}

function voiceOffRedirectMessage(text) {
  const t = String(text || '').trim();
  if (!t) {
    return '[voice-chat] Voz OFF nesta sessão — não use a tool `falar`. Responda só em texto no chat.';
  }
  return (
    '[voice-chat] Voz OFF nesta sessão — NADA foi falado em áudio.\n\n' +
    'Texto que você tentou falar (publique isto como mensagem de TEXTO no chat agora):\n\n' +
    t +
    '\n\n· Escreva o conteúdo acima como sua resposta normal. NÃO chame `falar` de novo. NÃO responda só com ok.'
  );
}

function decideFalarWhenVoiceOff(toolName, toolArgs, voiceEnabled) {
  if (voiceEnabled !== false) return { intercept: false };
  if (!isFalarToolName(toolName)) return { intercept: false };
  const text = extractFalarText(toolArgs);
  const msg = voiceOffRedirectMessage(text);
  return {
    intercept: true,
    text,
    output: {
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
      additionalContext: msg,
    },
  };
}

module.exports = {
  isFalarToolName,
  extractFalarText,
  voiceOffRedirectMessage,
  decideFalarWhenVoiceOff,
};
