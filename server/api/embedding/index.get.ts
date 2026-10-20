// Embedding engine (decision 64): saved configuration, state, and the embedding models found in the model directories.
import { describeEmbedding } from '../../service/embedding-api'

export default defineEventHandler(() => describeEmbedding())
