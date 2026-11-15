// Take an entry or a source out of the trash; it is indexed again in the background.
import { getContext } from '../../../../../service/context'
import { docIdParam, kbError } from '../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    await getContext().kb.restore(getRouterParam(event, 'id') ?? '', docIdParam(getRouterParam(event, 'docId')), 'admin')
    return { ok: true }
  } catch (e) {
    kbError(e)
  }
})
