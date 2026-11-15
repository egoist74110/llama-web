// One entry with its body and current version.
import { getContext } from '../../../../../service/context'
import { entryIdParam, kbError } from '../../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    return await getContext().kb.getEntry(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId')))
  } catch (e) {
    kbError(e)
  }
})
