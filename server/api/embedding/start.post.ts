// Start (or restart, with { restart: true }) the embedding engine; answers at once, the page follows the live state.
import { getContext } from '../../service/context'
import { describeEmbedding, embeddingError } from '../../service/embedding-api'
import { EmbeddingError } from '../../core/embedding'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  const ctx = getContext()
  try {
    ctx.refresh()
    if (!ctx.getEmbedding().enabled) throw new EmbeddingError('disabled')
    const run = body?.restart === true ? ctx.embedding.restart() : ctx.embedding.start()
    run.catch(() => { /* shown in the state */ })
    return describeEmbedding({ scan: false })
  } catch (e) {
    embeddingError(e)
  }
})
