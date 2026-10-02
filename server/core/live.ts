// Live state for the UI: builds the state snapshot, keeps a short activity history and
// pushes changes to /api/stream subscribers. Pure module (no Nitro), testable with bun test.
import type { ModelsDoc } from './config'
import { diagnose, type FailureDoc } from './errors'
import type { GpuDoc } from './gpu'
import { missingFiles, type ModelFile } from './models-admin'
import type { JobRev, SetupJob } from './cloudflare'
import type { RuntimeStatus } from './llamacpp'
import type { VersionView } from './updater'
import type { AppUpdateView } from './app-update'
import type { RequestRecord } from './request-log'
import type { LogStream } from './runner'
import type { ModelState, SchedulerEvent, SchedulerSnapshot } from './scheduler'
import type { SpeedDoc } from './speed'
import type { TunnelInfo } from './tunnel'
import type { FileRef, ModelDir } from './types'
import type { PlatformInfo } from './platform'

export interface StateInstance {
  profile: string
  state: ModelState
  inflight: number
  /** Error code or message; null when there is none. */
  error: string | null
  /** Diagnosis of a failed / crashed instance (kind, exit code, last output lines). */
  failure: FailureDoc | null
  /** Epoch ms when the instance entered its current state. */
  since: number | null
  /** Estimated load progress 0..99 while loading; null otherwise or when nothing was recognised yet. */
  progress: number | null
}

export interface StateDoc {
  platform?: PlatformInfo
  /** Server clock (epoch ms) at the time of the snapshot. */
  now: number
  models: Array<{
    id: string
    name: string
    activeProfile: string
    profiles: string[]
    hasMmproj: boolean
    /** Configured files as `dir/relative/path` (mmproj / draft are null when not set). */
    files: { model: string, mmproj: string | null, draft: string | null }
    /** Configured files that no longer exist on disk. */
    missing: ModelFile[]
    instances: StateInstance[]
  }>
  queue: Array<{ modelId: string, profile: string, started: boolean, waiting: number }>
  llamacpp: {
    current: string
    runtime: RuntimeStatus
    /** Installed versions, newest first. */
    versions: VersionView[]
    /** Older version to suggest when a model fails to load (current is the newest installed); null when none. */
    rollback: string | null
  }
  /** Cloudflare tunnel hosted by llama-web: state and the cloudflared in use. */
  tunnel: TunnelInfo
  /** Updates of llama-web itself; absent in tests that do not wire them. */
  appUpdate?: AppUpdateView
  /** The one-click tunnel setup run (non-secret view), so every open page follows it; null when there is none. */
  cloudflare: SetupJob | null
  /** Version of `cloudflare` (see JobRev): HTTP responses carry one too, the page keeps the newer. */
  cloudflareRev: JobRev | null
  /** Nothing configured yet and the setup wizard has not been dismissed. */
  firstRun: boolean
}

export type ActivityEvent =
  | { id: number, at: number, kind: 'state', modelId: string, profile: string, from: ModelState, to: ModelState, error: string | null }
  | { id: number, at: number, kind: 'drain-timeout', modelId: string, profile: string, inflight: number }
  | { id: number, at: number, kind: 'runtime', state: RuntimeStatus['state'], tag: string | null, code: string | null, note?: string | null, from?: string | null }
  | { id: number, at: number, kind: 'tunnel', state: 'connected' | 'error', code: string | null }

/** Activity event without the id / time the hub assigns. */
export type ActivityInput =
  | { kind: 'state', modelId: string, profile: string, from: ModelState, to: ModelState, error: string | null }
  | { kind: 'drain-timeout', modelId: string, profile: string, inflight: number }
  | { kind: 'runtime', state: RuntimeStatus['state'], tag: string | null, code: string | null, note?: string | null, from?: string | null }
  | { kind: 'tunnel', state: 'connected' | 'error', code: string | null }

/** Short reason key (the diagnosed kind when the output was recognised) or message; null when none. */
export function errorText(e: unknown): string | null {
  if (!e) return null
  const d = diagnose(e)
  if (d && d.kind !== 'unknown') return d.kind
  return String((e as { code?: string }).code ?? (e as Error).message ?? e)
}

const instKey = (modelId: string, profile: string) => JSON.stringify([modelId, profile])

/** One line of llama-server output, as shown live on the log page. */
export interface LogLine {
  id: number
  at: number
  modelId: string
  profile: string
  stream: LogStream
  text: string
}

/** Fast-changing numbers, pushed apart from the snapshot: generation speed and GPU memory. */
export interface MetricsDoc {
  speed: SpeedDoc
  gpu: GpuDoc
}

export type LiveMessage =
  | { type: 'snapshot', state: StateDoc }
  | { type: 'metrics', metrics: MetricsDoc }
  | { type: 'activity', event: ActivityEvent }
  | { type: 'request', record: RequestRecord }
  | { type: 'log', lines: LogLine[] }

export interface LiveHubOptions {
  snapshot(): Omit<StateDoc, 'now' | 'firstRun' | 'cloudflare' | 'cloudflareRev'> & { scheduler: SchedulerSnapshot, firstRun?: boolean, cloudflare?: SetupJob | null, cloudflareRev?: JobRev | null }
  /** How many recent activity events to keep. */
  historySize?: number
  now?: () => number
  /** Snapshot pushes caused by bursts of changes are merged within this window. */
  coalesceMs?: number
  /** Called for every new activity event (persistence). Must not throw. */
  onActivity?(e: ActivityEvent): void
  /** Recent request records / model output lines kept for new connections. */
  requestHistorySize?: number
  logHistorySize?: number
  /** Output lines of a burst are pushed together within this window. */
  logBatchMs?: number
  /** Current speed / GPU numbers. Without it no `metrics` messages are sent. */
  metrics?(): MetricsDoc
  /** Metrics pushes are merged within this window. */
  metricsMs?: number
}

export class LiveHub {
  private readonly subs = new Set<(m: LiveMessage) => void>()
  private readonly since = new Map<string, number>()
  private readonly history: ActivityEvent[] = []
  private readonly requests: RequestRecord[] = []
  private readonly logs: LogLine[] = []
  private logBatch: LogLine[] = []
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private readonly progress = new Map<string, number>()
  private metricsTimer: ReturnType<typeof setTimeout> | null = null
  private lastMetrics = ''
  private seq = 0
  private logSeq = 0
  private lastKey = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly opts: LiveHubOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Feed a scheduler event: updates `since`, records activity and schedules a snapshot push. */
  onSchedulerEvent(e: SchedulerEvent): void {
    const { modelId, profile } = e.target
    if (e.type === 'state') {
      // Progress belongs to one load; it starts over with every new load and ends with it.
      this.progress.delete(instKey(modelId, profile))
      this.since.set(instKey(modelId, profile), this.now())
      this.record({ kind: 'state', modelId, profile, from: e.from, to: e.to, error: errorText(e.error) })
    } else {
      this.record({ kind: 'drain-timeout', modelId, profile, inflight: e.inflight })
    }
  }

  /** Estimated load progress of an instance (only kept while it is loading). */
  onLoadProgress(modelId: string, profile: string, percent: number): void {
    this.progress.set(instKey(modelId, profile), percent)
    this.notify()
  }

  progressOf(modelId: string, profile: string): number | null {
    return this.progress.get(instKey(modelId, profile)) ?? null
  }

  /** Speed or GPU numbers changed. Pushes are merged and identical documents are skipped. */
  notifyMetrics(): void {
    if (this.metricsTimer || !this.subs.size || !this.opts.metrics) return
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = null
      const metrics = this.metricsNow()
      if (!metrics) return
      const key = JSON.stringify(metrics)
      if (key === this.lastMetrics) return
      this.lastMetrics = key
      this.push({ type: 'metrics', metrics })
    }, this.opts.metricsMs ?? 250)
    this.metricsTimer.unref?.()
  }

  metricsNow(): MetricsDoc | null {
    return this.opts.metrics?.() ?? null
  }

  onRuntimeStatus(s: RuntimeStatus): void {
    // Progress updates of a running download are state, not history.
    const last = [...this.history].reverse().find(h => h.kind === 'runtime')
    if (s.state === 'working' && last?.kind === 'runtime' && last.state === 'working') return this.notify()
    this.record({
      kind: 'runtime', state: s.state,
      tag: 'tag' in s ? (s.tag ?? null) : s.state === 'error' ? (s.using ?? null) : null,
      code: s.state === 'error' ? s.code : null,
      note: s.state === 'ready' ? (s.note ?? null) : null,
      from: s.state === 'ready' ? (s.from ?? null) : null,
    })
  }

  /** The tunnel changed. Only reaching `connected` or failing is history; progress and connection counts are state. */
  onTunnelStatus(info: TunnelInfo): void {
    const s = info.status
    if (s.state !== 'connected' && s.state !== 'error') return this.notify()
    const code = s.state === 'error' ? s.code : null
    const last = [...this.history].reverse().find(h => h.kind === 'tunnel')
    if (last?.kind === 'tunnel' && last.state === s.state && last.code === code) return this.notify()
    this.record({ kind: 'tunnel', state: s.state, code })
  }

  /** A finished /v1 request (already stripped of conversation content). */
  onRequest(record: RequestRecord): void {
    this.requests.push(record)
    const max = this.opts.requestHistorySize ?? 100
    if (this.requests.length > max) this.requests.splice(0, this.requests.length - max)
    this.push({ type: 'request', record })
  }

  /** One line of model output. Lines of a burst are pushed as one message. */
  onLogLine(modelId: string, profile: string, stream: LogStream, text: string): void {
    const line: LogLine = { id: ++this.logSeq, at: this.now(), modelId, profile, stream, text }
    this.logs.push(line)
    const max = this.opts.logHistorySize ?? 500
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max)
    if (!this.subs.size) return
    this.logBatch.push(line)
    if (this.logTimer) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      const lines = this.logBatch
      this.logBatch = []
      if (lines.length) this.push({ type: 'log', lines })
    }, this.opts.logBatchMs ?? 100)
    this.logTimer.unref?.()
  }

  /** Something visible in the snapshot changed (config edit, queue, ...). */
  notify(): void {
    if (this.timer || !this.subs.size) return
    this.timer = setTimeout(() => {
      this.timer = null
      const state = this.snapshot()
      // Polls and bursts often change nothing visible; only push real differences.
      const key = JSON.stringify({ ...state, now: 0 })
      if (key === this.lastKey) return
      this.lastKey = key
      this.push({ type: 'snapshot', state })
    }, this.opts.coalesceMs ?? 30)
    this.timer.unref?.()
  }

  snapshot(): StateDoc {
    const { scheduler, models, queue, llamacpp, tunnel, cloudflare, cloudflareRev, firstRun, platform, appUpdate } = this.opts.snapshot()
    return {
      now: this.now(),
      models: models.map(m => ({
        ...m,
        instances: scheduler.models
          .filter(s => s.modelId === m.id && s.state !== 'stopped')
          .map(s => ({
            profile: s.profile, state: s.state, inflight: s.inflight, error: errorText(s.error), failure: diagnose(s.error),
            since: this.since.get(instKey(m.id, s.profile)) ?? null,
            progress: s.state === 'loading' ? (this.progress.get(instKey(m.id, s.profile)) ?? null) : null,
          })),
      })),
      queue, llamacpp, tunnel, cloudflare: cloudflare ?? null, cloudflareRev: cloudflareRev ?? null, firstRun: firstRun === true, platform,
      ...(appUpdate ? { appUpdate } : {}),
    }
  }

  recent(): ActivityEvent[] {
    return [...this.history]
  }

  recentRequests(): RequestRecord[] {
    return [...this.requests]
  }

  recentLogs(): LogLine[] {
    return [...this.logs]
  }

  subscribe(fn: (m: LiveMessage) => void): () => void {
    this.subs.add(fn)
    return () => { this.subs.delete(fn) }
  }

  get subscriberCount(): number {
    return this.subs.size
  }

  private record(input: ActivityInput): void {
    const event = { ...input, id: ++this.seq, at: this.now() } as ActivityEvent
    this.history.push(event)
    const max = this.opts.historySize ?? 50
    if (this.history.length > max) this.history.splice(0, this.history.length - max)
    try { this.opts.onActivity?.(event) } catch { /* persistence must not break the live feed */ }
    this.push({ type: 'activity', event })
    this.notify()
  }

  private push(m: LiveMessage): void {
    for (const fn of [...this.subs]) {
      try { fn(m) } catch { /* a broken subscriber must not affect the others */ }
    }
  }
}

const refText = (r: FileRef | null) => (r ? `${r.dirId}/${r.rel}` : null)

/**
 * Convert the context's models doc into the `models` part of the snapshot. With `dirs`, files
 * missing on disk are reported (a directory that is no longer configured counts as missing).
 */
export function describeModels(
  doc: ModelsDoc,
  check?: { dirs: ModelDir[], exists?: (path: string) => boolean },
): StateDoc['models'] {
  return doc.models.map(m => ({
    id: m.id, name: m.name, activeProfile: m.activeProfile,
    profiles: Object.keys(m.profiles), hasMmproj: !!m.mmproj,
    files: { model: refText(m.file)!, mmproj: refText(m.mmproj), draft: refText(m.draft) },
    missing: check ? missingFiles(m, check.dirs, check.exists) : [],
    instances: [],
  }))
}

export interface StreamOptions {
  hub: LiveHub
  /** Comment line interval that keeps idle connections and proxies alive. */
  heartbeatMs?: number
  /** Re-check the snapshot this often (in-flight counts and queue changes emit no event). */
  pollMs?: number
  /** Chunks the stream buffers for a reader before holding events back. */
  highWaterMark?: number
  /** Held-back activity / request events per connection; more and the connection is closed. */
  maxPendingActivity?: number
  /** Held-back output line batches per connection; beyond that the oldest are dropped (the log file has them). */
  maxPendingLogs?: number
}

/**
 * GET /api/stream: Server-Sent Events. Sends `snapshot` (full state) right away and after
 * every change, `activity` for each new event, and `history` once on connect. Closing the
 * connection (req.signal) unsubscribes.
 *
 * Also `metrics` (generation speed + GPU memory; only the latest is held for a slow reader),
 * `request` (finished /v1 request records) and `log` (batches of model output lines), with
 * `request-history` / `log-history` on connect.
 *
 * Bounded per connection: once the reader falls behind (the stream's queue is full), only the
 * latest snapshot is held back, activity / request events queue up to `maxPendingActivity` (beyond
 * that the connection is closed; EventSource reconnects and gets `history`), output line batches
 * queue up to `maxPendingLogs` (older ones are dropped), and heartbeats are skipped.
 */
export function handleStream(req: Request, opts: StreamOptions): Response {
  const enc = new TextEncoder()
  const { hub } = opts
  const maxPending = opts.maxPendingActivity ?? 200
  const maxPendingLogs = opts.maxPendingLogs ?? 200
  let cleanup = () => {}
  let flush = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsub = () => {}
      let hb: ReturnType<typeof setInterval> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      let heldSnapshot: string | null = null
      let heldMetrics: string | null = null
      const heldActivity: string[] = []
      const heldLogs: string[] = []
      const write = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(chunk)) } catch { cleanup() }
      }
      const room = () => (controller.desiredSize ?? 0) > 0
      const backedUp = () => !room() || heldSnapshot !== null || heldMetrics !== null || heldActivity.length > 0 || heldLogs.length > 0
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      // Called when the reader takes a chunk: held activity first (in order), then output lines,
      // then the latest snapshot.
      flush = () => {
        while (!closed && room() && heldActivity.length) write(heldActivity.shift()!)
        while (!closed && room() && !heldActivity.length && heldLogs.length) write(heldLogs.shift()!)
        if (!closed && room() && !heldActivity.length && !heldLogs.length && heldSnapshot !== null) {
          const chunk = heldSnapshot
          heldSnapshot = null
          write(chunk)
        }
        if (!closed && room() && !heldActivity.length && !heldLogs.length && heldSnapshot === null && heldMetrics !== null) {
          const chunk = heldMetrics
          heldMetrics = null
          write(chunk)
        }
      }
      const onMessage = (m: LiveMessage) => {
        if (closed) return
        if (m.type === 'snapshot') {
          const chunk = frame('snapshot', m.state)
          if (backedUp()) heldSnapshot = chunk // only the latest state matters
          else write(chunk)
        } else if (m.type === 'metrics') {
          const chunk = frame('metrics', m.metrics)
          if (backedUp()) heldMetrics = chunk // only the latest numbers matter
          else write(chunk)
        } else if (m.type === 'log') {
          const chunk = frame('log', m.lines)
          if (!backedUp()) return write(chunk)
          heldLogs.push(chunk)
          if (heldLogs.length > maxPendingLogs) heldLogs.splice(0, heldLogs.length - maxPendingLogs)
        } else {
          const chunk = m.type === 'request' ? frame('request', m.record) : frame('activity', m.event)
          if (!backedUp()) return write(chunk)
          heldActivity.push(chunk)
          if (heldActivity.length > maxPending) cleanup()
        }
      }
      cleanup = () => {
        if (closed) return
        closed = true
        unsub()
        clearInterval(hb)
        clearInterval(poll)
        heldSnapshot = null
        heldMetrics = null
        heldActivity.length = 0
        heldLogs.length = 0
        req.signal.removeEventListener('abort', cleanup)
        try { controller.close() } catch { /* already closed */ }
      }
      if (req.signal.aborted) return cleanup()
      req.signal.addEventListener('abort', cleanup, { once: true })
      write('retry: 2000\n\n')
      write(frame('history', hub.recent()))
      const recentRequests = hub.recentRequests()
      if (recentRequests.length) write(frame('request-history', recentRequests))
      const recentLogs = hub.recentLogs()
      if (recentLogs.length) write(frame('log-history', recentLogs))
      write(frame('snapshot', hub.snapshot()))
      const metrics = hub.metricsNow()
      if (metrics) write(frame('metrics', metrics))
      unsub = hub.subscribe(onMessage)
      hb = setInterval(() => { if (!backedUp()) write(': keep-alive\n\n') }, opts.heartbeatMs ?? 15_000)
      poll = setInterval(() => { hub.notify(); hub.notifyMetrics() }, opts.pollMs ?? 2000)
    },
    pull() { flush() },
    cancel() { cleanup() },
  }, new CountQueuingStrategy({ highWaterMark: opts.highWaterMark ?? 16 }))
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
