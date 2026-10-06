// Add an external upstream: { name, baseUrl, apiKey?, monitorUrl?, imageCompress?, local?, exclusive?, manualModels? }.
import { createUpstream, type Upstream } from '../../core/upstreams'
import { getContext } from '../../service/context'
import { cleanKey, describeUpstreams, editContext, upstreamsError } from '../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const key = cleanKey(body?.apiKey)
    ctx.refresh()
    let created: Upstream | null = null
    ctx.updateUpstreams((draft) => { created = createUpstream(draft, body ?? {}, editContext()) })
    const id = (created as Upstream | null)?.id ?? null
    if (key && id) ctx.updateSecrets((s) => { s.upstreamKeys[id] = key })
    ctx.health.tick().catch(() => {})
    return { ...describeUpstreams(), createdId: id }
  } catch (e) {
    upstreamsError(e)
  }
})
