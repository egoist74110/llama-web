// Entries and sources in the trash, newest first.
import { getContext } from '../../../../service/context'
import { kbError } from '../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    return { items: await getContext().kb.listTrash(getRouterParam(event, 'id') ?? '') }
  } catch (e) {
    kbError(e)
  }
})
