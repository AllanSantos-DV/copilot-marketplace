// scan.mjs — enumera os servidores de sessão VIVOS do Copilot no Windows (CIM) e junta, por servidor:
//   pid, commandLine, sessionId (via inuse.<pid>.lock na pasta da sessão), cpu (Kernel+User em 100ns) e
//   eventsMtimeMs (mtime do events.jsonl = última atividade, inclusive de subagente). É a fotografia que
//   as camadas de decisão (isIdle) e kill consomem. Windows-only por ora (abstrair para v3).
import { join } from "node:path";
import { runPwsh } from "./pwsh.mjs";
import { resolveCopilotHome } from "./home.mjs";

export async function scanServers({ home = resolveCopilotHome(), timeout = 15000 } = {}) {
  const ss = join(home, "session-state").replace(/'/g, "''");
  // Performance: UMA varredura de locks (~0,9s p/ 10k pastas) monta o mapa pid->pasta; depois CIM cruza
  // em memória. (A versão ingênua — varrer por-pid — fazia 13 varreduras e estourava o timeout do hook.)
  const script = `
$ss = '${ss}'
$lockMap = @{}
Get-ChildItem $ss -Filter 'inuse.*.lock' -Recurse -Depth 1 -EA SilentlyContinue | ForEach-Object {
  if ($_.Name -match 'inuse\\.(\\d+)\\.lock') { $lockMap[[int]$matches[1]] = $_.Directory }
}
$out = @()
Get-CimInstance Win32_Process -Filter "Name='copilot.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*--server --stdio*' } | ForEach-Object {
  $procId = [int]$_.ProcessId
  $dir = $lockMap[$procId]
  $sid = $null; $evMs = $null
  if ($dir) {
    $sid = $dir.Name
    $ev = Join-Path $dir.FullName 'events.jsonl'
    if (Test-Path $ev) { $evMs = [int64]([DateTimeOffset]((Get-Item $ev).LastWriteTimeUtc)).ToUnixTimeMilliseconds() }
  }
  $out += [PSCustomObject]@{ pid=$procId; commandLine=[string]$_.CommandLine; sessionId=$sid; cpu=([int64]$_.KernelModeTime + [int64]$_.UserModeTime); wsMb=[int]([int64]$_.WorkingSetSize/1MB); eventsMtimeMs=$evMs }
}
if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Depth 3 -Compress }
`.trim();
  const raw = await runPwsh(script, { timeout });
  const txt = String(raw || "").trim();
  if (!txt) return [];
  let parsed;
  try { parsed = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  // normaliza numéricos (ConvertTo-Json pode emitir string em int64 grande)
  return arr.map((s) => ({
    pid: Number(s.pid),
    commandLine: s.commandLine || "",
    sessionId: s.sessionId || null,
    cpu: s.cpu == null ? null : Number(s.cpu),
    wsMb: s.wsMb == null ? null : Number(s.wsMb),
    eventsMtimeMs: s.eventsMtimeMs == null ? null : Number(s.eventsMtimeMs),
  }));
}
