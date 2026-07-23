// telemetry.mjs — agrega o log NDJSON do unloader (~/.copilot/logs/unloader.log) em métricas para o painel.
// FUNÇÃO PURA: sem fs/path — o chamador (dashboard) lê o arquivo e passa as linhas. Retrocompatível:
// linhas antigas (v0.1.0) sem `wsMb` contam 0; linhas que não são `killed`/`skipped` são ignoradas.

export function parseTelemetry(lines, now = Date.now()) {
  const out = { totalKilled: 0, killedToday: 0, totalSkipped: 0, ramFreedMb: 0, recentKills: [] };
  const today = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  for (const line of lines || []) {
    const s = String(line || "").trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }        // linha corrompida → ignora
    if (ev.action === "killed") {
      out.totalKilled++;
      out.ramFreedMb += Number(ev.wsMb) || 0;
      if (typeof ev.ts === "string" && ev.ts.slice(0, 10) === today) out.killedToday++;
      out.recentKills.push({ ts: ev.ts || null, sessionId: ev.sessionId || null, wsMb: Number(ev.wsMb) || 0, reason: ev.reason || null });
    } else if (ev.action === "skipped") {
      out.totalSkipped++;
    }
    // action: "scan" | "dry-run" | "kill-fail" | "scan-error" → não contam na telemetria de descargas
  }
  out.ramFreedMb = Math.round(out.ramFreedMb);
  out.recentKills = out.recentKills.slice(-20).reverse(); // últimas 20, mais recentes primeiro
  return out;
}
