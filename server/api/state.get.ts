// Snapshot of models, queue and llama.cpp (same document /api/stream pushes as `snapshot`).
import { getContext } from '../service/context'

export default defineEventHandler(() => getContext().live.snapshot())
