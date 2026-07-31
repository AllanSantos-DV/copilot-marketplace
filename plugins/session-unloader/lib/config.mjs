// Global configuration shared by the automatic hook, tool and singleton dashboard.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

export const REQUIRED_ALLOWLIST = Object.freeze(["liveWorker.mjs", "voice_worker.py"]);
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  idleTimeoutMs: 60 * 60 * 1000,
  activeCpuRatio: 0.0001,
  minSampleMs: 30 * 1000,
  allowlist: Object.freeze([]),
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const FORBIDDEN_ALLOWLIST = /copilot|\.exe|node|\.mjs|session-unloader|scan-hook|server-daemon|extension_bootstrap/i;
const configPath = (home) => join(home, "session-state", ".unloader-config.json");
const sleepSync = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* short Windows rename retry */ }
};

function configError(message) {
  const error = new Error(`configuração do unloader inválida: ${message}`);
  error.code = "INVALID_UNLOADER_CONFIG";
  return error;
}

function validateNumber(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw configError(`${name} deve estar entre ${min} e ${max}`);
  }
  return value;
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) throw configError("allowlist deve ser uma lista de textos literais");
  if (value.length > 32) throw configError("allowlist aceita no máximo 32 entradas");
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw configError("allowlist contém uma entrada que não é texto");
    const literal = entry.trim();
    if (literal.length < 4 || literal.length > 120) {
      throw configError("allowlist exige entradas entre 4 e 120 caracteres");
    }
    if (FORBIDDEN_ALLOWLIST.test(literal)) {
      throw configError(`allowlist contém entrada genérica ou reservada: ${literal}`);
    }
    const key = literal.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(literal);
    }
  }
  return normalized;
}

function effectiveAllowlist(custom) {
  const combined = [...REQUIRED_ALLOWLIST, ...custom];
  const seen = new Set();
  return combined.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("o documento deve ser um objeto JSON");
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw configError(`chave desconhecida: ${key}`);
  }
  const merged = { ...DEFAULT_CONFIG, ...value };
  if (typeof merged.enabled !== "boolean") throw configError("enabled deve ser booleano");
  const normalized = {
    enabled: merged.enabled,
    idleTimeoutMs: validateNumber("idleTimeoutMs", Number(merged.idleTimeoutMs), 15 * 60 * 1000, 24 * 60 * 60 * 1000),
    activeCpuRatio: validateNumber("activeCpuRatio", Number(merged.activeCpuRatio), 0.000001, 0.25),
    minSampleMs: validateNumber("minSampleMs", Number(merged.minSampleMs), 5_000, 5 * 60 * 1000),
    allowlist: normalizeAllowlist(merged.allowlist),
  };
  return { ...normalized, effectiveAllowlist: effectiveAllowlist(normalized.allowlist) };
}

function failClosed(error) {
  const safe = normalizeConfig(DEFAULT_CONFIG);
  return {
    ...safe,
    enabled: false,
    configError: String(error?.message || error),
  };
}

export function readConfig({ home = resolveCopilotHome() } = {}) {
  let raw;
  try {
    raw = readFileSync(configPath(home), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeConfig(DEFAULT_CONFIG);
    return failClosed(new Error(`falha ao ler config: ${error?.message || error}`));
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    return failClosed(error);
  }
}

export function writeConfig(patch, { home = resolveCopilotHome() } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw configError("patch deve ser um objeto");
  }
  for (const key of Object.keys(patch)) {
    if (!CONFIG_KEYS.has(key)) throw configError(`chave desconhecida: ${key}`);
  }
  const current = readConfig({ home });
  const base = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((key) => [key, current[key]]));
  const next = normalizeConfig({ ...base, ...patch });
  const persisted = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((key) => [key, next[key]]));
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(persisted));
  const delays = [50, 100, 200];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      renameSync(tmp, path);
      return next;
    } catch (error) {
      const retryable = error?.code === "EBUSY" || error?.code === "EPERM";
      if (attempt < delays.length && retryable) {
        sleepSync(delays[attempt]);
        continue;
      }
      try { unlinkSync(tmp); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new Error(`falha ao gravar config (${error?.message || error}); limpeza também falhou: ${cleanupError?.message || cleanupError}`);
        }
      }
      throw new Error(`falha ao gravar config do unloader: ${error?.message || error}`);
    }
  }
  throw new Error("falha inesperada ao gravar config do unloader");
}
