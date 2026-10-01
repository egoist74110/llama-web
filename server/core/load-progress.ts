// Estimates model load progress (0..99) from llama-server output. llama-server prints no
// percentage, so progress is a mix of milestones (known log messages, matched without the
// `function:` prefix) and the dot line the tensor loader prints while it reads the weights
// (one dot per percent, no newline until done).
// Pure module, testable with bun test. Unknown output never moves progress backwards.

/** Milestone patterns in the order llama-server usually prints them: [pattern, percent]. */
const MILESTONES: Array<[RegExp, number]> = [
  [/loading model/i, 3],
  [/loaded meta data with/i, 6],
  [/loading model tensors/i, 8],
  [/offloading .* layers|offloaded \d+\/\d+ layers/i, 10],
  [/constructing llama_context|n_ctx\s*=/i, 91],
  [/llama_kv_cache|kv_cache: /i, 93],
  [/compute buffer size/i, 95],
  [/initializing slots|warming up/i, 97],
  [/main: model loaded/i, 99],
]

/** Share of the bar covered by the weight-reading dots: [from, to]. */
const DOT_RANGE: [number, number] = [12, 90]

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

  private raise(p: number): number | null {
    const next = Math.min(99, Math.round(p))
    if (next <= this.pct) return null
    this.pct = next
    return next
  }
}
