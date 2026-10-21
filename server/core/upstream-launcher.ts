// Starting an external upstream by hand (decision 56 ⑩): the user saved a command line for it; when the service is not up
// the page can run it. llama-web then keeps asking the service for its model list until models show up (= started), the
// process we ran exits with an error, or the wait runs out. The service stays the user's: it is started detached, its
// output is not read, it is not recorded in pids.json and, by default, not stopped when llama-web exits (decision 56 ⑩).
// With the upstream's `stopOnExit` on, llama-web stops the process it started when it exits (decision 60). What it started
// is remembered across restarts (decision 66, `launched-store.ts`): the process it ran and the one that listens on the
// service's port, each only with a matching identity. Pure module: spawn, the check, the clock, the timers, the process
// probes and the file are injected.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { splitArgs } from './args'
import { type Ident, type LaunchedEntry, type LaunchedStore } from './launched-store'
import { findListener, forceKill, localPortOf } from './port-owner'
import { processIdentityAsync, type ProcessIdentity } from './process-identity'
import { isAlive, killTree } from './runner'
import type { Upstream } from './upstreams'
import { spawnOutsideJob, winSpawnAvailable } from './win-spawn'

export type LaunchErrorCode = 'not-found' | 'no-command' | 'already-up' | 'already-starting' | 'bad-cwd' | 'bad-command' | 'not-ours'

export class LaunchError extends Error {
  constructor(public code: LaunchErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'LaunchError'
  }
}

export type LaunchState =
  | { state: 'idle' }
  /** Waiting for the service to answer with models. `since` is epoch ms. */
  | { state: 'starting', since: number }
  | { state: 'failed', code: 'spawn-failed' | 'exited' | 'timeout', detail: string }

/** What a spawned process looks like to the launcher. */
export interface LaunchedProcess {
  pid: number | undefined
  onExit(cb: (code: number | null) => void): void
  onError(cb: (e: Error) => void): void
  unref(): void
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string | undefined
  /** The service should outlive llama-web (`stopOnExit` off): under the Windows desktop shell it is started outside the shell's job. */
  keepRunning: boolean
}

/** `.bat` / `.cmd` cannot be started directly on Windows: they go through `cmd.exe /c`. Everything else is run as written. */
export function launchArgv(argv: string[], platform: NodeJS.Platform = process.platform): { file: string, args: string[] } {
  const [file, ...args] = argv
  if (platform === 'win32' && file && ['.bat', '.cmd'].includes(extname(file).toLowerCase())) return { file: 'cmd.exe', args: ['/c', file, ...args] }
  return { file: file!, args }
}

/**
 * Under the Windows desktop shell every child of llama-web is in a job that ends with the shell (src-tauri/src/job.rs);
 * a service that should keep running is started outside it. Anywhere else a detached child already outlives llama-web.
 */
export function needsOutsideJob(spec: Pick<SpawnSpec, 'keepRunning'>, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  return spec.keepRunning && platform === 'win32' && !!env.LLAMA_WEB_DESKTOP_SESSION
}

function spawnWindowsOutsideJob(spec: SpawnSpec): LaunchedProcess | null {
  const which = (globalThis as { Bun?: { which(cmd: string, o: { cwd?: string, PATH?: string }): string | null } }).Bun?.which
  const full = which?.(spec.file, { cwd: spec.cwd, PATH: process.env.PATH })
  if (!full) return null
  const p = spawnOutsideJob(full, spec.args, spec.cwd)
  const exitCbs: Array<(code: number | null) => void> = []
  const timer = setInterval(() => {
    const code = p.exitCode()
    if (code === null) return
    clearInterval(timer)
    for (const cb of exitCbs) cb(code)
  }, 1000)
  return { pid: p.pid, onExit: (cb) => { exitCbs.push(cb) }, onError: () => {}, unref: () => { timer.unref?.() } }
}

export function realSpawn(spec: SpawnSpec, log?: (message: string) => void): LaunchedProcess {
  if (needsOutsideJob(spec)) {
    try {
      const p = winSpawnAvailable() ? spawnWindowsOutsideJob(spec) : null
      if (p) return p
      log?.('upstream start: cannot start outside the desktop app\'s job, the service will stop when the app exits')
    } catch (e) {
      log?.(`upstream start: starting outside the desktop app's job failed (${(e as Error).message}), the service will stop when the app exits`)
    }
  }
  const child = nodeSpawn(spec.file, spec.args, { cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: true })
  return {
    pid: child.pid,
    onExit: cb => { child.on('exit', cb) },
    onError: cb => { child.on('error', cb) },
    unref: () => child.unref(),
  }
}

export interface CheckResult {
  /** The service answered at all. */
  ok: boolean
  /** Model ids it listed. */
  models: string[]
}

export interface LauncherDeps {
  upstreams(): readonly Upstream[]
  /** Asks the service for its models (the connection test). Must not throw. */
  check(u: Upstream): Promise<CheckResult>
  /** The service is started: here the model list is saved and the health probe is nudged. */
  onReady(u: Upstream, models: string[]): void
  /** The state of any upstream changed (for the live snapshot). */
  onChange(): void
  /** The service we started was stopped by hand: the health probe is nudged. */
  onStopped?(u: Upstream): void
  log?(message: string): void
  spawn?(spec: SpawnSpec): LaunchedProcess
  kill?(pid: number): Promise<void>
  /** Where the started processes are remembered. Without it nothing is remembered (and no process is probed). */
  store?: LaunchedStore
  identity?(pid: number): Promise<ProcessIdentity | null>
  isAlive?(pid: number): boolean
  /** Pids listening on a local port. */
  findListener?(port: number): Promise<number[]>
  dirExists?(path: string): boolean
  now?(): number
  /** Time between checks (default 2 s). */
  pollMs?: number
  /** Give up after this long (default 10 minutes: big models load slowly). */
  timeoutMs?: number
  platform?: NodeJS.Platform
}

interface Run {
  upstream: string
  proc: LaunchedProcess
  timer: ReturnType<typeof setTimeout> | null
  deadline: number
  exited: boolean
  checking: boolean
  done: boolean
}

/**
 * A service this llama-web started (this run or an earlier one); it stays here after the service is up so it can be
 * stopped by hand. `proc` is the handle of this run's spawn; a remembered entry has none.
 */
interface Owned { proc: LaunchedProcess | null, exited: boolean, root: Ident | null, listener: Ident | null, startedAt: number }

export class UpstreamLauncher {
  private readonly states = new Map<string, LaunchState>()
  private readonly runs = new Map<string, Run>()
  private readonly owned = new Map<string, Owned>()

  constructor(private readonly deps: LauncherDeps) {}

  state(id: string): LaunchState {
    return this.states.get(id) ?? { state: 'idle' }
  }

  /** Run the saved command; resolves once the process has been started (not once the service is up). */
  start(id: string, isUp: boolean): void {
    const u = this.deps.upstreams().find(x => x.id === id)
    if (!u) throw new LaunchError('not-found')
    if (!u.startCommand) throw new LaunchError('no-command')
    if (this.runs.has(id)) throw new LaunchError('already-starting')
    if (isUp) throw new LaunchError('already-up')
    let argv: string[]
    try {
      argv = splitArgs(u.startCommand)
    } catch (e) {
      throw new LaunchError('bad-command', (e as Error).message)
    }
    if (argv.length === 0) throw new LaunchError('bad-command')
    const cwd = u.startCwd || undefined
    if (cwd && !(this.deps.dirExists ?? isDirectory)(cwd)) throw new LaunchError('bad-cwd', cwd)

    const { file, args } = launchArgv(argv, this.deps.platform)
    const now = this.deps.now ?? Date.now
    let proc: LaunchedProcess
    try {
      const spec: SpawnSpec = { file, args, cwd, keepRunning: !u.stopOnExit }
      proc = this.deps.spawn ? this.deps.spawn(spec) : realSpawn(spec, this.deps.log)
    } catch (e) {
      this.set(id, { state: 'failed', code: 'spawn-failed', detail: (e as Error).message })
      return
    }
    // The command line can hold secrets: only the program name goes to the log.
    this.deps.log?.(`upstream ${u.name}: started by hand (${basename(file)}), waiting for its models`)
    const run: Run = { upstream: id, proc, timer: null, deadline: now() + (this.deps.timeoutMs ?? 600_000), exited: false, checking: false, done: false }
    this.runs.set(id, run)
    const own: Owned = { proc, exited: false, root: null, listener: null, startedAt: now() }
    this.owned.set(id, own)
    this.persist()
    void this.recordRoot(id, own)
    this.set(id, { state: 'starting', since: now() })
    proc.onError((e) => { if (!run.done) this.finish(run, { state: 'failed', code: 'spawn-failed', detail: e.message }) })
    proc.onExit((code) => {
      run.exited = true
      own.exited = true
      // A launcher that starts the service and exits (code 0) is normal: keep waiting. A crash is not.
      if (!run.done && code !== 0 && code !== null) this.finish(run, { state: 'failed', code: 'exited', detail: String(code) })
    })
    proc.unref()
    this.schedule(run)
  }

  /** Stop waiting. The process we started is ended when it is still running. */
  async cancel(id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    this.finish(run, { state: 'idle' })
    if (!run.exited && run.proc.pid) await (this.deps.kill ?? killTree)(run.proc.pid).catch(() => {})
    this.owned.delete(id)
    this.persist()
  }

  /**
   * Can the service be stopped from here? Only what llama-web started: the process of this run, or (also after a restart
   * of llama-web) a remembered process that is still alive. A service the user started elsewhere is never ours to kill.
   * Off Windows the process group is signalled, so the handle works after a start script has exited; `taskkill /T`
   * needs the pid alive. Cheap on purpose (it is asked for every live snapshot): the identity is checked when stopping.
   */
  canStop(id: string): boolean {
    const o = this.owned.get(id)
    if (!o) return false
    if (o.proc?.pid && (!o.exited || (this.deps.platform ?? process.platform) !== 'win32')) return true
    const alive = this.deps.isAlive ?? isAlive
    return [o.root, o.listener].some(i => !!i && alive(i.pid))
  }

  /** End the service we started for this upstream (and what it started). */
  async stop(id: string): Promise<void> {
    const u = this.deps.upstreams().find(x => x.id === id)
    if (!u) throw new LaunchError('not-found')
    const o = this.owned.get(id)
    if (!o || !this.canStop(id)) throw new LaunchError('not-ours')
    const run = this.runs.get(id)
    if (run) this.finish(run, { state: 'idle' })
    this.owned.delete(id)
    const killed = await this.killOwned(o)
    this.persist()
    if (!killed) throw new LaunchError('not-ours') // every remembered pid is gone or belongs to something else now
    this.deps.log?.(`upstream ${u.name}: stopped by hand`)
    this.deps.onChange()
    this.deps.onStopped?.(u)
  }

  /** Forget the service (it was ended another way, or its upstream was removed). The process is not touched. */
  forget(id: string): void {
    if (this.owned.delete(id)) this.persist()
  }

  /**
   * llama-web started: take back the services an earlier run started. A remembered process only counts when it is alive
   * with the same executable and start time; anything else is dropped. Resolves to how many were taken back. Never throws.
   */
  async restore(): Promise<number> {
    const store = this.deps.store
    if (!store) return 0
    let restored = 0
    try {
      const alive = this.deps.isAlive ?? isAlive
      for (const e of store.load()) {
        const u = this.deps.upstreams().find(x => x.id === e.upstream)
        if (!u || this.owned.has(e.upstream)) continue
        const [root, listener] = await Promise.all([this.stillThere(e.root, alive), this.stillThere(e.listener, alive)])
        if (!root && !listener) continue
        if (this.owned.has(e.upstream)) continue // started by hand while the probes ran
        this.owned.set(e.upstream, { proc: null, exited: true, root, listener, startedAt: e.startedAt })
        restored++
        this.deps.log?.(`upstream ${u.name}: started by an earlier run of llama-web, still running`)
      }
    } catch (e) {
      this.deps.log?.(`upstream start: could not read the remembered services (${(e as Error).message})`)
    }
    this.persist()
    this.deps.onChange()
    return restored
  }

  /**
   * llama-web is exiting: end the processes this run started for upstreams with `stopOnExit` on (decision 60), then
   * close. The others stay running. Never throws.
   */
  async shutdown(): Promise<void> {
    const ids = [...this.owned.keys()]
    await Promise.all(ids.map(async (id) => {
      const u = this.deps.upstreams().find(x => x.id === id)
      const o = this.owned.get(id)
      if (!u?.stopOnExit || !o || !this.canStop(id)) return
      this.owned.delete(id)
      if (await this.killOwned(o)) this.deps.log?.(`upstream ${u.name}: stopped because llama-web is exiting`)
    }))
    this.persist()
    this.close()
  }

  /** Stop the timers and let go of the processes. The services stay running; the file keeps them for the next start. */
  close(): void {
    for (const run of this.runs.values()) { run.done = true; if (run.timer) clearTimeout(run.timer) }
    this.runs.clear()
    this.owned.clear()
  }

  /** End what this entry stands for. True when at least one process was ended. Never throws. */
  private async killOwned(o: Owned): Promise<boolean> {
    const kill = async (pid: number, ident?: Ident) => {
      try {
        if (this.deps.kill || !ident || (this.deps.platform ?? process.platform) === 'win32' || ident.pgid === ident.pid) await (this.deps.kill ?? killTree)(pid)
        else await forceKill(pid) // not a process group leader: signal the process and its tree one by one
        return true
      } catch { return false }
    }
    const done = new Set<number>()
    let any = false
    // The handle of this run: its group / tree, as before.
    const handlePid = o.proc?.pid
    if (handlePid && (!o.exited || (this.deps.platform ?? process.platform) !== 'win32')) {
      done.add(handlePid)
      any = await kill(handlePid) || any
    }
    // Remembered processes: only the ones that are still the same process.
    const alive = this.deps.isAlive ?? isAlive
    for (const ident of [o.root, o.listener]) {
      if (!ident || done.has(ident.pid) || !alive(ident.pid)) continue
      done.add(ident.pid)
      if (!await this.same(ident)) continue
      any = await kill(ident.pid, ident) || any
    }
    return any
  }

  private identity(pid: number): Promise<ProcessIdentity | null> {
    return (this.deps.identity ?? (p => processIdentityAsync(p)))(pid).catch(() => null)
  }

  /** Alive right now with the executable and start time that were recorded. Fails closed. */
  private async same(ident: Ident): Promise<boolean> {
    const now = await this.identity(ident.pid)
    if (!now) return false
    const win = (this.deps.platform ?? process.platform) === 'win32'
    const exe = (s: string) => win ? s.toLowerCase() : s
    return exe(now.exe) === exe(ident.exe) && now.birth === ident.birth
  }

  private async stillThere(ident: Ident | null, alive: (pid: number) => boolean): Promise<Ident | null> {
    return ident && alive(ident.pid) && await this.same(ident) ? ident : null
  }

  private async toIdent(pid: number | undefined): Promise<Ident | null> {
    if (!pid) return null
    const i = await this.identity(pid)
    return i ? { pid, ...i } : null
  }

  /** The process the command created. May stay unknown (unreadable): only the listener can authorize a kill then. */
  private async recordRoot(id: string, own: Owned): Promise<void> {
    if (!this.deps.store) return
    const root = await this.toIdent(own.proc?.pid)
    if (!root || this.owned.get(id) !== own) return
    own.root = root
    this.persist()
  }

  /** The process that listens on the port of a local upstream that just came up. */
  private async recordListener(u: Upstream): Promise<void> {
    const own = this.owned.get(u.id)
    const port = localPortOf(u.baseUrl)
    if (!this.deps.store || !own || port === null) return
    try {
      const pids = await (this.deps.findListener ?? (p => findListener(p, this.deps.platform)))(port)
      const listener = await this.toIdent(pids[0])
      if (!listener || this.owned.get(u.id) !== own) return
      own.listener = listener
      this.persist()
    } catch (e) {
      this.deps.log?.(`upstream ${u.name}: could not find the process that listens on its port (${(e as Error).message})`)
    }
  }

  private persist() {
    const store = this.deps.store
    if (!store) return
    const entries: LaunchedEntry[] = [...this.owned].map(([upstream, o]) => ({ upstream, root: o.root, listener: o.listener, startedAt: o.startedAt }))
    try { store.save(entries) } catch (e) { this.deps.log?.(`upstream start: could not save the started services (${(e as Error).message})`) }
  }

  private set(id: string, s: LaunchState) {
    this.states.set(id, s)
    this.deps.onChange()
  }

  private finish(run: Run, s: LaunchState) {
    if (run.done) return
    run.done = true
    if (run.timer) clearTimeout(run.timer)
    this.runs.delete(run.upstream)
    // A failed start leaves nothing to stop; a timeout may still be loading, so it stays stoppable.
    if (s.state === 'failed' && s.code !== 'timeout') { this.owned.delete(run.upstream); this.persist() }
    this.set(run.upstream, s)
  }

  private schedule(run: Run) {
    run.timer = setTimeout(() => void this.poll(run), this.deps.pollMs ?? 2000)
    run.timer.unref?.()
  }

  private async poll(run: Run) {
    if (run.done || run.checking) return
    run.checking = true
    try {
      const u = this.deps.upstreams().find(x => x.id === run.upstream)
      if (!u) { this.finish(run, { state: 'idle' }); return }
      const r = await this.deps.check(u).catch(() => ({ ok: false, models: [] as string[] }))
      if (run.done) return
      // Started = it lists models (a service that cannot list them: the models typed in by hand stand in for the list).
      if (r.ok && (r.models.length > 0 || u.manualModels.length > 0)) {
        await this.recordListener(u)
        if (run.done) return
        this.deps.log?.(`upstream ${u.name}: up after the manual start`)
        this.finish(run, { state: 'idle' })
        this.deps.onReady(u, r.models)
        return
      }
      if ((this.deps.now ?? Date.now)() >= run.deadline) {
        this.finish(run, { state: 'failed', code: 'timeout', detail: String(Math.round((this.deps.timeoutMs ?? 600_000) / 1000)) })
        return
      }
    } finally {
      run.checking = false
    }
    if (!run.done) this.schedule(run)
  }
}

function isDirectory(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory() } catch { return false }
}
