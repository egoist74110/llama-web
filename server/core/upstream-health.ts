// Health of the external upstreams (decision 56 ⑨): `GET <baseUrl>/models` every few seconds. An upstream is "up"
// after one answer and "down" only after several failed probes in a row, so one slow answer does not unload anything.
// While a local, exclusive upstream is up, llama-web's own models are unloaded and none may load. Pure module: the
// probe, the clock and the timer are injected.
import type { Upstream } from './upstreams'

export interface HealthDeps {
  upstreams(): readonly Upstream[]
  /** True = the upstream answered (any HTTP status counts: something is listening); false / a throw = it did not. */
  probe(u: Upstream): Promise<boolean>
  /** Called when an upstream changes between up and down, and when the exclusive holder changes. */
  onChange(): void
  /** After every round (also when nothing changed): the place to unload models that came up in the meantime. */
  afterTick?(): void
  intervalMs?: number
  /** Failed probes in a row before an upstream counts as down (default 3). */
  downAfter?: number
}

export interface HealthState {
  up: boolean
  /** Failed probes since the last answer. */
  misses: number
  /** Epoch ms of the last finished probe; null = none yet. */
  checkedAt: number | null
}

export class UpstreamHealth {
  private readonly states = new Map<string, HealthState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastHolder: string | null = null

  constructor(private readonly deps: HealthDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 5000)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One round over every upstream. Rounds never overlap. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const list = [...this.deps.upstreams()]
      const alive = new Set(list.map(u => u.id))
      for (const id of [...this.states.keys()]) if (!alive.has(id)) this.states.delete(id)
      const results = await Promise.all(list.map(async u => [u, await this.deps.probe(u).catch(() => false)] as const))
      let changed = false
      for (const [u, ok] of results) {
        // The upstream was removed while its probe ran.
        if (!this.deps.upstreams().some(x => x.id === u.id)) continue
        const prev = this.states.get(u.id) ?? { up: false, misses: 0, checkedAt: null }
        const next: HealthState = ok
          ? { up: true, misses: 0, checkedAt: Date.now() }
          : { up: prev.up && prev.misses + 1 < (this.deps.downAfter ?? 3), misses: prev.misses + 1, checkedAt: Date.now() }
        if (next.up !== prev.up) changed = true
        this.states.set(u.id, next)
      }
      const holder = this.holder()
      if (holder !== this.lastHolder) { this.lastHolder = holder; changed = true }
      if (changed) this.deps.onChange()
      this.deps.afterTick?.()
    } finally {
      this.running = false
    }
  }

  state(id: string): HealthState | null {
    return this.states.get(id) ?? null
  }

  isUp(id: string): boolean {
    return this.states.get(id)?.up === true
  }

  /** Name of the first upstream that is up, runs on this machine and wants it to itself; null = nobody does. */
  holder(): string | null {
    for (const u of this.deps.upstreams()) {
      if (u.local && u.exclusive && this.isUp(u.id)) return u.name
    }
    return null
  }
}

/** Probe over HTTP: `GET <baseUrl>/models`, with the upstream's key when there is one. Any answer = up. */
export function httpProbe(getKey: (id: string) => string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000) {
  return async (u: Upstream): Promise<boolean> => {
    const key = getKey(u.id)
    try {
      await fetchImpl(`${u.baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      })
      return true
    } catch {
      return false
    }
  }
}
