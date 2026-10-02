// Startup residue cleanup: kill llama-server processes left over from a previous run.
// Only processes listed in pids.json AND whose executable lives under data/runtime/ are
// killed, so a reused PID or a user's own llama-server is never touched.
import { join, posix, resolve, win32 } from 'node:path'
import { isAlive, killTree, PidRegistry, type PidRecord } from './runner'
import { processIdentityAsync, type ProcessIdentity } from './process-identity'
import { realpathSync } from 'node:fs'

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
  for (const pid of ids) { const p = await processIdentityAsync(pid); if (p) out.set(pid, p.exe) }
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
  /** Path semantics for comparing exe paths (tests); defaults to the host platform. */
  platform?: NodeJS.Platform
  identities?: (pids: number[]) => Promise<Map<number, ProcessIdentity>>
}

/**
 * Process the records in pids.json. Every processed record is removed from the file
 * afterwards; records added concurrently are kept.
 */
export async function cleanupResidue(registry: PidRegistry, runtimeDir: string, deps: ResidueDeps = {}): Promise<ResidueResult> {
  const alive = deps.isAlive ?? isAlive
  const kill = deps.killTree ?? killTree

  const records = registry.list()
  const result: ResidueResult = { killed: [], skipped: [], gone: [] }
  const live = records.filter(r => alive(r.pid))
  result.gone.push(...records.filter(r => !live.includes(r)))

  const exes = live.length && deps.getExePaths ? await deps.getExePaths(live.map(r => r.pid)) : new Map<number, string>()
  const identities = deps.identities ? await deps.identities(live.map(r => r.pid)) : new Map<number, ProcessIdentity>()
  if (!deps.identities) for (const r of live) { const p = await processIdentityAsync(r.pid); if (p) identities.set(r.pid, p) }
  const platform = deps.platform ?? process.platform
  const same = (a: string, b: string) => platform === 'win32' ? win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase() : posix.resolve(a) === posix.resolve(b)
  for (const r of live) {
    const identity = identities.get(r.pid)
    const actual = deps.getExePaths ? (exes.get(r.pid) ?? null) : (identity?.exe ?? null)
    // Probe again immediately before killing: the PID can be reused between the first checks.
    const fresh = deps.identities ? (await deps.identities([r.pid])).get(r.pid) : await processIdentityAsync(r.pid)
    let physical = actual, physicalRuntime = runtimeDir
    if (!deps.identities && actual) {
      try { physical = realpathSync(actual); physicalRuntime = realpathSync(runtimeDir) } catch { physical = null }
    }
    if (actual && physical && r.birth && identity?.birth === r.birth && fresh?.birth === r.birth
      && same(actual, r.exe) && same(fresh.exe, r.exe) && isInsideDir(physical, physicalRuntime, platform)
      && (platform === 'win32' || (r.pgid === r.pid && fresh.pgid === r.pgid))) {
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

const startup = new Map<string, Promise<ResidueResult>>()

/**
 * Run the startup cleanup once per process (memoised). The scheduler must await this
 * before launching anything, so fresh processes are never mistaken for residue.
 */
export function runStartupCleanup(dataDir: string): Promise<ResidueResult> {
  const key = resolve(dataDir)
  if (!startup.has(key)) startup.set(key, cleanupResidue(new PidRegistry(join(dataDir, 'run', 'pids.json')), join(dataDir, 'runtime')))
  return startup.get(key)!
}
