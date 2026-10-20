// Save the embedding engine configuration: { enabled?, name?, file?, device?, autoStart?, ctxSize? }. Switching it off
// stops a running engine; a change of file / device / context restarts a running one.
import { applyEmbeddingEdit, launchKey } from '../../core/embedding'
import { getContext } from '../../service/context'
import { describeEmbedding, embeddingError } from '../../service/embedding-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    ctx.refresh()
    const before = launchKey(ctx.getEmbedding())
    const localNames = ctx.getModels().models.map(m => m.name)
    const saved = ctx.updateEmbedding((draft) => { applyEmbeddingEdit(draft, body ?? {}, localNames) })
    if (!saved.enabled) await ctx.embedding.stop()
    else if (ctx.embedding.active && launchKey(saved) !== before) ctx.embedding.restart().catch(() => { /* shown in the state */ })
    return describeEmbedding({ scan: false })
  } catch (e) {
    embeddingError(e)
  }
})
