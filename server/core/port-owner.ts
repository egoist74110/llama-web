// Force stop (decision 66): any service that listens on a local upstream's port can be ended from the Connections page,
// also one llama-web did not start or no longer remembers. The page first shows what would be ended (`inspect`), and the
// kill re-inspects and only goes ahead when it is still the same process (pid + start time). llama-web's own process
// chain, the processes in pids.json and anything under data/runtime/ are never targets. Pure module: every probe and the
// kill are injected; the defaults run PowerShell (Windows) or lsof / ps (macOS) with argument arrays, never a shell.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { isInsideDir } from './residue'
import { isAlive, killTree } from './runner'

/** `http://127.0.0.1:8080/v1` → 8080. Only loopback hosts can be force-stopped: anything else is not this machine's process. */
export function localPortOf(baseURL: string): number | null {
  let u: URL
  try { u = new URL(baseURL) } catch { return null }
  const host = u.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return null
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

export const isLocalHost = (baseURL: string): boolean => localPortOf(baseURL) !== null

export interface ProcInfo { pid: number, ppid: number, name: string, exe: string, birth: string }

export type InspectRefusal = 'not-listening' | 'self' | 'managed' | 'unreadable'
export type InspectResult =
  | { ok: true, target: ProcInfo, listener: ProcInfo, children: number }
  | { ok: false, code: InspectRefusal }

export type ForceStopCode = InspectRefusal | 'changed' | 'not-local' | 'not-found' | 'bad-body'

export class ForceStopError extends Error {
  constructor(public code: ForceStopCode) {
    super(code)
    this.name = 'ForceStopError'
  }
}

export interface ProcessRow { pid: number, ppid: number }

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => e ? reject(e) : resolve(stdout))
  })
}

const powershell = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])

/** Pids that listen on `port` (loopback or any address), deduplicated; pid 0 / 4 (System) ignored. */
export async function findListener(port: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
  try {
    let pids: number[] = []
    if (platform === 'win32') {
      const out = await powershell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`)
      pids = out.split(/\r?\n/).map(l => Number(l.trim()))
    } else if (platform === 'darwin') {
      const out = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
      pids = out.split(/\r?\n/).filter(l => l.startsWith('p')).map(l => Number(l.slice(1)))
    }
    return [...new Set(pids.filter(p => Number.isInteger(p) && p > 0 && p !== 4))]
  } catch { return [] }
}

/** Name, parent, executable and start time of one process; null when any of them cannot be read (fail closed). */
export async function processInfo(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.ExecutablePath -and $p.CreationDate) { @{ ppid=[int]$p.ParentProcessId; name=$p.Name; exe=$p.ExecutablePath; birth=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`
      const j = JSON.parse(await powershell(script))
      return Number.isInteger(j.ppid) && typeof j.name === 'string' && typeof j.exe === 'string' && typeof j.birth === 'string' ? { pid, ppid: j.ppid, name: j.name, exe: j.exe, birth: j.birth } : null
    }
    if (platform === 'darwin') {
      // ppid, then lstart (five words: "Mon Oct 21 10:00:00 2026"), then the full executable path.
      const tokens = (await run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=,lstart=,comm='])).trim().split(/\s+/)
      const ppid = Number(tokens[0])
      const exe = tokens.slice(6).join(' ')
      if (!Number.isInteger(ppid) || tokens.length < 7 || !exe.startsWith('/')) return null
      return { pid, ppid, name: basename(exe), exe, birth: tokens.slice(1, 6).join(' ') }
    }
  } catch { /* unreadable */ }
  return null
}

/** Every process as (pid, parent pid): the parent chain of llama-web and the descendants of a target come from it. */
export async function processTable(platform: NodeJS.Platform = process.platform): Promise<ProcessRow[]> {
  try {
    let out = ''
    if (platform === 'win32') out = await powershell('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }')
    else if (platform === 'darwin') out = await run('/bin/ps', ['-A', '-o', 'pid=,ppid='])
    const rows: ProcessRow[] = []
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (Number.isInteger(pid) && Number.isInteger(ppid) && pid! > 0) rows.push({ pid: pid!, ppid: ppid! })
    }
    return rows
  } catch { return [] }
}

/** Descendants of `pid`, nearest first. */
export function descendantsOf(pid: number, table: readonly ProcessRow[]): number[] {
  const kids = new Map<number, number[]>()
  for (const r of table) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const out: number[] = []
  const seen = new Set<number>([pid])
  for (let i = -1; i < out.length; i++) {
    for (const k of kids.get(i < 0 ? pid : out[i]!) ?? []) if (!seen.has(k)) { seen.add(k); out.push(k) }
  }
  return out
}

/** llama-web's own pid and every ancestor (bun, the desktop shell): ending any of them would end llama-web. */
export function selfChain(table: readonly ProcessRow[], self = process.pid, firstParent = process.ppid): Set<number> {
  const parent = new Map(table.map(r => [r.pid, r.ppid]))
  const chain = new Set<number>([self])
  if (firstParent > 0) chain.add(firstParent)
  // The walk starts at our parent even when the table did not list us (or failed to load at all).
  const walked = new Set<number>([self])
  let cur = parent.get(self) ?? firstParent
  for (let i = 0; i < 32 && cur > 0 && !walked.has(cur); i++) {
    walked.add(cur)
    chain.add(cur)
    cur = parent.get(cur) ?? 0
  }
  return chain
}

export interface PortOwnerDeps {
  platform?: NodeJS.Platform
  findListener?(port: number): Promise<number[]>
  processInfo?(pid: number): Promise<ProcInfo | null>
  processTable?(): Promise<ProcessRow[]>
  /** Pids llama-web manages itself (data/run/pids.json): llama-server, the embedding engine, the tunnel. */
  managedPids(): number[]
  /** `data/runtime/`: llama.cpp builds and the tunnel binary live here. */
  runtimeDir: string
  /** pid of llama-web (tests). */
  self?: { pid: number, ppid: number }
}

const MAX_PARENT_STEPS = 5

/**
 * What listens on `port`, and which process to end for it: the listener, or, when the listener is a worker of the same
 * program (a Python server that runs under a copy of itself), its topmost same-program ancestor.
 */
export async function inspectPort(port: number, deps: PortOwnerDeps): Promise<InspectResult> {
  const platform = deps.platform ?? process.platform
  const info = deps.processInfo ?? (pid => processInfo(pid, platform))
  const pids = await (deps.findListener ?? (p => findListener(p, platform)))(port)
  if (!pids.length) return { ok: false, code: 'not-listening' }
  const table = await (deps.processTable ?? (() => processTable(platform)))()
  const mine = deps.self ?? { pid: process.pid, ppid: process.ppid }
  const chain = selfChain(table, mine.pid, mine.ppid)
  const managed = new Set(deps.managedPids())
  const excluded = (p: ProcInfo | number) => {
    const pid = typeof p === 'number' ? p : p.pid
    return chain.has(pid) || managed.has(pid) || (typeof p !== 'number' && isInsideDir(p.exe, deps.runtimeDir, platform))
  }
  // Any listener of the port that is ours makes the whole port off limits (the public entry may be on :8080).
  if (pids.some(p => chain.has(p))) return { ok: false, code: 'self' }
  if (pids.some(p => managed.has(p))) return { ok: false, code: 'managed' }

  const listener = await info(pids[0]!)
  if (!listener) return { ok: false, code: 'unreadable' }
  if (excluded(listener)) return { ok: false, code: 'managed' }
  const sameExe = (a: string, b: string) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  let target = listener
  for (let i = 0; i < MAX_PARENT_STEPS; i++) {
    if (target.ppid <= 0 || target.ppid === target.pid) break
    const parent = await info(target.ppid)
    if (!parent || !sameExe(parent.exe, target.exe) || excluded(parent)) break
    target = parent
  }
  return { ok: true, target, listener, children: descendantsOf(target.pid, table).length }
}

export interface ForceKillDeps {
  platform?: NodeJS.Platform
  killTree?(pid: number): Promise<void>
  processTable?(): Promise<ProcessRow[]>
  signal?(pid: number, signal: NodeJS.Signals): void
  alive?(pid: number): boolean
  wait?(ms: number): Promise<void>
  /** How long SIGTERM gets before SIGKILL (default 3 s). */
  graceMs?: number
}

/** End a process and everything below it. Windows: `taskkill /T /F`. macOS: SIGTERM to the whole tree, SIGKILL to what is left. */
export async function forceKill(pid: number, deps: ForceKillDeps = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid process to stop')
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return (deps.killTree ?? killTree)(pid)
  const signal = deps.signal ?? ((p, s) => { process.kill(p, s) })
  const alive = deps.alive ?? isAlive
  const wait = deps.wait ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const all = [...descendantsOf(pid, await (deps.processTable ?? (() => processTable(platform)))()).reverse(), pid]
  const send = (s: NodeJS.Signals, ids: number[]) => { for (const p of ids) { try { signal(p, s) } catch { /* already gone */ } } }
  send('SIGTERM', all)
  let remaining = deps.graceMs ?? 3000
  while (remaining > 0 && all.some(alive)) { const ms = Math.min(100, remaining); await wait(ms); remaining -= ms }
  send('SIGKILL', all.filter(alive))
}

/**
 * The kill behind `POST /force-stop`: inspect again and only end the process the user saw (same pid and start time).
 * Throws `ForceStopError`; returns what was ended.
 */
export async function forceStopPort(port: number, expected: { pid: number, birth: string }, deps: PortOwnerDeps & { kill?(pid: number): Promise<void> }): Promise<ProcInfo> {
  const r = await inspectPort(port, deps)
  if (!r.ok) throw new ForceStopError(r.code)
  if (r.target.pid !== expected.pid || r.target.birth !== expected.birth) throw new ForceStopError('changed')
  await (deps.kill ?? (pid => forceKill(pid, { platform: deps.platform })))(r.target.pid)
  return r.target
}
