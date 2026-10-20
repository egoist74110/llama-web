// Create a knowledge base: { name, description?, chunkSize?, chunkOverlap? }.
import { getContext } from '../../service/context'
import { kbError } from '../../service/kb-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    return await getContext().kb.create(body ?? {})
  } catch (e) {
    kbError(e)
  }
})
