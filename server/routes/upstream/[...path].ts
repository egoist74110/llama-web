// /upstream/:model/* under nuxt dev. In the build, server/entry.ts handles it natively.
import { getContext } from '../../service/context'
import { toAbortableRequest } from '../../service/h3'

export default defineEventHandler(event => getContext().proxy.handleUpstream(toAbortableRequest(event)))
