// Edit an upstream: any of the add fields; `apiKey` absent = keep, '' = remove, text = replace.
import { updateUpstream, type UpstreamsDoc } from '../../../core/upstreams'
import { getContext } from '../../../service/context'
import { cleanKey, describeUpstreams, editContext, saveUpstreamsAndKeys, upstreamsError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const key = cleanKey(body?.apiKey)
    ctx.refresh()
    const change = (draft: UpstreamsDoc) => { updateUpstream(draft, id, body ?? {}, editContext()) }
    if (key !== undefined) saveUpstreamsAndKeys(change, (s) => { if (key) s.upstreamKeys[id!] = key; else delete s.upstreamKeys[id!] })
    else ctx.updateUpstreams(change)
    ctx.health.tick().catch(() => {})
    return describeUpstreams()
  } catch (e) {
    upstreamsError(e)
  }
})
