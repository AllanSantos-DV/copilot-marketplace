// telemetry-store.mjs — telemetria OPERACIONAL incremental do daemon. Nunca relê o NDJSON inteiro por
// leitura: mantém um CURSOR (offset em bytes) persistido num sidecar compacto, tail só o que é novo, e
// acumula contadores cumulativos + série curta limitada. Detecta truncamento/rotação (arquivo menor que
// o offset conhecido) e corrupção de linha sem inventar dado nem lançar. Erro de leitura/persistência do
// sidecar é SINALIZADO (storeWarning/storeError) — nunca vira "zero saudável" silencioso.
//
// Complementa lib/telemetry.mjs (parseTelemetry), que continua sendo a função PURA de referência para
// reprocessamento total (usada por quem só tem as linhas em mãos, ex.: testes). Este módulo é o adaptador
// STATEFUL usado pelo daemon no caminho quente (/data).
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, statSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { resolveCopilotHome } from "./home.mjs";

const RECENT_KILLS_MAX = 20;
const SERIES_MAX = 30;

function freshStore() {
  return {
    version: 1,
    offset: 0,
    fileSize: 0,
    fileMtimeMs: 0,
    counters: {
      totalKilled: 0, totalSkipped: 0, ramFreedMb: 0,
      totalDryRuns: 0, totalScans: 0, totalScanFails: 0, totalKillFails: 0,
    },
    killedTodayDate: null,
    killedTodayCount: 0,
    recentKills: [],
    series: [],
  };
}

function applyEvent(store, ev, tsNow) {
  const c = store.counters;
  if (ev.action === "killed") {
    c.totalKilled++;
    c.ramFreedMb += Number(ev.wsMb) || 0;
    const day = typeof ev.ts === "string" ? ev.ts.slice(0, 10) : new Date(tsNow).toISOString().slice(0, 10);
    if (store.killedTodayDate === day) store.killedTodayCount++;
    else { store.killedTodayDate = day; store.killedTodayCount = 1; }
    store.recentKills.unshift({ ts: ev.ts || null, sessionId: ev.sessionId || null, wsMb: Number(ev.wsMb) || 0, reason: ev.reason || null });
    store.recentKills = store.recentKills.slice(0, RECENT_KILLS_MAX);
  } else if (ev.action === "skipped") {
    c.totalSkipped++;
  } else if (ev.action === "dry-run" || ev.action === "panel-dryrun") {
    c.totalDryRuns++;
  } else if (ev.action === "kill-fail") {
    c.totalKillFails++;
  } else if (ev.action === "scan-cycle") {
    c.totalScans++;
    if (ev.ok === false) c.totalScanFails++;
    store.series.push({ ts: ev.ts || null, durationMs: Number(ev.durationMs) || 0, ok: ev.ok !== false, error: ev.error || null });
    store.series = store.series.slice(-SERIES_MAX);
  }
  // outras ações (toggle/config/scan-error do hook legado) não contam nos contadores operacionais.
}

export class TelemetryStore {
  constructor({
    home = resolveCopilotHome(),
    logPath = null,
    storePath = null,
    now = () => Date.now(),
    statSyncFn = statSync,
    openSyncFn = openSync,
    readSyncFn = readSync,
    closeSyncFn = closeSync,
    readFileSyncFn = readFileSync,
    writeFileSyncFn = writeFileSync,
    renameSyncFn = renameSync,
    mkdirSyncFn = mkdirSync,
  } = {}) {
    this.home = home;
    this.logPath = logPath || join(home, "logs", "unloader.log");
    this.storePath = storePath || join(home, "session-state", ".unloader-telemetry-store.json");
    this.now = now;
    this._statSync = statSyncFn;
    this._openSync = openSyncFn;
    this._readSync = readSyncFn;
    this._closeSync = closeSyncFn;
    this._readFileSync = readFileSyncFn;
    this._writeFileSync = writeFileSyncFn;
    this._renameSync = renameSyncFn;
    this._mkdirSync = mkdirSyncFn;
    this._store = null;
    this._loadWarning = null;
  }

  _load() {
    if (this._store) return this._store;
    try {
      const raw = this._readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.counters) throw new Error("formato inesperado");
      this._store = parsed;
    } catch (e) {
      if (e?.code !== "ENOENT") this._loadWarning = `telemetry-store corrompido, reiniciando contadores: ${e?.message || e}`;
      this._store = freshStore();
    }
    return this._store;
  }

  _persist() {
    try {
      this._mkdirSync(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.tmp-${process.pid}`;
      this._writeFileSync(tmp, JSON.stringify(this._store));
      this._renameSync(tmp, this.storePath);
      return null;
    } catch (e) {
      return `falha ao persistir telemetry-store: ${e?.message || e}`;
    }
  }

  /** Faz o tail incremental do log e devolve o snapshot de telemetria atual. Nunca lança. */
  read() {
    const store = this._load();
    let stat = null;
    try { stat = this._statSync(this.logPath); } catch { stat = null; }

    let rotated = false;
    let corruptLines = 0;
    let changed = false;

    if (stat && stat.size < store.offset) {
      rotated = true;
      store.offset = 0;
      changed = true;
    }

    if (stat && stat.size > store.offset) {
      changed = true;
      const start = store.offset;
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      const fd = this._openSync(this.logPath, "r");
      try { this._readSync(fd, buf, 0, len, start); }
      finally { this._closeSync(fd); }
      let text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      const usableText = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
      const usableBytes = Buffer.byteLength(usableText, "utf8");
      const tsNow = this.now();
      for (const raw of usableText.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { corruptLines++; continue; }
        applyEvent(store, ev, tsNow);
      }
      store.offset = start + usableBytes;
      store.fileSize = stat.size;
      store.fileMtimeMs = stat.mtimeMs;
    }

    let storeError = null;
    if (changed) storeError = this._persist();

    const nowVal = this.now();
    const todayStr = new Date(nowVal).toISOString().slice(0, 10);
    const loadWarning = this._loadWarning;
    return {
      totalKilled: store.counters.totalKilled,
      killedToday: store.killedTodayDate === todayStr ? store.killedTodayCount : 0,
      totalSkipped: store.counters.totalSkipped,
      ramFreedMb: Math.round(store.counters.ramFreedMb),
      recentKills: store.recentKills,
      totalDryRuns: store.counters.totalDryRuns,
      totalScans: store.counters.totalScans,
      totalScanFails: store.counters.totalScanFails,
      totalKillFails: store.counters.totalKillFails,
      series: store.series,
      rotated,
      corruptLines,
      storeWarning: loadWarning,
      storeError,
    };
  }
}
