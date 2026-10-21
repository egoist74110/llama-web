// Search one knowledge base: { query, topK?, tags?, minSimilarity? }.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'
import { KbError } from '../../../core/kb/errors'
import { parseSearchFilters } from '../../../core/kb/search'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    return await getContext().kb.search([getRouterParam(event, 'id') ?? ''], body.query, { topK: Number(body.topK), ...parseSearchFilters(body) })
  } catch (e) {
    kbError(e)
  }
})
