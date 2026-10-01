// Live generation speed. While a streaming response flows, the number of SSE events per second
// is an estimate of tokens per second (llama-server sends one event per token). When the request
// ends, the exact speeds from llama-server's own `timings` replace the estimate.
//
// Cost on the hot path: `countEvents` is one native byte search per chunk; no decoding, no JSON.
// Pure module (no Nitro), testable with bun test.

export interface SpeedTimings {
  promptPerSecond: number | null
  predictedPerSecond: number | null
}

export interface ActiveSpeed {
  requestId: number
  modelId: string
  profile: string
  /** `prompt`: waiting for the first token; `generating`: tokens are flowing. */
  phase: 'prompt' | 'generating'
  /** Estimated generation speed; null until two tokens have arrived. */
  tokensPerSec: number | null
  tokens: number
}

export interface LastSpeed {
  modelId: string
  profile: string
  at: number
  promptPerSec: number | null
  generationPerSec: number | null
  /** True when llama-server reported no timings and the number is the chunk estimate. */
  estimated: boolean
}

export interface SpeedDoc {
  active: ActiveSpeed[]
  /** Most recent finished request per model + profile. */
  last: LastSpeed[]
}

/**
 * Count SSE events in a chunk: occurrences of `data:` at a line start. `atLineStart` carries
 * over between chunks (events may be split anywhere); JSON cannot hold a raw newline, so
 * generated text can not fake an event.
 */
export function countEvents(chunk: Uint8Array, atLineStart: boolean): { events: number, atLineStart: boolean } {
  if (!chunk.byteLength) return { events: 0, atLineStart }
  const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let events = atLineStart && buf.subarray(0, 5).toString('latin1') === 'data:' ? 1 : 0
  for (let i = buf.indexOf('\ndata:'); i >= 0; i = buf.indexOf('\ndata:', i + 1)) events++
  return { events, atLineStart: buf[buf.byteLength - 1] === 0x0a }
}

interface Flow {
  requestId: number
  modelId: string
  profile: string
  startedAt: number
  firstTokenAt: number | null
  tokens: number
  atLineStart: boolean
  /** (time, cumulative tokens) samples inside the rate window. */
  samples: Array<[number, number]>
}

export interface SpeedMeterOptions {
  now?: () => number
  /** The rate looks at this much recent time. */
  windowMs?: number
  /** Called when the document changed. Must not throw; listeners throttle on their own. */
  onChange?(): void
}

export class SpeedMeter {
  private readonly flows = new Map<number, Flow>()
  private readonly last = new Map<string, LastSpeed>()
  private readonly now: () => number

  constructor(private readonly opts: SpeedMeterOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  begin(requestId: number, modelId: string, profile: string): void {
    this.flows.set(requestId, {
      requestId, modelId, profile, startedAt: this.now(), firstTokenAt: null, tokens: 0, atLineStart: true, samples: [],
    })
    this.changed()
  }

  /** A response chunk of a streaming request. */
  chunk(requestId: number, chunk: Uint8Array): void {
    const f = this.flows.get(requestId)
    if (!f) return
    const r = countEvents(chunk, f.atLineStart)
    f.atLineStart = r.atLineStart
    if (!r.events) return
    const t = this.now()
    f.firstTokenAt ??= t
    f.tokens += r.events
    f.samples.push([t, f.tokens])
    const cutoff = t - (this.opts.windowMs ?? 3000)
    while (f.samples.length > 2 && f.samples[1]![0] <= cutoff) f.samples.shift()
    this.changed()
  }

  /** The request ended; `timings` (when llama-server sent them) replace the estimate. */
  end(requestId: number, timings: SpeedTimings | null): void {
    const f = this.flows.get(requestId)
    if (!f) return
    this.flows.delete(requestId)
    const exact = hasTimings(timings)
    if (exact || f.tokens >= 2) {
      this.last.set(`${f.modelId}\0${f.profile}`, {
        modelId: f.modelId, profile: f.profile, at: this.now(),
        promptPerSec: exact ? timings.promptPerSecond : null,
        generationPerSec: exact ? timings.predictedPerSecond : this.overall(f),
        estimated: !exact,
      })
    }
    this.changed()
  }

  /** A request that was never tracked live (non-streaming) but came back with timings. */
  record(modelId: string, profile: string, timings: SpeedTimings | null): void {
    if (!hasTimings(timings)) return
    this.last.set(`${modelId}\0${profile}`, {
      modelId, profile, at: this.now(),
      promptPerSec: timings.promptPerSecond, generationPerSec: timings.predictedPerSecond, estimated: false,
    })
    this.changed()
  }

  snapshot(): SpeedDoc {
    return {
      active: [...this.flows.values()].map(f => ({
        requestId: f.requestId, modelId: f.modelId, profile: f.profile,
        phase: f.firstTokenAt === null ? 'prompt' : 'generating',
        tokensPerSec: this.rate(f), tokens: f.tokens,
      })),
      last: [...this.last.values()],
    }
  }

  /** Tokens per second over the recent window. */
  private rate(f: Flow): number | null {
    const first = f.samples[0]
    const lastSample = f.samples.at(-1)
    if (!first || !lastSample || lastSample[0] <= first[0]) return null
    const tokens = lastSample[1] - first[1]
    if (tokens <= 0) return null
    return round1(tokens / ((lastSample[0] - first[0]) / 1000))
  }

  /** Average over the whole generation (first token to last token). */
  private overall(f: Flow): number | null {
    const first = f.firstTokenAt
    const lastSample = f.samples.at(-1)
    if (first === null || !lastSample || lastSample[0] <= first || f.tokens < 2) return null
    return round1((f.tokens - 1) / ((lastSample[0] - first) / 1000))
  }

  private changed(): void {
    try { this.opts.onChange?.() } catch { /* listeners must not break forwarding */ }
  }
}

function hasTimings(t: SpeedTimings | null): t is SpeedTimings {
  return !!t && (t.promptPerSecond !== null || t.predictedPerSecond !== null)
}

const round1 =(n: number) => Math.round(n * 10) / 10
