// Search one knowledge base: { query, topK? }.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'
import { KbError } from '../../../core/kb/errors'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    return await getContext().kb.search([getRouterParam(event, 'id') ?? ''], body.query, { topK: Number(body.topK) })
  } catch (e) {
    kbError(e)
  }
})
