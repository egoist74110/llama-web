// The history of an entry, newest first (an entry in the trash still has one).
import { getContext } from '../../../../../../service/context'
import { entryIdParam, kbError } from '../../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    return { versions: await getContext().kb.entryHistory(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId'))) }
  } catch (e) {
    kbError(e)
  }
})
