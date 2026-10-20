// Embed one short text through the engine (starting it when needed): dimensions, time and the first values.
import { getContext } from '../../service/context'
import { embeddingError } from '../../service/embedding-api'
import { EmbeddingError } from '../../core/embedding'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  const text = typeof body?.text === 'string' && body.text.trim() ? body.text.slice(0, 2000) : 'llama-web'
  const ctx = getContext()
  const cfg = ctx.getEmbedding()
  try {
    if (!cfg.enabled) throw new EmbeddingError('disabled')
    const lease = await ctx.embedding.acquire()
    const started = performance.now()
    try {
      const res = await fetch(`http://${ctx.runner.host}:${lease.port}/v1/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.name, input: text }),
        signal: AbortSignal.any([lease.signal, AbortSignal.timeout(60_000)]),
      })
      const json = await res.json().catch(() => null) as any
      const vec: unknown = json?.data?.[0]?.embedding
      if (!res.ok || !Array.isArray(vec)) throw new EmbeddingError('load-failed', json?.error?.message ?? `HTTP ${res.status}`)
      const norm = Math.sqrt((vec as number[]).reduce((n, x) => n + x * x, 0))
      return {
        dims: vec.length, ms: Math.round(performance.now() - started), tokens: json?.usage?.prompt_tokens ?? null,
        norm: Math.round(norm * 1000) / 1000, head: (vec as number[]).slice(0, 4).map(x => Math.round(x * 10000) / 10000),
        device: ctx.embedding.view().runningDevice,
      }
    } finally {
      lease.release()
    }
  } catch (e) {
    embeddingError(e)
  }
})
