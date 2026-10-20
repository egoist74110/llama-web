// Delete a knowledge base with its documents and its database file.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    await getContext().kb.remove(getRouterParam(event, 'id') ?? '')
    return { ok: true }
  } catch (e) {
    kbError(e)
  }
})
