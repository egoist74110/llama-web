// Delete something in the trash for good (an entry with its history).
import { getContext } from '../../../../../service/context'
import { docIdParam, kbError } from '../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    await getContext().kb.purge(getRouterParam(event, 'id') ?? '', docIdParam(getRouterParam(event, 'docId')), 'admin')
    return { ok: true }
  } catch (e) {
    kbError(e)
  }
})
