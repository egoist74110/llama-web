// Knowledge bases with their document / chunk counts, and whether each needs a re-index (decision 65).
import { getContext } from '../../service/context'
import { kbError } from '../../service/kb-api'

export default defineEventHandler(async () => {
  const ctx = getContext()
  try {
    return { bases: await ctx.kb.list(), embeddingModel: ctx.embedding.routeName(), jobs: ctx.kb.liveView().jobs }
  } catch (e) {
    kbError(e)
  }
})
