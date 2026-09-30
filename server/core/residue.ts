// Startup residue cleanup: kill llama-server processes left over from a previous run.
// Only processes listed in pids.json AND whose executable lives under data/runtime/ are
// killed, so a reused PID or a user's own llama-server is never touched.
import { spawn } from 'node:child_process'
import { join, posix, win32 } from 'node:path'
import { isAlive, killTree, PidRegistry, type PidRecord } from './runner'

/** True when `file` is inside directory `dir` (case-insensitive on Windows). */
export function isInsideDir(file: string, dir: string, platform = process.platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const norm = (p: string) => {
    const r = path.resolve(p)
    return platform === 'win32' ? r.toLowerCase() : r
  }
  const f = norm(file)
  let d = norm(dir)
  if (!d.endsWith(path.sep)) d += path.sep
  return f.startsWith(d)
}

/** Executable paths of live processes (Windows: Win32_Process via PowerShell). Missing pids are absent. */
export async function getExePaths(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = pids.filter(p => Number.isInteger(p) && p > 0)
  if (ids.length === 0 || process.platform !== 'win32') return out
  const filter = ids.map(p => `ProcessId=${p}`).join(' OR ')
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.ExecutablePath)" }`
  const text = await new Promise<string>((res) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    let buf = ''
    ps.stdout.on('data', (c: Buffer) => { buf += c.toString('utf8') })
    ps.on('error', () => res(''))
    ps.on('close', () => res(buf))
  })
  for (const line of text.split(/\r?\n/)) {
    const [pid, exe] = line.split('\t')
    if (pid && exe) out.set(Number(pid), exe.trim())
  }
  return out
}

export interface ResidueResult {
  killed: PidRecord[]
  /** Alive, but the executable is not under the runtime dir (PID reused): left alone. */
  skipped: Array<PidRecord & { actualExe: string | null }>
  /** Already gone. */
  gone: PidRecord[]
}

export interface ResidueDeps {
  getExePaths?: (pids: number[]) => Promise<Map<number, string>>
  killTree?: (pid: number) => Promise<void>
  isAlive?: (pid: number) => boolean
}

/**
 * Process the records in pids.json. Every processed record is removed from the file
 * afterwards; records added concurrently are kept.
 */
export async function cleanupResidue(registry: PidRegistry, runtimeDir: string, deps: ResidueDeps = {}): Promise<ResidueResult> {
  const alive = deps.isAlive ?? isAlive
  const kill = deps.killTree ?? killTree
  const exePaths = deps.getExePaths ?? getExePaths

  const records = registry.list()
  const result: ResidueResult = { killed: [], skipped: [], gone: [] }
  const live = records.filter(r => alive(r.pid))
  result.gone.push(...records.filter(r => !live.includes(r)))

  const exes = live.length ? await exePaths(live.map(r => r.pid)) : new Map<number, string>()
  for (const r of live) {
    const actual = exes.get(r.pid) ?? null
    if (actual && isInsideDir(actual, runtimeDir)) {
      await kill(r.pid)
      result.killed.push(r)
    } else if (actual) {
      result.skipped.push({ ...r, actualExe: actual })
    } else {
      // Exited between the checks, or the path is unreadable: never kill blindly.
      result.skipped.push({ ...r, actualExe: null })
    }
  }
  registry.remove(records.map(r => r.pid))
  return result
}

let startup: Promise<ResidueResult> | null = null

/**
 * Run the startup cleanup once per process (memoised). The scheduler must await this
 * before launching anything, so fresh processes are never mistaken for residue.
 */
export function runStartupCleanup(dataDir: string): Promise<ResidueResult> {
  startup ??= cleanupResidue(new PidRegistry(join(dataDir, 'run', 'pids.json')), join(dataDir, 'runtime'))
  return startup
}
