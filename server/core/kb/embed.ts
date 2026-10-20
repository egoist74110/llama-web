// Embedding client for the knowledge base (decision 65): texts go to the embedding engine (decision 64) through a lease,
// the answers come back L2-normalized so a dot product is the cosine similarity. The manager only sees `Embedder`, so
// tests plug in a fake.
import type { Lease } from '../scheduler'
import { KbError } from './errors'

export interface Embedder {
  /** Model name of the engine while it is enabled; null = no engine (keyword-only knowledge bases). */
  name(): string | null
  /** One request: one normalized vector per text, in order. Rejects with KbError('embed-failed' | 'engine-off'). */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

/** The embedder of a deployment without an engine. */
export const noEmbedder: Embedder = {
  name: () => null,
  embed: async () => { throw new KbError('engine-off') },
}

export function normalizeVector(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length)
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = Number(v[i])
    out[i] = x
    sum += x * x
  }
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i]! /= norm
  return out
}

export interface EngineEmbedderOptions {
  engine: { routeName(): string | null, acquire(signal?: AbortSignal): Promise<Lease> }
  /** Context size of the engine: an input is cut to this many characters (about one token per character is the worst case). */
  ctxSize(): number
  host(): string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function engineEmbedder(o: EngineEmbedderOptions): Embedder {
  const doFetch = o.fetch ?? fetch
  return {
    name: () => o.engine.routeName(),
    async embed(texts, signal) {
      const model = o.engine.routeName()
      if (!model) throw new KbError('engine-off')
      const max = Math.max(1, o.ctxSize())
      let lease: Lease
      try {
        lease = await o.engine.acquire(signal)
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e
        throw new KbError('embed-failed', (e as Error)?.message ?? String(e))
      }
      try {
        const signals = [lease.signal, AbortSignal.timeout(o.timeoutMs ?? 120_000)]
        if (signal) signals.push(signal)
        const res = await doFetch(`http://${o.host()}:${lease.port}/v1/embeddings`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts.map(t => (t.length > max ? t.slice(0, max) : t)) }),
          signal: AbortSignal.any(signals),
        })
        const json = await res.json().catch(() => null) as { data?: Array<{ index?: number, embedding?: unknown }>, error?: { message?: string } } | null
        if (!res.ok || !Array.isArray(json?.data)) throw new KbError('embed-failed', json?.error?.message ?? `HTTP ${res.status}`)
        const data = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        if (data.length !== texts.length || data.some(d => !Array.isArray(d.embedding) || !d.embedding.length)) throw new KbError('embed-failed', 'unexpected response')
        return data.map(d => normalizeVector(d.embedding as number[]))
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e
        if (e instanceof KbError) throw e
        throw new KbError('embed-failed', (e as Error)?.message ?? String(e))
      } finally {
        lease.release()
      }
    },
  }
}
