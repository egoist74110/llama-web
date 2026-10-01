// Estimates model load progress (0..99) from llama-server output. llama-server prints no
// percentage, and current builds print almost nothing while the weights load, so progress is a
// mix of: milestones (known log messages, matched without the `function:` prefix), the dot
// line older builds print while reading the weights, and -- the part that actually moves the
// bar on recent builds -- GPU memory growth against the size of the weight files (or, with no
// GPU numbers, a time curve).  Milestones always win when they are further along.
// Testable with bun test (the GPU sampler and file sizes are injected). Unknown output never moves progress backwards.

import { statSync } from 'node:fs'

/** Milestone patterns in the order llama-server usually prints them: [pattern, percent]. */
const MILESTONES: Array<[RegExp, number]> = [
  [/loading model/i, 3],
  [/loaded meta data with/i, 6],
  [/loading model tensors/i, 8],
  [/offloading .* layers|offloaded \d+\/\d+ layers/i, 10],
  [/constructing llama_context|n_ctx\s*=/i, 91],
  [/llama threadpool init/i, 92], // recent builds: weights are in, the context is being built
  [/llama_kv_cache|kv_cache: /i, 93],
  [/compute buffer size/i, 95],
  [/creating \w+ draft context/i, 94],
  [/initializing slots|warming up|load_model: initializing/i, 97],
  [/(?:main|llama_server): model loaded/i, 99],
]

/** Share of the bar covered by the weight-reading dots: [from, to]. */
const DOT_RANGE: [number, number] = [12, 90]

/** Time-curve fallback: about 63% of the weight range after this long. */
const TIME_CONSTANT_MS = 15_000

export class LoadProgress {
  private pct = 0

  get value(): number {
    return this.pct
  }

  /** A complete output line. Returns the new percent, or null when nothing changed. */
  line(text: string): number | null {
    if (/^\.{3,}$/.test(text.trim())) return this.partial(text.trim())
    // A line can match several ("loading model tensors" also says "loading model"): the furthest wins.
    let best = 0
    for (const [re, p] of MILESTONES) if (p > best && re.test(text)) best = p
    return best ? this.raise(best) : null
  }

  /** The unfinished tail of the output (the dot line grows without a newline). */
  partial(text: string): number | null {
    const t = text.trim()
    if (!/^\.{3,}$/.test(t)) return null
    const [from, to] = DOT_RANGE
    return this.raise(from + Math.min(100, t.length) / 100 * (to - from))
  }

  /**
   * Weight loading by GPU memory: `growthMiB` is how much GPU memory went up since the load
   * started, `expectedMiB` the size of the weight files. Without GPU numbers (`growthMiB` null)
   * a time curve is used instead. Stays below the context milestones (max 90).
   */
  estimate(elapsedMs: number, growthMiB: number | null, expectedMiB: number): number | null {
    const [from, to] = DOT_RANGE
    const frac = growthMiB !== null && expectedMiB > 0
      ? Math.min(1, Math.max(0, growthMiB) / expectedMiB)
      : 1 - Math.exp(-Math.max(0, elapsedMs) / TIME_CONSTANT_MS)
    return this.raise(from + frac * (to - from))
  }

  private raise(p: number): number | null {
    const next = Math.min(99, Math.round(p))
    if (next <= this.pct) return null
    this.pct = next
    return next
  }
}

export interface TrackOptions {
  files: string[]
  progress: LoadProgress
  report(percent: number | null): void
  /** Total GPU memory in use (MiB); null when unknown. Called once for the baseline, then per tick. */
  usedMiB(): Promise<number | null>
  sizeOf?(file: string): number
  intervalMs?: number
}

/**
 * While a model loads, move its progress by GPU memory growth against the weight files' size
 * (time curve when GPU numbers are missing). At most one sample is in flight. Returns `stop`,
 * which also discards the result of a sample still running.
 */
export function trackWeightLoad(o: TrackOptions): () => void {
  const sizeOf = o.sizeOf ?? ((f: string) => statSync(f).size)
  let expectedMiB = 0
  for (const f of o.files) { try { expectedMiB += sizeOf(f) / 1048576 } catch { /* gone: time curve */ } }
  const startedAt = Date.now()
  let stopped = false
  let busy = false
  let base: number | null | undefined
  const baseline = o.usedMiB().catch(() => null)
  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      if (base === undefined) base = await baseline
      const used = base === null ? null : await o.usedMiB()
      if (stopped) return
      o.report(o.progress.estimate(Date.now() - startedAt, used === null || base === null ? null : used - base, expectedMiB))
    } catch { /* a failed sample just skips this tick */ } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), o.intervalMs ?? 1000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
