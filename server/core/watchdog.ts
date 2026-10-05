// Run-time guard (decision 44): while models are loading or online, free memory is read every two seconds; when a
// pool falls below the danger line the newest model without running requests is stopped, and if the memory does not
// come back the least recently used idle ones follow, one per round. Only models this program started are ever stopped
// (the scheduler knows nothing else). A reading that fails stops nothing. Pure module: the reading, the models and the
// timer are injected.
import type { Candidate, NoRoomDetail, Target } from './scheduler'
import type { ActivityInput } from './live'

/** One memory pool as read right now. `system` = RAM; a card keeps its device id (`CUDA0`). */
export interface PoolReading {
  id: string
  totalMiB: number
  freeMiB: number
}

/** Free share of a pool below which models are stopped (decision 44: 5%). */
export const DANGER_FREE_RATIO = 0.05

export interface WatchdogDeps {
  /** Null = the memory could not be read. */
  sample(): Promise<PoolReading[] | null>
  candidates(): Candidate[]
  /** `idleOnly`: refuse (false) when the model has a request running at the moment of the call. */
  unload(target: Target, cause: NoRoomDetail, opts: { idleOnly: boolean }): Promise<boolean>
  /** Only watch while this is true (multi-load on). */
  enabled(): boolean
  onEvent(e: Extract<ActivityInput, { kind: 'watchdog' }>): void
  intervalMs?: number
  dangerRatio?: number
}

export class Watchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** Models stopped in the current stretch of danger; the first pick is the newest, later ones the least recently used. */
  private stopped = 0
  private blockedTold = false

  constructor(private readonly deps: WatchdogDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 2000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One round. Rounds never overlap; returns the model stopped, if any. */
  async tick(): Promise<Target | null> {
    if (this.running || !this.deps.enabled()) return null
    this.running = true
    try {
      return await this.round()
    } catch {
      return null
    } finally {
      this.running = false
    }
  }

  private async round(): Promise<Target | null> {
    if (!this.deps.candidates().length) { this.calm(); return null }
    const readings = await this.deps.sample()
    if (!readings) return null // unknown is not danger; the load check treats it as "does not fit"
    const ratio = this.deps.dangerRatio ?? DANGER_FREE_RATIO
    const low = readings
      .filter(r => r.totalMiB > 0 && r.freeMiB / r.totalMiB < ratio)
      .sort((a, b) => a.freeMiB / a.totalMiB - b.freeMiB / b.totalMiB)
    if (!low.length) { this.calm(); return null }

    // Requests may have started while the memory was being read: look at the models only now.
    const cands = this.deps.candidates()
    // The most endangered pool first, but a pool with nothing to stop must not shelter the others.
    for (const pool of low) {
      // Every model draws on `system`; a card only matters to models that use it (or whose pools are not known).
      const eligible = cands.filter(c => c.inflight === 0 && (pool.id === 'system' || c.pools.length === 0 || c.pools.includes(pool.id)))
      const victim = this.stopped === 0
        ? [...eligible].sort((a, b) => b.loadSeq - a.loadSeq)[0]
        : [...eligible].sort((a, b) => a.useSeq - b.useSeq)[0]
      if (!victim) continue
      const freePercent = (pool.freeMiB / pool.totalMiB) * 100
      const detail: NoRoomDetail = { reason: 'watchdog', estimateMiB: null, availableMiB: pool.freeMiB, pool: pool.id }
      const done = await this.deps.unload(victim.target, detail, { idleOnly: true })
      if (!done) return null // it took a request in the meantime; the next round looks again
      this.stopped++
      this.deps.onEvent({ kind: 'watchdog', modelId: victim.target.modelId, profile: victim.target.profile, pool: pool.id, state: 'stopped', freePercent })
      return victim.target
    }
    if (!this.blockedTold) {
      this.blockedTold = true
      const worst = low[0]!
      this.deps.onEvent({ kind: 'watchdog', modelId: null, profile: null, pool: worst.id, state: 'blocked', freePercent: (worst.freeMiB / worst.totalMiB) * 100 })
    }
    return null
  }

  private calm() {
    this.stopped = 0
    this.blockedTold = false
  }
}
