// Move an entry to the trash: ?baseVersion=N (the version that was read).
import { getContext } from '../../../../../service/context'
import { entryIdParam, intQuery, kbError } from '../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    const baseVersion = intQuery(getQuery(event).baseVersion)
    await getContext().kb.deleteEntry(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId')), { baseVersion }, 'admin')
    return { ok: true }
  } catch (e) {
    kbError(e)
  }
})
