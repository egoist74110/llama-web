// Starting an external upstream by hand (decision 56 ⑩): the user saved a command line for it; when the service is not up
// the page can run it. llama-web then keeps asking the service for its model list until models show up (= started), the
// process we ran exits with an error, or the wait runs out. The service stays the user's: it is started detached, its
// output is not read, it is not recorded in pids.json and not stopped when llama-web exits. Pure module: spawn, the
// check, the clock and the timers are injected.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { splitArgs } from './args'
import { killTree } from './runner'
import type { Upstream } from './upstreams'

export type LaunchErrorCode = 'not-found' | 'no-command' | 'already-up' | 'already-starting' | 'bad-cwd' | 'bad-command'

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

export interface SpawnSpec { file: string, args: string[], cwd: string | undefined }

/** `.bat` / `.cmd` cannot be started directly on Windows: they go through `cmd.exe /c`. Everything else is run as written. */
export function launchArgv(argv: string[], platform: NodeJS.Platform = process.platform): { file: string, args: string[] } {
  const [file, ...args] = argv
  if (platform === 'win32' && file && ['.bat', '.cmd'].includes(extname(file).toLowerCase())) return { file: 'cmd.exe', args: ['/c', file, ...args] }
  return { file: file!, args }
}

export function realSpawn(spec: SpawnSpec): LaunchedProcess {
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
  log?(message: string): void
  spawn?(spec: SpawnSpec): LaunchedProcess
  kill?(pid: number): Promise<void>
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

export class UpstreamLauncher {
  private readonly states = new Map<string, LaunchState>()
  private readonly runs = new Map<string, Run>()

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
      proc = (this.deps.spawn ?? realSpawn)({ file, args, cwd })
    } catch (e) {
      this.set(id, { state: 'failed', code: 'spawn-failed', detail: (e as Error).message })
      return
    }
    // The command line can hold secrets: only the program name goes to the log.
    this.deps.log?.(`upstream ${u.name}: started by hand (${basename(file)}), waiting for its models`)
    const run: Run = { upstream: id, proc, timer: null, deadline: now() + (this.deps.timeoutMs ?? 600_000), exited: false, checking: false, done: false }
    this.runs.set(id, run)
    this.set(id, { state: 'starting', since: now() })
    proc.onError((e) => { if (!run.done) this.finish(run, { state: 'failed', code: 'spawn-failed', detail: e.message }) })
    proc.onExit((code) => {
      run.exited = true
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
  }

  /** llama-web is closing: stop the timers. The services stay running. */
  close(): void {
    for (const run of this.runs.values()) { run.done = true; if (run.timer) clearTimeout(run.timer) }
    this.runs.clear()
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
