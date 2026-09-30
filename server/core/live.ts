// Live state for the UI: builds the state snapshot, keeps a short activity history and
// pushes changes to /api/stream subscribers. Pure module (no Nitro), testable with bun test.
import type { ModelsDoc } from './config'
import type { RuntimeStatus } from './llamacpp'
import type { ModelState, SchedulerEvent, SchedulerSnapshot } from './scheduler'

export interface StateInstance {
  profile: string
  state: ModelState
  inflight: number
  /** Error code or message; null when there is none. */
  error: string | null
  /** Epoch ms when the instance entered its current state. */
  since: number | null
}

export interface StateDoc {
  /** Server clock (epoch ms) at the time of the snapshot. */
  now: number
  models: Array<{
    id: string
    name: string
    activeProfile: string
    profiles: string[]
    hasMmproj: boolean
    instances: StateInstance[]
  }>
  queue: Array<{ modelId: string, profile: string, started: boolean, waiting: number }>
  llamacpp: { current: string, runtime: RuntimeStatus }
}

export type ActivityEvent =
  | { id: number, at: number, kind: 'state', modelId: string, profile: string, from: ModelState, to: ModelState, error: string | null }
  | { id: number, at: number, kind: 'drain-timeout', modelId: string, profile: string, inflight: number }
  | { id: number, at: number, kind: 'runtime', state: RuntimeStatus['state'], tag: string | null, code: string | null }

/** Activity event without the id / time the hub assigns. */
export type ActivityInput =
  | { kind: 'state', modelId: string, profile: string, from: ModelState, to: ModelState, error: string | null }
  | { kind: 'drain-timeout', modelId: string, profile: string, inflight: number }
  | { kind: 'runtime', state: RuntimeStatus['state'], tag: string | null, code: string | null }

export function errorText(e: unknown): string | null {
  if (!e) return null
  return String((e as { code?: string }).code ?? (e as Error).message ?? e)
}

const instKey = (modelId: string, profile: string) => JSON.stringify([modelId, profile])

export type LiveMessage =
  | { type: 'snapshot', state: StateDoc }
  | { type: 'activity', event: ActivityEvent }

export interface LiveHubOptions {
  snapshot(): Omit<StateDoc, 'now'> & { scheduler: SchedulerSnapshot }
  /** How many recent activity events to keep. */
  historySize?: number
  now?: () => number
  /** Snapshot pushes caused by bursts of changes are merged within this window. */
  coalesceMs?: number
}

export class LiveHub {
  private readonly subs = new Set<(m: LiveMessage) => void>()
  private readonly since = new Map<string, number>()
  private readonly history: ActivityEvent[] = []
  private seq = 0
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
      this.since.set(instKey(modelId, profile), this.now())
      this.record({ kind: 'state', modelId, profile, from: e.from, to: e.to, error: errorText(e.error) })
    } else {
      this.record({ kind: 'drain-timeout', modelId, profile, inflight: e.inflight })
    }
  }

  onRuntimeStatus(s: RuntimeStatus): void {
    // Progress updates of a running download are state, not history.
    const last = [...this.history].reverse().find(h => h.kind === 'runtime')
    if (s.state === 'working' && last?.kind === 'runtime' && last.state === 'working') return this.notify()
    this.record({
      kind: 'runtime', state: s.state,
      tag: 'tag' in s ? (s.tag ?? null) : null,
      code: s.state === 'error' ? s.code : null,
    })
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
    const { scheduler, models, queue, llamacpp } = this.opts.snapshot()
    return {
      now: this.now(),
      models: models.map(m => ({
        ...m,
        instances: scheduler.models
          .filter(s => s.modelId === m.id && s.state !== 'stopped')
          .map(s => ({
            profile: s.profile, state: s.state, inflight: s.inflight, error: errorText(s.error),
            since: this.since.get(instKey(m.id, s.profile)) ?? null,
          })),
      })),
      queue, llamacpp,
    }
  }

  recent(): ActivityEvent[] {
    return [...this.history]
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
    this.push({ type: 'activity', event })
    this.notify()
  }

  private push(m: LiveMessage): void {
    for (const fn of [...this.subs]) {
      try { fn(m) } catch { /* a broken subscriber must not affect the others */ }
    }
  }
}

/** Convert the context's models doc into the `models` part of the snapshot. */
export function describeModels(doc: ModelsDoc): StateDoc['models'] {
  return doc.models.map(m => ({
    id: m.id, name: m.name, activeProfile: m.activeProfile,
    profiles: Object.keys(m.profiles), hasMmproj: !!m.mmproj, instances: [],
  }))
}

export interface StreamOptions {
  hub: LiveHub
  /** Comment line interval that keeps idle connections and proxies alive. */
  heartbeatMs?: number
  /** Re-check the snapshot this often (in-flight counts and queue changes emit no event). */
  pollMs?: number
}

/**
 * GET /api/stream: Server-Sent Events. Sends `snapshot` (full state) right away and after
 * every change, `activity` for each new event, and `history` once on connect. Closing the
 * connection (req.signal) unsubscribes.
 */
export function handleStream(req: Request, opts: StreamOptions): Response {
  const enc = new TextEncoder()
  const { hub } = opts
  let cleanup = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsub = () => {}
      let hb: ReturnType<typeof setInterval> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      const send = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(chunk)) } catch { cleanup() }
      }
      const frame = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      cleanup = () => {
        if (closed) return
        closed = true
        unsub()
        clearInterval(hb)
        clearInterval(poll)
        req.signal.removeEventListener('abort', cleanup)
        try { controller.close() } catch { /* already closed */ }
      }
      if (req.signal.aborted) return cleanup()
      req.signal.addEventListener('abort', cleanup, { once: true })
      send('retry: 2000\n\n')
      frame('history', hub.recent())
      frame('snapshot', hub.snapshot())
      unsub = hub.subscribe(m => m.type === 'snapshot' ? frame('snapshot', m.state) : frame('activity', m.event))
      hb = setInterval(() => send(': keep-alive\n\n'), opts.heartbeatMs ?? 15_000)
    },
    cancel() { cleanup() },
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
