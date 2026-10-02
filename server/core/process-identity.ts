// Identity probes fail closed: an unreadable executable or start identity cannot authorize a kill.
import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface ProcessIdentity { exe: string, birth: string, pgid?: number }
/** Do not block the serving event loop while a platform inspector reads a newly spawned child. */
export async function processIdentityAsync(pid: number, signal?: AbortSignal, platform = process.platform): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0 || signal?.aborted) return null
  const text = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, signal }, (e, stdout) => e ? reject(e) : resolve(stdout))
  })
  try {
    if (platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.ExecutablePath -and $p.CreationDate) { @{ exe=$p.ExecutablePath; birth=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`
      const p = JSON.parse(await text('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]))
      return typeof p.exe === 'string' && typeof p.birth === 'string' ? p : null
    }
    if (platform === 'darwin') {
      const field = async (f: string) => (await text('/bin/ps', ['-ww', '-p', String(pid), '-o', `${f}=`])).trim()
      const exe = await field('comm'), birth = await field('lstart'), pgid = Number(await field('pgid'))
      return isAbsolute(exe) && birth && Number.isInteger(pgid) ? { exe: realpathSync(exe), birth, pgid } : null
    }
    return null
  } catch { return null }
}
export function processIdentity(pid: number, platform = process.platform): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const opts: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  try {
    if (platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.ExecutablePath -and $p.CreationDate) { @{ exe=$p.ExecutablePath; birth=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`
      const p = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts))
      return typeof p.exe === 'string' && typeof p.birth === 'string' ? p : null
    }
    if (platform === 'darwin') {
      const field = (f: string) => execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', `${f}=`], opts).trim()
      const exe = field('comm'), birth = field('lstart'), pgid = Number(field('pgid'))
      if (!isAbsolute(exe) || !birth || !Number.isInteger(pgid)) return null
      return { exe: realpathSync(exe), birth, pgid }
    }
    return null
  } catch { return null }
}
