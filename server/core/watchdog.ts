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
  unload(target: Target, cause: NoRoomDetail): Promise<boolean>
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
    const cands = this.deps.candidates()
    if (!cands.length) { this.calm(); return null }
    const readings = await this.deps.sample()
    if (!readings) return null // unknown is not danger; the load check treats it as "does not fit"
    const ratio = this.deps.dangerRatio ?? DANGER_FREE_RATIO
    const low = readings
      .filter(r => r.totalMiB > 0 && r.freeMiB / r.totalMiB < ratio)
      .sort((a, b) => a.freeMiB / a.totalMiB - b.freeMiB / b.totalMiB)
    if (!low.length) { this.calm(); return null }

    const pool = low[0]!
    const freePercent = (pool.freeMiB / pool.totalMiB) * 100
    // Every model draws on `system`; a card only matters to models that use it (or whose pools are not known).
    const eligible = cands.filter(c => c.inflight === 0 && (pool.id === 'system' || c.pools.length === 0 || c.pools.includes(pool.id)))
    const victim = this.stopped === 0
      ? [...eligible].sort((a, b) => b.loadSeq - a.loadSeq)[0]
      : [...eligible].sort((a, b) => a.useSeq - b.useSeq)[0]
    if (!victim) {
      if (!this.blockedTold) {
        this.blockedTold = true
        this.deps.onEvent({ kind: 'watchdog', modelId: null, profile: null, pool: pool.id, state: 'blocked', freePercent })
      }
      return null
    }
    const detail: NoRoomDetail = { reason: 'watchdog', estimateMiB: null, availableMiB: pool.freeMiB, pool: pool.id }
    const done = await this.deps.unload(victim.target, detail)
    if (!done) return null
    this.stopped++
    this.deps.onEvent({ kind: 'watchdog', modelId: victim.target.modelId, profile: victim.target.profile, pool: pool.id, state: 'stopped', freePercent })
    return victim.target
  }

  private calm() {
    this.stopped = 0
    this.blockedTold = false
  }
}
