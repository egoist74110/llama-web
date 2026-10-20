// Delete one document with its chunks, vectors and index rows.
import { getContext } from '../../../../service/context'
import { docIdParam, kbError } from '../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    await getContext().kb.removeDocument(getRouterParam(event, 'id') ?? '', docIdParam(getRouterParam(event, 'docId')))
    return { ok: true }
  } catch (e) {
    kbError(e)
  }
})
