// Move one document to the trash (its chunks and vectors go, its text stays so it can be restored). A document without
// stored text is deleted for good: the answer says which happened ({ trashed }).
import { getContext } from '../../../../service/context'
import { docIdParam, kbError } from '../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    const { trashed } = await getContext().kb.removeDocument(getRouterParam(event, 'id') ?? '', docIdParam(getRouterParam(event, 'docId')), 'admin')
    return { ok: true, trashed }
  } catch (e) {
    kbError(e)
  }
})
