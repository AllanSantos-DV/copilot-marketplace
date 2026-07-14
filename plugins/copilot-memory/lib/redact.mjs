// Redação de segredos/PII antes de qualquer destilação (bloqueador do revisor externo).
// getMessages() traz transcript cru: tokens, .env, chaves, connection strings podem aparecer.
// NUNCA deve virar memória de longo prazo. Best-effort, conservador: prefere redigir demais a vazar.

const PATTERNS = [
    [/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, "[PRIVATE_KEY]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]"],           // JWT
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[GH_TOKEN]"],                                        // GitHub tokens
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[SLACK_TOKEN]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[AWS_KEY]"],
    [/\bsk-[A-Za-z0-9]{20,}\b/g, "[API_KEY]"],
    // esquema de autorização: Bearer/Basic/Token <valor> → redige o VALOR (mantém o esquema).
    // Pega o token opaco de `Authorization: Bearer <opaco>` que os padrões acima (JWT/gh/sk) não cobrem.
    // Valor ≥16 p/ não confundir com prosa ("token expired").
    [/\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, "$1 [REDACTED]"],
    // credenciais em URL user:pass@host
    [/\b[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s/:@]+:[^\s/:@]+@/g, "$_SCHEME_[CRED]@"],
    // atribuição chave=valor sensível. O prefixo/sufixo [A-Za-z0-9_]* cobre a forma UPPER_SNAKE de
    // .env/exports (DB_PASSWORD=, SECRET_KEY=, GITHUB_TOKEN=, AWS_SECRET_ACCESS_KEY=) — que \b…\b não
    // pegava porque '_' é caractere de palavra.
    [/([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s'"]{6,}\3/gi, "$1$2[REDACTED]"],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],                       // e-mails (PII)
];

// Redige o texto. Retorna { text, count } (count = nº de trechos redigidos).
export function redact(input) {
    let text = String(input || "");
    let count = 0;
    for (const [re, repl] of PATTERNS) {
        text = text.replace(re, (m, ...g) => {
            count++;
            if (repl === "$_SCHEME_[CRED]@") {
                const scheme = (m.match(/^[A-Za-z][A-Za-z0-9+.\-]*:\/\//) || [""])[0];
                return `${scheme}[CRED]@`;
            }
            if (repl.includes("$1")) {
                return repl.replace("$1", g[0] ?? "").replace("$2", g[1] ?? "");
            }
            return repl;
        });
    }
    return { text, count };
}
