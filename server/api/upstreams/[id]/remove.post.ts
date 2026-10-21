// Remove an upstream and its saved API key (the page asks for confirmation first).
import { removeUpstream } from '../../../core/upstreams'
import { getContext } from '../../../service/context'
import { describeUpstreams, saveUpstreamsAndKeys, upstreamsError } from '../../../service/upstreams-api'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  const ctx = getContext()
  try {
    ctx.refresh()
    saveUpstreamsAndKeys((draft) => { removeUpstream(draft, id) }, (s) => { delete s.upstreamKeys[id!] })
    ctx.launcher.forget(id!) // the service itself keeps running; llama-web just stops remembering it
    return describeUpstreams()
  } catch (e) {
    upstreamsError(e)
  }
})
