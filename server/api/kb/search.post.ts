// Search knowledge bases: { query, topK?, kbIds? } (kbIds omitted = all). Hybrid keyword + vector, keyword only when the
// embedding engine is off or its model differs from the one the knowledge base was built with.
import { getContext } from '../../service/context'
import { kbError } from '../../service/kb-api'
import { KbError } from '../../core/kb/errors'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    if (body.kbIds !== undefined && body.kbIds !== null && !Array.isArray(body.kbIds)) throw new KbError('bad-body')
    const kbIds: string[] | null = Array.isArray(body.kbIds) ? body.kbIds.map(String) : null
    return await getContext().kb.search(kbIds, body.query, { topK: Number(body.topK) })
  } catch (e) {
    kbError(e)
  }
})
