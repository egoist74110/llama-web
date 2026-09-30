// Model scheduler: per-target state machine, serialised switching queue, draining with a
// timeout, shared loads, crash auto-reload (at most once), and an LRU online limit.
// Process handling is injected (`launch`), so this module is pure and testable.
//
// State machine (see plan「核心行为规则」):
//   stopped -> loading -> ready -> draining -> unloading -> stopped
//   loading -> failed (manual retry only)
//   ready -> crashed -> (next request) loading, auto at most once; failing again -> failed
//
// A target is model + profile; switching profile means a restart. All loads run one at a
// time through a FIFO job queue. Requests for a ready target are served directly.

export interface Target {
  modelId: string
  profile: string
}

export type ModelState = 'stopped' | 'loading' | 'ready' | 'draining' | 'unloading' | 'failed' | 'crashed'

/** What the scheduler needs from a started process (implemented by runner.RunningProcess). */
export interface ModelProcess {
  readonly port: number
  /** Resolves when the process is healthy; rejects on load failure / timeout / exit. */
  readonly ready: Promise<void>
  /** Resolves when the process has exited for any reason. */
  readonly exited: Promise<unknown>
  /** Kill the process (tree) and wait for exit. Idempotent. */
  stop(): Promise<unknown>
}

export type Launcher = (target: Target) => Promise<ModelProcess>

export type SchedulerErrorCode =
  | 'failed' // the target failed to load (or is in the failed state); needs a manual retry
  | 'stopped' // the target was stopped manually while the request was waiting
  | 'cancelled' // the waiting request was aborted by its caller
  | 'shutdown' // the scheduler is shutting down

export class SchedulerError extends Error {
  constructor(public code: SchedulerErrorCode, public target: Target, public cause?: unknown) {
    super(`${code}: ${target.modelId}:${target.profile}`)
    this.name = 'SchedulerError'
  }
}

/** Stored as the `error` of a target whose process exited unexpectedly. */
export class ModelCrashError extends Error {
  constructor(public exit: unknown) {
    super('Model process exited unexpectedly')
    this.name = 'ModelCrashError'
  }
}

export type LeaseOutcome = 'ok' | 'error'

/** A request's hold on a ready model. Always release it. */
export interface Lease {
  readonly target: Target
  readonly port: number
  /** Aborted when the model is force-unloaded (drain timeout) or crashes. */
  readonly signal: AbortSignal
  /**
   * 'ok' = the upstream response completed normally; this is what proves a reloaded model
   * healthy again after a crash. Omit when unknown (client aborted, upstream error, ...).
   */
  release(outcome?: LeaseOutcome): void
}

export type SchedulerEvent =
  | { type: 'state', target: Target, from: ModelState, to: ModelState, error?: unknown }
  | { type: 'drain-timeout', target: Target, inflight: number }

export interface SchedulerOptions {
  launch: Launcher
  /** Online limit X (fixed at 1 for now). */
  maxLoaded?: number
  drainTimeoutMs: number
  onEvent?: (e: SchedulerEvent) => void
}

export interface ModelSnapshot {
  modelId: string
  profile: string
  state: ModelState
  port: number | null
  inflight: number
  lastUsedAt: number | null
  error: unknown
}

export interface QueueSnapshot {
  modelId: string
  profile: string
  kind: 'load'
  started: boolean
  waiting: number
}

export interface SchedulerSnapshot {
  models: ModelSnapshot[]
  queue: QueueSnapshot[]
}

const OCCUPYING: ReadonlySet<ModelState> = new Set(['loading', 'ready', 'draining', 'unloading'])

const keyOf = (t: Target) => JSON.stringify([t.modelId, t.profile])

interface Instance {
  key: string
  target: Target
  state: ModelState
  proc: ModelProcess | null
  inflight: Set<LeaseImpl>
  useSeq: number
  lastUsedAt: number | null
  error: unknown
  /** Launched by the automatic post-crash reload. */
  autoReloaded: boolean
  /** At least one request completed normally on this process. */
  servedOk: boolean
  stopRequested: boolean
  evicting: Promise<void> | null
  forceNow: (() => void) | null
  drainWaiters: Array<() => void>
  /** Called once the instance leaves `loading`. */
  loadWaiters: Array<() => void>
}

interface Waiter {
  /** Manual start()/retry() callers: they get no lease and are not cancellable. */
  manual: boolean
  resolve: (inst: Instance) => void
  reject: (e: SchedulerError) => void
}

interface Job {
  key: string
  target: Target
  waiters: Waiter[]
  started: boolean
  fromCrash: boolean
  cancelled: boolean
}

class LeaseImpl implements Lease {
  readonly controller = new AbortController()
  released = false
  readonly port: number

  constructor(private sched: Scheduler, readonly inst: Instance) {
    this.port = inst.proc!.port
  }

  get target() { return this.inst.target }
  get signal() { return this.controller.signal }

  release(outcome?: LeaseOutcome): void {
    if (this.released) return
    this.released = true
    this.sched.onRelease(this, outcome)
  }
}

export class Scheduler {
  private readonly instances = new Map<string, Instance>()
  private readonly queue: Job[] = []
  private current: Job | null = null
  private pumping = false
  private seq = 0
  private shuttingDown = false
  readonly maxLoaded: number

  constructor(private opts: SchedulerOptions) {
    this.maxLoaded = Math.max(1, opts.maxLoaded ?? 1)
  }

  /** Current state of a target (`stopped` when unknown). */
  stateOf(target: Target): ModelState {
    return this.instances.get(keyOf(target))?.state ?? 'stopped'
  }

  /**
   * Get a lease on `target`, loading it (and unloading others) if needed.
   * Rejects with SchedulerError; `failed` targets reject immediately without loading.
   */
  acquire(target: Target, opts: { signal?: AbortSignal } = {}): Promise<Lease> {
    const { signal } = opts
    if (this.shuttingDown) return Promise.reject(new SchedulerError('shutdown', target))
    if (signal?.aborted) return Promise.reject(new SchedulerError('cancelled', target, signal.reason))
    const inst = this.instances.get(keyOf(target))
    if (inst?.state === 'ready') return Promise.resolve(this.lease(inst))
    if (inst?.state === 'failed') return Promise.reject(new SchedulerError('failed', target, inst.error))

    return new Promise<Lease>((resolve, reject) => {
      const job = this.jobFor(target)
      const waiter: Waiter = {
        manual: false,
        resolve: (i) => { cleanup(); resolve(this.lease(i)) },
        reject: (e) => { cleanup(); reject(e) },
      }
      const onAbort = () => {
        const idx = job.waiters.indexOf(waiter)
        if (idx < 0) return
        job.waiters.splice(idx, 1)
        reject(new SchedulerError('cancelled', target, signal?.reason))
        // Nobody left waiting and the switch has not begun: drop it.
        if (!job.started && job.waiters.length === 0) {
          const q = this.queue.indexOf(job)
          if (q >= 0) this.queue.splice(q, 1)
        }
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      signal?.addEventListener('abort', onAbort, { once: true })
      job.waiters.push(waiter)
    })
  }

  /** Manual start, also used as「重试」for failed/crashed targets. Resolves when ready. */
  start(target: Target): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new SchedulerError('shutdown', target))
    const inst = this.instances.get(keyOf(target))
    if (inst?.state === 'ready') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.jobFor(target, true).waiters.push({ manual: true, resolve: () => resolve(), reject })
    })
  }

  retry(target: Target): Promise<void> {
    return this.start(target)
  }

  /**
   * Manual stop of every profile of a model: queued requests for it are rejected with
   * `stopped`, a load in progress is aborted, a ready process is drained (or killed at once
   * with `force`) and unloaded, and failed/crashed marks are cleared.
   */
  async stop(modelId: string, opts: { force?: boolean } = {}): Promise<void> {
    const mine = (t: Target) => t.modelId === modelId
    for (const job of [...this.queue]) {
      if (!mine(job.target)) continue
      this.queue.splice(this.queue.indexOf(job), 1)
      this.rejectAll(job, 'stopped')
    }
    if (this.current && mine(this.current.target)) this.current.cancelled = true

    const pending: Promise<void>[] = []
    for (const inst of [...this.instances.values()]) {
      if (!mine(inst.target)) continue
      switch (inst.state) {
        case 'loading':
          pending.push(this.abortLoad(inst))
          break
        case 'ready':
        case 'draining':
        case 'unloading':
          pending.push(this.evict(inst, !!opts.force))
          break
        case 'failed':
        case 'crashed':
        case 'stopped':
          this.setState(inst, 'stopped')
          this.instances.delete(inst.key)
          break
      }
    }
    await Promise.all(pending)
  }

  /** Reject everything and kill all processes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const job of this.queue.splice(0)) this.rejectAll(job, 'shutdown')
    if (this.current) this.current.cancelled = true
    const pending: Promise<unknown>[] = []
    for (const inst of this.instances.values()) {
      if (inst.state === 'loading') {
        pending.push(this.abortLoad(inst))
      } else if (OCCUPYING.has(inst.state)) {
        pending.push(this.evict(inst, true))
      }
    }
    await Promise.all(pending)
  }

  snapshot(): SchedulerSnapshot {
    const models: ModelSnapshot[] = [...this.instances.values()].map(i => ({
      modelId: i.target.modelId,
      profile: i.target.profile,
      state: i.state,
      port: i.proc?.port ?? null,
      inflight: i.inflight.size,
      lastUsedAt: i.lastUsedAt,
      error: i.error,
    }))
    const jobs = this.current ? [this.current, ...this.queue] : [...this.queue]
    const queue: QueueSnapshot[] = jobs.map(j => ({
      modelId: j.target.modelId,
      profile: j.target.profile,
      kind: 'load',
      started: j.started,
      waiting: j.waiters.filter(w => !w.manual).length,
    }))
    return { models, queue }
  }

  // -------------------------------------------------------------------------------------

  private abortLoad(inst: Instance): Promise<void> {
    inst.stopRequested = true
    const left = new Promise<void>(r => inst.loadWaiters.push(r))
    inst.proc?.stop().catch(() => {})
    return left
  }

  /** @internal called by LeaseImpl.release */
  onRelease(lease: LeaseImpl, outcome?: LeaseOutcome): void {
    const inst = lease.inst
    inst.inflight.delete(lease)
    this.touch(inst)
    if (outcome === 'ok' && inst.state === 'ready') inst.servedOk = true
    if (inst.inflight.size === 0) {
      for (const w of inst.drainWaiters.splice(0)) w()
    }
  }

  private touch(inst: Instance) {
    inst.useSeq = ++this.seq
    inst.lastUsedAt = Date.now()
  }

  private lease(inst: Instance): Lease {
    const l = new LeaseImpl(this, inst)
    inst.inflight.add(l)
    this.touch(inst)
    return l
  }

  /** Existing load job for the target (running or queued), or a new queued one. */
  private jobFor(target: Target, manual = false): Job {
    const key = keyOf(target)
    const existing = [this.current, ...this.queue].find(j => j && j.key === key && !j.cancelled)
    if (existing) return existing
    const inst = this.instances.get(key)
    const job: Job = {
      key, target, waiters: [], started: false, cancelled: false,
      fromCrash: !manual && inst?.state === 'crashed',
    }
    this.queue.push(job)
    queueMicrotask(() => void this.pump())
    return job
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        this.current = job
        job.started = true
        try {
          await this.runLoad(job)
        } catch (e) {
          // runLoad handles its own failures; this is a safety net.
          this.failAll(job, e)
        }
        this.current = null
      }
    } finally {
      this.pumping = false
    }
  }

  private async runLoad(job: Job): Promise<void> {
    const { key, target } = job
    let inst = this.instances.get(key)
    if (inst?.state === 'ready') return this.resolveAll(job, inst)
    const manual = job.waiters.some(w => w.manual)
    if (inst?.state === 'failed' && !manual) return this.failAll(job, inst.error)
    // The same target may still be on its way out (manual stop); let it finish first.
    if (inst?.evicting) await inst.evicting

    // Make room: evict least-recently-used ready models until below the limit.
    for (;;) {
      if (job.cancelled) return this.rejectAll(job, this.shuttingDown ? 'shutdown' : 'stopped')
      const others = [...this.instances.values()].filter(i => i.key !== key && OCCUPYING.has(i.state))
      if (others.length < this.maxLoaded) break
      const victim = others.filter(i => i.state === 'ready').sort((a, b) => a.useSeq - b.useSeq)[0]
      if (victim) await this.evict(victim, false)
      else await Promise.race(others.map(i => i.evicting ?? i.proc?.exited ?? Promise.resolve()))
    }

    inst = this.newInstance(target, job.fromCrash && !manual, inst?.state)
    this.setState(inst, 'loading')
    let proc: ModelProcess | null = null
    try {
      proc = await this.opts.launch(target)
      inst.proc = proc
      if (inst.stopRequested) await proc.stop()
      void proc.exited.then(exit => this.onExit(inst!, exit))
      await proc.ready
      if (inst.stopRequested) throw new Error('stopped')
    } catch (e) {
      if (proc) await proc.stop().catch(() => {})
      if (inst.stopRequested || job.cancelled) {
        this.setState(inst, 'stopped')
        this.instances.delete(key)
        return this.rejectAll(job, this.shuttingDown ? 'shutdown' : 'stopped')
      }
      inst.error = e
      inst.proc = null
      this.setState(inst, 'failed', e)
      return this.failAll(job, e)
    }
    this.setState(inst, 'ready')
    this.resolveAll(job, inst)
  }

  private newInstance(target: Target, autoReloaded: boolean, prev: ModelState = 'stopped'): Instance {
    const inst: Instance = {
      key: keyOf(target), target, state: prev, proc: null, inflight: new Set(),
      useSeq: ++this.seq, lastUsedAt: null, error: null, autoReloaded, servedOk: false,
      stopRequested: false, evicting: null, forceNow: null, drainWaiters: [], loadWaiters: [],
    }
    this.instances.set(inst.key, inst)
    return inst
  }

  private onExit(inst: Instance, exit: unknown) {
    if (this.instances.get(inst.key) !== inst) return
    if (inst.state !== 'ready') return // loading: handled by runLoad; draining/unloading: by evict
    for (const l of inst.inflight) l.controller.abort(new ModelCrashError(exit))
    inst.proc = null
    inst.error = new ModelCrashError(exit)
    // A crash right after the automatic reload, before any request succeeded: give up.
    const next: ModelState = inst.autoReloaded && !inst.servedOk ? 'failed' : 'crashed'
    this.setState(inst, next, inst.error)
  }

  /** ready/draining -> draining -> unloading -> stopped. Idempotent; `force` skips the wait. */
  private evict(inst: Instance, force: boolean): Promise<void> {
    if (inst.evicting) {
      if (force) inst.forceNow?.()
      return inst.evicting
    }
    inst.evicting = (async () => {
      this.setState(inst, 'draining')
      if (!force && inst.inflight.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = await Promise.race([
          new Promise<boolean>(r => inst.drainWaiters.push(() => r(false))),
          new Promise<boolean>((r) => { timer = setTimeout(() => r(true), this.opts.drainTimeoutMs) }),
          new Promise<boolean>((r) => { inst.forceNow = () => r(false) }),
          inst.proc ? inst.proc.exited.then(() => false) : Promise.resolve(false),
        ])
        clearTimeout(timer)
        inst.forceNow = null
        inst.drainWaiters = []
        if (timedOut) this.emit({ type: 'drain-timeout', target: inst.target, inflight: inst.inflight.size })
      }
      for (const l of inst.inflight) l.controller.abort(new Error('model unloaded'))
      this.setState(inst, 'unloading')
      if (inst.proc) await inst.proc.stop().catch(() => {})
      inst.proc = null
      this.setState(inst, 'stopped')
      if (this.instances.get(inst.key) === inst) this.instances.delete(inst.key)
    })()
    return inst.evicting
  }

  private setState(inst: Instance, to: ModelState, error?: unknown) {
    const from = inst.state
    if (from === to) return
    inst.state = to
    if (to !== 'failed' && to !== 'crashed') inst.error = null
    if (from === 'loading') for (const w of inst.loadWaiters.splice(0)) w()
    this.emit({ type: 'state', target: inst.target, from, to, ...(error !== undefined ? { error } : {}) })
  }

  private emit(e: SchedulerEvent) {
    try { this.opts.onEvent?.(e) } catch { /* listeners must not break scheduling */ }
  }

  private resolveAll(job: Job, inst: Instance) {
    for (const w of job.waiters.splice(0)) w.resolve(inst)
  }

  private failAll(job: Job, cause: unknown) {
    for (const w of job.waiters.splice(0)) w.reject(new SchedulerError('failed', job.target, cause))
  }

  private rejectAll(job: Job, code: SchedulerErrorCode) {
    for (const w of job.waiters.splice(0)) w.reject(new SchedulerError(code, job.target))
  }
}
