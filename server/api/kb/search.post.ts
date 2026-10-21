// Search knowledge bases: { query, topK?, kbIds?, tags?, minSimilarity? } (kbIds omitted = all; tags = only chunks with any
// of them; minSimilarity 0..1 = vector similarity floor). Hybrid keyword + vector, keyword only when the
// embedding engine is off or its model differs from the one the knowledge base was built with.
import { getContext } from '../../service/context'
import { kbError } from '../../service/kb-api'
import { KbError } from '../../core/kb/errors'
import { parseSearchFilters } from '../../core/kb/search'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    if (body.kbIds !== undefined && body.kbIds !== null && !Array.isArray(body.kbIds)) throw new KbError('bad-body')
    const kbIds: string[] | null = Array.isArray(body.kbIds) ? body.kbIds.map(String) : null
    return await getContext().kb.search(kbIds, body.query, { topK: Number(body.topK), ...parseSearchFilters(body) })
  } catch (e) {
    kbError(e)
  }
})
