// A page of the stored text of a document: ?offset= (default 0), ?length= (default and max 20000 characters). nextOffset is null at the end.
import { getContext } from '../../../../../service/context'
import { docIdParam, intQuery, kbError } from '../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  try {
    return await getContext().kb.readSource(getRouterParam(event, 'id') ?? '', docIdParam(getRouterParam(event, 'docId')), {
      offset: intQuery(q.offset),
      length: intQuery(q.length),
    })
  } catch (e) {
    kbError(e)
  }
})
