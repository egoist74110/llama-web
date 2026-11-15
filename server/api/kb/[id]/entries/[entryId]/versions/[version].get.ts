// One version of an entry with its full text.
import { getContext } from '../../../../../../service/context'
import { entryIdParam, kbError } from '../../../../../../service/kb-api'
import { KbError } from '../../../../../../core/kb/errors'

export default defineEventHandler(async (event) => {
  try {
    const version = Number(getRouterParam(event, 'version'))
    if (!Number.isInteger(version)) throw new KbError('version-not-found')
    return await getContext().kb.entryVersion(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId')), version)
  } catch (e) {
    kbError(e)
  }
})
