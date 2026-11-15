// Add an entry: { title, body, tags? }. Answers as soon as it is stored; embedding continues in the background.
import { getContext } from '../../../../service/context'
import { kbError } from '../../../../service/kb-api'
import { KbError } from '../../../../core/kb/errors'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object') throw new KbError('bad-body')
    return await getContext().kb.addEntry(getRouterParam(event, 'id') ?? '', body, 'admin')
  } catch (e) {
    kbError(e)
  }
})
