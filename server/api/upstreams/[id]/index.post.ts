// Edit an upstream: any of the add fields; `apiKey` absent = keep, '' = remove, text = replace.
import { updateUpstream } from '../../../core/upstreams'
import { getContext } from '../../../service/context'
import { cleanKey, describeUpstreams, editContext, upstreamsError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const key = cleanKey(body?.apiKey)
    ctx.refresh()
    ctx.updateUpstreams((draft) => { updateUpstream(draft, id, body ?? {}, editContext()) })
    if (key !== undefined) ctx.updateSecrets((s) => { if (key) s.upstreamKeys[id!] = key; else delete s.upstreamKeys[id!] })
    ctx.health.tick().catch(() => {})
    return describeUpstreams()
  } catch (e) {
    upstreamsError(e)
  }
})
