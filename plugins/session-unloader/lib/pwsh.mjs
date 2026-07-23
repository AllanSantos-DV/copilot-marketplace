// pwsh.mjs — executa um script PowerShell e devolve o stdout. Timeout obrigatório para não travar o hook.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * @param {string} script — script PowerShell (o scan monta um que emite JSON).
 * @param {{timeout?:number}} [opts] — timeout ms (default 8000; o command hook tem 20s).
 * @returns {Promise<string>} stdout
 */
export async function runPwsh(script, { timeout = 8000 } = {}) {
  const { stdout } = await pexec(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );
  return stdout;
}
