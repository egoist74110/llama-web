// GET /api/stream under nuxt dev. In the build, server/entry.ts handles it natively so the
// client disconnect (req.signal) is visible.
import { handleStream } from '../core/live'
import { getContext } from '../service/context'
import { toAbortableRequest } from '../service/h3'

export default defineEventHandler(event => handleStream(toAbortableRequest(event), { hub: getContext().live }))
