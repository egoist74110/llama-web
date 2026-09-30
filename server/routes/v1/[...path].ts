// /v1/* under nuxt dev. In the build, server/entry.ts handles /v1 before Nitro sees it.
import { getContext } from '../../service/context'
import { toAbortableRequest } from '../../service/h3'

export default defineEventHandler(event => getContext().proxy.handleV1(toAbortableRequest(event)))
