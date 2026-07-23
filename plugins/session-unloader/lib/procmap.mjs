// procmap.mjs — fotografia (CIM) de TODOS os processos: pid -> { ppid, name, cmdline }. Base para as
// guardas (ancestrais do scan, filhos de um servidor, re-validação anti-TOCTOU). Uma chamada (~0,3s).
import { runPwsh } from "./pwsh.mjs";

export async function getProcMap({ timeout = 10000 } = {}) {
  const raw = await runPwsh(
    "Get-CimInstance Win32_Process -EA SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    { timeout }
  );
  let parsed;
  try { parsed = JSON.parse(String(raw || "").trim() || "[]"); } catch { parsed = []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const map = new Map();
  for (const p of arr) {
    map.set(Number(p.ProcessId), {
      ppid: Number(p.ParentProcessId),
      name: p.Name || "",
      cmdline: p.CommandLine || "",
    });
  }
  return map;
}
