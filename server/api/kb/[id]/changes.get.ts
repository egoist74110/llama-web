// The change log, newest first: ?limit= (default 100, max 500), ?before= (a change id: only older ones).
import { getContext } from '../../../service/context'
import { intQuery, kbError } from '../../../service/kb-api'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  try {
    return { changes: await getContext().kb.changes(getRouterParam(event, 'id') ?? '', { limit: intQuery(q.limit), before: intQuery(q.before) }) }
  } catch (e) {
    kbError(e)
  }
})
