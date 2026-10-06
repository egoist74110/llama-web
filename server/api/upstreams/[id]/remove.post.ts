// Remove an upstream and its saved API key (the page asks for confirmation first).
import { removeUpstream } from '../../../core/upstreams'
import { getContext } from '../../../service/context'
import { describeUpstreams, upstreamsError } from '../../../service/upstreams-api'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  const ctx = getContext()
  try {
    ctx.refresh()
    ctx.updateUpstreams((draft) => { removeUpstream(draft, id) })
    ctx.updateSecrets((s) => { delete s.upstreamKeys[id!] })
    return describeUpstreams()
  } catch (e) {
    upstreamsError(e)
  }
})
