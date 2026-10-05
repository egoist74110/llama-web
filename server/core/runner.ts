// llama-server process management: port allocation, spawn (argv array, no shell), /health
// polling with a load timeout, stdout/stderr line capture, process-tree stop, and the
// data/run/pids.json registry used for residue cleanup. Node APIs only (works under Bun
// and under the Node dev server).
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { writeFileAtomic } from './store'
import { processIdentityAsync } from './process-identity'

// ---------------------------------------------------------------------------------------
// pids.json

export interface PidRecord {
  pid: number
  exe: string
  port: number
  /** Free-form owner tag, e.g. `modelId:profile`. */
  tag: string
  startedAt: string
  birth?: string
  pgid?: number
  ownerPid?: number
}

interface PidFile {
  version: 2
  processes: PidRecord[]
}

/** Child process registry persisted to `data/run/pids.json` (atomic writes). */
export class PidRegistry {
  private probes = new Set<Promise<void>>()
  constructor(readonly file: string) {}

  list(): PidRecord[] {
    if (!existsSync(this.file)) return []
    let doc: Partial<PidFile>
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PidFile>
    } catch {
      // A torn or hand-mangled run file is not worth failing over; treat it as empty.
      return []
    }
    if (!Array.isArray(doc?.processes)) return []
    if ((doc as { version?: number }).version === 1) {
      const backup = `${this.file}.v1.bak`
      if (!existsSync(backup)) copyFileSync(this.file, backup)
      else {
        if (!statSync(backup).isFile()) throw new Error('PID migration backup is not a file')
        if (readFileSync(backup, 'utf8') !== readFileSync(this.file, 'utf8')) copyFileSync(this.file, `${backup}.${Date.now()}`)
      }
      this.write(doc.processes) // Backup / migration failures must not become an empty registry.
    } else if (typeof doc.version === 'number' && doc.version > 2) throw new Error('PID registry version is newer than this application')
    else if (doc.version !== 2) return []
    return doc.processes.filter(p => Number.isInteger(p?.pid) && p.pid > 0 && typeof p.exe === 'string')
  }

  add(rec: PidRecord): void {
    this.write([...this.list().filter(p => p.pid !== rec.pid), rec])
  }
  identify(rec: PidRecord, child: ChildProcess): Promise<void> {
    const abort = new AbortController()
    const onExit = () => abort.abort()
    child.once('exit', onExit)
    const pending = (async () => {
      try {
        const identity = await processIdentityAsync(rec.pid, abort.signal)
        if (!identity || abort.signal.aborted) return
        const current = this.list().find(r => r.pid === rec.pid && r.startedAt === rec.startedAt && r.exe === rec.exe)
        if (current) this.add({ ...current, birth: identity.birth })
      } finally {
        child.removeListener('exit', onExit)
      }
    })()
    this.probes.add(pending)
    void pending.then(() => this.probes.delete(pending), () => this.probes.delete(pending))
    return pending
  }
  async flushIdentities(): Promise<void> { await Promise.allSettled([...this.probes]) }

  remove(pids: number | number[]): void {
    const drop = new Set(Array.isArray(pids) ? pids : [pids])
    const cur = this.list()
    const next = cur.filter(p => !drop.has(p.pid))
    if (next.length !== cur.length) this.write(next)
  }

  private write(processes: PidRecord[]) {
    const doc: PidFile = { version: 2, processes }
    writeFileAtomic(this.file, JSON.stringify(doc, null, 2) + '\n')
  }
}

// ---------------------------------------------------------------------------------------
// Process helpers

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Kill a process and all its descendants. Resolves once the kill command has run. */
export function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    return stopProcessGroup(pid)
  }
  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { tk.kill('SIGKILL') }, 5000)
    const done = () => { clearTimeout(timer); resolve() }
    tk.on('error', done)
    tk.on('close', done)
  })
}
/** Owned detached group; works even after its original leader exited. */
export async function stopProcessGroup(pgid: number, deps: {
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void,
  wait?: (ms: number) => Promise<void>, graceMs?: number,
} = {}): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) throw new Error('Invalid owned process group')
  const signal = deps.signal ?? ((p, s) => { process.kill(p, s) })
  const wait = deps.wait ?? (ms => new Promise(r => setTimeout(r, ms)))
  const send = (s: NodeJS.Signals | 0) => {
    try { signal(-pgid, s); return true } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // macOS answers EPERM, not ESRCH, while the group's only members are zombies that exit has not
      // reaped yet. The group is ours, so this means there is nothing left to signal.
      if (code === 'ESRCH' || code === 'EPERM') return false
      throw e
    }
  }
  if (!send('SIGTERM')) return
  let remaining = deps.graceMs ?? 1500
  while (remaining > 0 && send(0)) { const ms = Math.min(50, remaining); await wait(ms); remaining -= ms }
  if (send(0)) send('SIGKILL')
}

/** True when `port` can be bound on `host` right now. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

/** First free port in [from, to] not in `exclude`, or null. */
export async function allocatePort(range: [number, number], exclude: Iterable<number> = [], host = '127.0.0.1'): Promise<number | null> {
  const skip = new Set(exclude)
  for (let p = range[0]; p <= range[1]; p++) {
    if (skip.has(p)) continue
    if (await isPortFree(p, host)) return p
  }
  return null
}

// ---------------------------------------------------------------------------------------
// Runner

export type LoadErrorCode =
  | 'no-port' // no free port in the configured range
  | 'spawn-failed' // the executable could not be started
  | 'register-failed' // started, but pids.json could not be written; the process was killed
  | 'exited' // the process exited before /health reported ready
  | 'timeout' // /health did not report ready within the load timeout
  | 'aborted' // stop() was called while loading

export class LoadError extends Error {
  constructor(
    public code: LoadErrorCode,
    message: string,
    public exitCode: number | null = null,
    /** Last output lines at the time of failure (for the failure card). */
    public tail: string[] = [],
  ) {
    super(message)
    this.name = 'LoadError'
  }
}

export interface ExitInfo {
  code: number | null
  signal: string | null
  /** True when the exit was caused by stop(). */
  requested: boolean
}

export type LogStream = 'stdout' | 'stderr'

export interface StartSpec {
  exe: string
  /** Builds the argument array (without the executable) for the allocated port. */
  args: (port: number) => string[]
  tag: string
  cwd?: string
  env?: Record<string, string | undefined>
  loadTimeoutMs: number
  onLine?: (stream: LogStream, line: string) => void
  /** Called with the unfinished tail of the output after each read (no newline yet). */
  onPartial?: (stream: LogStream, partial: string) => void
}

export interface RunnerOptions {
  portRange: [number, number]
  /** pids.json registry; omit to skip persistence (tests). */
  registry?: PidRegistry
  host?: string
  healthIntervalMs?: number
  /** Output lines kept in memory per process. */
  tailLines?: number
}

export class Runner {
  private readonly procs = new Set<RunningProcess>()
  /** Ports handed out but possibly not bound yet. */
  private readonly reserved = new Set<number>()
  readonly host: string

  constructor(readonly opts: RunnerOptions) {
    this.host = opts.host ?? '127.0.0.1'
  }

  /** Tail of the allocation queue: two starts never probe the range at the same time. */
  private allocating: Promise<unknown> = Promise.resolve()

  /** The first free port, reserved before the next allocation looks (several models may start close together). */
  private reservePort(): Promise<number | null> {
    const run = this.allocating.then(async () => {
      const port = await allocatePort(this.opts.portRange, this.reserved, this.host)
      if (port !== null) this.reserved.add(port)
      return port
    })
    this.allocating = run.catch(() => null)
    return run
  }

  /** Allocate a port and spawn. Load progress is reported through `ready`. */
  async start(spec: StartSpec): Promise<RunningProcess> {
    const port = await this.reservePort()
    if (port === null) {
      throw new LoadError('no-port', `No free port in ${this.opts.portRange[0]}-${this.opts.portRange[1]}`)
    }
    const rp = new RunningProcess(this, spec, port)
    this.procs.add(rp)
    rp.exited.then(() => {
      this.procs.delete(rp)
      this.reserved.delete(port)
    })
    rp.launch()
    return rp
  }

  list(): RunningProcess[] {
    return [...this.procs]
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map(p => p.stop()))
    await this.registry?.flushIdentities()
  }

  /** @internal */
  get healthIntervalMs() { return this.opts.healthIntervalMs ?? 500 }
  /** @internal */
  get tailLines() { return this.opts.tailLines ?? 200 }
  /** @internal */
  get registry() { return this.opts.registry }
}

export class RunningProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<ExitInfo>
  pid: number | null = null
  readonly startedAt = new Date()

  private child: ChildProcess | null = null
  private readonly lines: string[] = []
  private stopRequested = false
  private settled = false
  private resolveReady!: () => void
  private rejectReady!: (e: LoadError) => void
  private resolveExited!: (e: ExitInfo) => void
  private healthTimer: ReturnType<typeof setTimeout> | null = null
  private loadTimer: ReturnType<typeof setTimeout> | null = null
  private exitInfo: ExitInfo | null = null

  constructor(private runner: Runner, readonly spec: StartSpec, readonly port: number) {
    this.ready = new Promise<void>((res, rej) => { this.resolveReady = res; this.rejectReady = rej })
    // Callers that only care about `exited` must not trigger unhandled rejections.
    this.ready.catch(() => {})
    this.exited = new Promise<ExitInfo>((res) => { this.resolveExited = res })
  }

  get url(): string {
    return `http://${this.runner.host}:${this.port}`
  }

  get isRunning(): boolean {
    return this.exitInfo === null
  }

  /** Last `n` output lines (stdout and stderr interleaved). */
  tail(n = 30): string[] {
    return this.lines.slice(-n)
  }

  /** @internal */
  launch(): void {
    const { exe, cwd, env } = this.spec
    let child: ChildProcess
    try {
      child = spawn(exe, this.spec.args(this.port), {
        cwd: cwd ?? dirname(exe),
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
    } catch (e) {
      this.failLoad(new LoadError('spawn-failed', (e as Error).message))
      this.finish({ code: null, signal: null, requested: false })
      return
    }
    this.child = child
    this.pid = child.pid ?? null

    child.on('error', (e) => {
      // Emitted when the executable cannot be started (no 'exit' follows in that case).
      if (this.pid === null) {
        this.failLoad(new LoadError('spawn-failed', e.message))
        this.finish({ code: null, signal: null, requested: false })
      }
    })
    if (this.pid === null) return

    this.pipeLines(child.stdout!, 'stdout')
    this.pipeLines(child.stderr!, 'stderr')
    // 'exit' can arrive before the last output is read; wait for 'close' (pipes drained),
    // but not forever in case an orphaned grandchild keeps a pipe open.
    let exit: { code: number | null, signal: string | null } | null = null
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(exitTimer)
      if (!exit) return
      const { code, signal } = exit
      if (this.stopRequested) {
        this.failLoad(new LoadError('aborted', 'Stopped while loading', code, this.tail()))
      } else {
        this.failLoad(new LoadError('exited', `Exited with code ${code ?? signal}`, code, this.tail()))
      }
      this.finish({ code, signal, requested: this.stopRequested })
    }
    let groupDone: Promise<void> = Promise.resolve()
    child.on('exit', (code, signal) => {
      exit = { code, signal }
      if (process.platform !== 'win32' && this.pid) groupDone = killTree(this.pid)
      void groupDone.then(() => { if (!this.exitInfo) { exitTimer = setTimeout(done, 1000); exitTimer.unref?.() } }, () => done())
    })
    child.on('close', (code, signal) => {
      exit ??= { code, signal }
      void groupDone.then(done, done)
    })

    // Register only after the exit handlers are in place, so a failed write can still
    // kill the process and settle `ready` / `exited` normally.
    try {
      const record: PidRecord = {
        pid: this.pid, exe, port: this.port, tag: this.spec.tag, startedAt: this.startedAt.toISOString(),
        ownerPid: process.pid,
        pgid: process.platform !== 'win32' ? this.pid : undefined,
      }
      this.runner.registry?.add(record)
      const identified = this.runner.registry?.identify(record, child) ?? Promise.resolve()
      void identified.then(() => { if (!this.settled) this.scheduleHealth(0) }, e => {
        this.failLoad(new LoadError('register-failed', `Cannot record process identity: ${(e as Error).message}`))
        void this.stop()
      })
    } catch (e) {
      this.failLoad(new LoadError('register-failed', `Cannot record pid: ${(e as Error).message}`))
      void this.stop()
      return
    }

    this.loadTimer = setTimeout(() => {
      if (this.settled) return
      this.failLoad(new LoadError('timeout', `Not ready after ${this.spec.loadTimeoutMs} ms`, null, this.tail()))
      void this.stop()
    }, this.spec.loadTimeoutMs)
  }

  /** Kill the process tree and wait for exit. Safe to call repeatedly. */
  async stop(): Promise<ExitInfo> {
    if (this.exitInfo) return this.exitInfo
    this.stopRequested = true
    if (this.pid !== null) {
      await killTree(this.pid)
      // taskkill can fail on a process that is exiting on its own; fall back to a direct kill.
      const t = setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* gone */ } }, 3000)
      const info = await this.exited
      await this.runner.registry?.flushIdentities()
      clearTimeout(t)
      return info
    }
    return this.exited
  }

  private scheduleHealth(delay: number) {
    this.healthTimer = setTimeout(() => void this.checkHealth(), delay)
  }

  private async checkHealth() {
    if (this.settled) return
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) })
      await res.body?.cancel()
      if (res.status === 200 && !this.settled) {
        this.settled = true
        this.clearTimers()
        this.resolveReady()
        return
      }
    } catch {
      // Not listening yet.
    }
    if (!this.settled) this.scheduleHealth(this.runner.healthIntervalMs)
  }

  private failLoad(e: LoadError) {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.rejectReady(e)
  }

  private finish(info: ExitInfo) {
    if (this.exitInfo) return
    this.exitInfo = info
    this.clearTimers()
    if (this.pid !== null) {
      try { this.runner.registry?.remove(this.pid) } catch { /* registry is best effort */ }
    }
    this.resolveExited(info)
  }

  private clearTimers() {
    if (this.healthTimer) clearTimeout(this.healthTimer)
    if (this.loadTimer) clearTimeout(this.loadTimer)
    this.healthTimer = this.loadTimer = null
  }

  private pipeLines(stream: NodeJS.ReadableStream, name: LogStream) {
    const decoder = new TextDecoder()
    let buf = ''
    const emit = (line: string) => {
      this.lines.push(line)
      if (this.lines.length > this.runner.tailLines) this.lines.splice(0, this.lines.length - this.runner.tailLines)
      try { this.spec.onLine?.(name, line) } catch { /* listener errors must not kill capture */ }
    }
    stream.on('data', (chunk: Buffer) => {
      buf += decoder.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        emit(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
      // The unfinished line (the weight loader prints its progress dots without a newline).
      if (buf) try { this.spec.onPartial?.(name, buf) } catch { /* listener errors must not kill capture */ }
    })
    stream.on('end', () => {
      buf += decoder.decode()
      if (buf) emit(buf.replace(/\r$/, ''))
      buf = ''
    })
  }
}
