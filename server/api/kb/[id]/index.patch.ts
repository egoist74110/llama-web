// Change a knowledge base: { name?, description?, chunkSize?, chunkOverlap? }. Chunk settings apply to documents added afterwards.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    return await getContext().kb.update(getRouterParam(event, 'id') ?? '', body ?? {})
  } catch (e) {
    kbError(e)
  }
})
