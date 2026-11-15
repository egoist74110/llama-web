// Edit an entry: { baseVersion, title?, body?, tags? }. A stale baseVersion answers 409 with { code: 'version_conflict', current }.
import { getContext } from '../../../../../service/context'
import { entryIdParam, kbError } from '../../../../../service/kb-api'
import { KbError } from '../../../../../core/kb/errors'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    return await getContext().kb.updateEntry(getRouterParam(event, 'id') ?? '', entryIdParam(getRouterParam(event, 'entryId')), body, 'admin')
  } catch (e) {
    kbError(e)
  }
})
