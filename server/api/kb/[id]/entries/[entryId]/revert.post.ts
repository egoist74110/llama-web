// Revert an entry to an older version: { baseVersion, toVersion }. It becomes a new version; the history is kept.
import { getContext } from '../../../../../service/context'
import { entryIdParam, kbError } from '../../../../../service/kb-api'
import { KbError } from '../../../../../core/kb/errors'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    return await getContext().kb.revertEntry(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId')), body, 'admin')
  } catch (e) {
    kbError(e)
  }
})
