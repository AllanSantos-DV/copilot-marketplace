// Config do daemon de memória (URL do servidor) — validação + (Fases 2/4) leitura/escrita de config.
// Cliente-puro, só built-ins. Nunca lança.
//
// DECISÃO DE SEGURANÇA (gate de pesquisa ativa, [S1] OWASP SSRF Cheat Sheet / Wiz): NÃO há blocklist de
// SSRF (metadata IP 169.254.169.254, DNS-rebinding, etc.). A URL é digitada pelo PRÓPRIO usuário no canvas
// local (127.0.0.1) apontando para o servidor DELE — não há input não-confiável cruzando fronteira de
// confiança (ela colapsa: você confia em si mesmo). Bloquear metadata seria over-engineering aqui. Se um
// dia o plugin virar multiusuário/cloud (URL de terceiro), REINTRODUZIR a blocklist. Validação = mínima:
// http/https, URL BASE (sem caminho), normalizada e sem credencial embutida (não vaza em log/uso).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.mjs";

// Valida e NORMALIZA a URL do daemon. Retorna { ok:true, url } (base normalizada: protocolo+host, sem
// caminho/query/hash/credencial, sem barra final) ou { ok:false, error } (fail-loud, mensagem acionável).
export function validateDaemonUrl(input) {
    if (typeof input !== "string" || !input.trim()) return { ok: false, error: "URL vazia — informe http://host:porta do servidor de memória." };
    let u;
    try { u = new URL(input.trim()); } catch { return { ok: false, error: "URL malformada — use o formato http://host:porta (ex.: http://192.168.0.5:8080)." }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "esquema inválido — use http:// ou https:// (não " + u.protocol + ")." };
    if (!u.hostname) return { ok: false, error: "host ausente na URL." };
    if (u.pathname && u.pathname !== "/") return { ok: false, error: "passe a URL BASE do servidor, sem caminho (ex.: http://host:porta) — remova o trecho após o host (" + u.pathname + ")." };
    // Normaliza: protocolo + host (hostname[:porta não-default]). u.host NÃO inclui credencial (username/
    // password ficam em u.username/u.password) → strip automático; sem caminho/query/hash; sem barra final.
    return { ok: true, url: `${u.protocol}//${u.host}` };
}

// Lê ~/.copilot-memory/config.json (GLOBAL; o daemon é por-máquina, serve todos os projetos). Tolerante:
// ausente/corrompido → {} (nunca lança). Reusa stateDir() (mesma pasta de grepguard.json/selfreview.json).
export function readConfig() {
    try {
        const raw = readFileSync(join(stateDir(), "config.json"), "utf8");
        const cfg = JSON.parse(raw);
        return cfg && typeof cfg === "object" ? cfg : {};
    } catch {
        return {};
    }
}

// URL do daemon CONFIGURADA (validada+normalizada) ou null. Precedência: env COPILOT_MEMORY_DAEMON_URL
// (override power-user/CI) > config.json {daemonUrl} (definida pelo canvas). URL inválida numa fonte →
// ignora ESSA fonte e tenta a próxima (não mascara silenciosamente); nada válido → null. Deps injetáveis.
export function configuredDaemonUrl(env = process.env, readCfg = readConfig) {
    const fromEnv = env && env.COPILOT_MEMORY_DAEMON_URL;
    if (fromEnv && String(fromEnv).trim()) {
        const v = validateDaemonUrl(String(fromEnv));
        if (v.ok) return v.url;
    }
    let cfg = {};
    try { cfg = readCfg() || {}; } catch { cfg = {}; }
    const fromCfg = cfg && cfg.daemonUrl;
    if (fromCfg && String(fromCfg).trim()) {
        const v = validateDaemonUrl(String(fromCfg));
        if (v.ok) return v.url;
    }
    return null;
}

// Escrita ATÔMICA do config.json (.tmp + renameSync): evita arquivo truncado/vazio se cair no meio da
// gravação (que causaria perda silenciosa de config). Preserva o objeto inteiro (as demais chaves).
function writeConfigAtomic(cfg) {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "config.json");
    const tmp = dest + ".tmp";
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
    renameSync(tmp, dest);
}

// Salva a URL do daemon (VALIDA+normaliza antes; PRESERVA as demais chaves do config). Retorna
// { ok:true, url } ou { ok:false, error } (fail-loud — nunca grava URL inválida).
export function saveDaemonUrl(url) {
    const v = validateDaemonUrl(url);
    if (!v.ok) return { ok: false, error: v.error };
    let cfg = {};
    try { cfg = readConfig() || {}; } catch { cfg = {}; }
    cfg.daemonUrl = v.url;
    try { writeConfigAtomic(cfg); } catch (e) { return { ok: false, error: "falha ao gravar config: " + (e && e.message || e) }; }
    return { ok: true, url: v.url };
}

// Remove a URL configurada (volta ao registry local / provisionamento opt-in). Preserva outras chaves.
export function clearDaemonUrl() {
    let cfg = {};
    try { cfg = readConfig() || {}; } catch { cfg = {}; }
    delete cfg.daemonUrl;
    try { writeConfigAtomic(cfg); } catch (e) { return { ok: false, error: "falha ao gravar config: " + (e && e.message || e) }; }
    return { ok: true };
}
