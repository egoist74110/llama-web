// Documents of a knowledge base, with their index status and the progress of the job working on them.
import { getContext } from '../../../../service/context'
import { kbError, kbMessage } from '../../../../service/kb-api'

export default defineEventHandler(async (event) => {
  try {
    const docs = await getContext().kb.listDocuments(getRouterParam(event, 'id') ?? '')
    return { docs: docs.map(d => ({ ...d, error: d.errorCode ? kbMessage(d.errorCode, d.errorDetail ?? '') : null })) }
  } catch (e) {
    kbError(e)
  }
})
