// Stop the embedding engine (it starts again on the next request while it is switched on).
import { getContext } from '../../service/context'
import { describeEmbedding } from '../../service/embedding-api'

export default defineEventHandler(async () => {
  await getContext().embedding.stop()
  return describeEmbedding({ scan: false })
})
