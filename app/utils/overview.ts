// Pure helpers for the overview dashboard and the sidebar "now serving" card (bun-testable).
import type { MetricsDoc, StateDoc, StateInstance } from '~~/server/core/live'

/** Keep public/LAN origins; replace a local browser's loopback host with the server LAN IP. */
export function apiAddress(origin: string, lanHost?: string | null): string {
  try {
    const url = new URL(origin)
    if (lanHost && (url.hostname === 'localhost' || url.hostname === 'localhost.' || url.hostname === '0.0.0.0'
      || /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]')) {
      url.hostname = lanHost
    }
    return `${url.origin}/v1`
  } catch { return '' }
}

/** Seconds of history the speed curve shows. */
export const TREND_SECONDS = 40

/** One instance with its model, as the dashboard picks them. */
export interface Serving {
  model: StateDoc['models'][number]
  inst: StateInstance
}

// Order in which an instance deserves the big card: serving > busy > broken.
const RANK: Record<string, number> = { ready: 0, draining: 1, loading: 2, unloading: 3, failed: 4, crashed: 5 }

/**
 * Every live instance (stopped ones are not in the snapshot), best first: the one that is
 * generating right now, then other ready ones, then loading / winding down, then failed.
 */
export function rankInstances(state: StateDoc | null, metrics: MetricsDoc | null): Serving[] {
  if (!state) return []
  const active = new Set((metrics?.speed.active ?? []).map(a => instanceKey(a.modelId, a.profile)))
  const all = state.models.flatMap(model => model.instances.map(inst => ({ model, inst })))
  const score = (s: Serving) => (RANK[s.inst.state] ?? 9) * 2 + (active.has(instanceKey(s.model.id, s.inst.profile)) ? 0 : 1)
  return all.sort((a, b) => score(a) - score(b))
}

export const instanceKey = (modelId: string, profile: string) => `${modelId}\u0000${profile}`

/** Live and last-request speeds of one instance. */
export interface InstanceSpeed {
  phase: 'generating' | 'prompt' | 'idle'
  /** Live generation estimate while generating (null while warming up), else the last request's. */
  generation: number | null
  /** Prompt processing speed of the last finished request. */
  prompt: number | null
  estimated: boolean
}

export function instanceSpeed(metrics: MetricsDoc | null, modelId: string, profile: string): InstanceSpeed {
  const m = metrics?.speed
  const last = m?.last.find(l => l.modelId === modelId && l.profile === profile) ?? null
  const live = (m?.active ?? []).filter(a => a.modelId === modelId && a.profile === profile)
  const gen = live.find(a => a.phase === 'generating')
  const prompt = last?.promptPerSec ?? null
  if (gen) return { phase: 'generating', generation: gen.tokensPerSec, prompt, estimated: true }
  if (live.length) return { phase: 'prompt', generation: last?.generationPerSec ?? null, prompt, estimated: last?.estimated ?? false }
  return { phase: 'idle', generation: last?.generationPerSec ?? null, prompt, estimated: last?.estimated ?? false }
}

/**
 * Generation speed history per instance, one sample per second (0 when not generating).
 * Returns a new map; instances that are gone are dropped, each series keeps `size` samples.
 */
export function pushTrend(
  trend: ReadonlyMap<string, number[]>,
  live: Array<{ key: string, value: number }>,
  size = TREND_SECONDS,
): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const { key, value } of live) {
    const prev = trend.get(key) ?? []
    out.set(key, [...prev, Number.isFinite(value) && value > 0 ? value : 0].slice(-size))
  }
  return out
}

/**
 * SVG polyline points for a series in a `width` x `height` box, right-aligned (newest sample
 * at the right edge, missing history is simply not drawn). Empty string for < 2 samples.
 */
export function sparkPoints(samples: number[], width = 320, height = 64, size = TREND_SECONDS): string {
  if (samples.length < 2) return ''
  const max = Math.max(...samples)
  const top = max > 0 ? max * 1.15 : 1
  const pad = 4
  const step = width / (size - 1)
  const offset = (size - samples.length) * step
  return samples.map((v, i) => {
    const x = offset + i * step
    const y = height - pad - (v / top) * (height - pad * 2)
    return `${round(x)},${round(y)}`
  }).join(' ')
}

const round = (n: number) => Math.round(n * 10) / 10

/** Area under a sparkline (closed polygon down to the bottom edge). */
export function sparkArea(points: string, height = 64): string {
  if (!points) return ''
  const first = points.split(' ')[0]!.split(',')[0]
  const last = points.split(' ').at(-1)!.split(',')[0]
  return `${first},${height} ${points} ${last},${height}`
}

// Quantisation names as they appear in GGUF file names (Q4_K_M, IQ3_XXS, Q8_0, BF16, MXFP4...).
const QUANT = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|MXFP4|TQ\d_\d)(?=[-_.]|$)/i

/** Quantisation read from a model file name; null when the name does not carry one. */
export function quantFromFile(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const base = name.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '')
  const m = QUANT.exec(base)
  return m ? m[1]!.toUpperCase() : null
}

/** `ctx` value of the launch preview -> a number when it is a plain positive integer. */
export function ctxNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}
