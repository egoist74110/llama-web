// Entries of a knowledge base (decision 69): ?tag= (entry-level tag), ?q= (substring of title or body), ?offset=, ?limit= (default 50, max 200).
import { getContext } from '../../../../service/context'
import { intQuery, kbError } from '../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  try {
    return await getContext().kb.listEntries(getRouterParam(event, 'id') ?? '', {
      tag: typeof q.tag === 'string' ? q.tag : undefined,
      query: typeof q.q === 'string' ? q.q : undefined,
      offset: intQuery(q.offset),
      limit: intQuery(q.limit),
    })
  } catch (e) {
    kbError(e)
  }
})
