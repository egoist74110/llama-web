// Re-embed every chunk of a knowledge base with the current embedding engine. Runs in the background: follow the `kb` jobs of the live state.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'

export default defineEventHandler(async (event) => {
  const ctx = getContext()
  try {
    const id = getRouterParam(event, 'id') ?? ''
    await ctx.kb.reindex(id)
    return await ctx.kb.get(id)
  } catch (e) {
    kbError(e)
  }
})
