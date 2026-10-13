// Add an external upstream: { name, baseUrl, apiKey?, monitorUrl?, imageCompress?, local?, exclusive?, manualModels?, startCommand?, startCwd?, stopOnExit? }.
import { createUpstream, type Upstream } from '../../core/upstreams'
import { getContext } from '../../service/context'
import { cleanKey, describeUpstreams, editContext, saveUpstreamsAndKeys, upstreamsError } from '../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const key = cleanKey(body?.apiKey)
    ctx.refresh()
    let created: Upstream | null = null
    if (key) {
      saveUpstreamsAndKeys(
        (draft) => { created = createUpstream(draft, body ?? {}, editContext()) },
        (s) => { s.upstreamKeys[(created as Upstream).id] = key },
      )
    } else {
      ctx.updateUpstreams((draft) => { created = createUpstream(draft, body ?? {}, editContext()) })
    }
    const id = (created as Upstream | null)?.id ?? null
    ctx.health.tick().catch(() => {})
    return { ...describeUpstreams(), createdId: id }
  } catch (e) {
    upstreamsError(e)
  }
})
