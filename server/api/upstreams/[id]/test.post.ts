// Connection test: GET <baseUrl>/models with the saved key; the model ids it lists are saved with the upstream.
import { fmt, t } from '../../../core/i18n'
import { recordTest, UpstreamError } from '../../../core/upstreams'
import { testConnection } from '../../../core/upstream-test'
import { getContext } from '../../../service/context'
import { describeUpstreams, upstreamsError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const ctx = getContext()
  const u = ctx.getUpstreams().upstreams.find(x => x.id === id)
  if (!u) return upstreamsError(new UpstreamError('not-found'))
  const r = await testConnection(u, ctx.getSecrets().upstreamKeys[u.id] ?? '')
  const tt = t.upstreams.test
  if (!r.ok) {
    const message = r.code === 'unreachable' ? fmt(tt.unreachable, { detail: r.detail ?? '' }) : fmt(r.code === 'unauthorized' ? tt.unauthorized : tt.status, { status: String(r.status ?? '') })
    return { ...describeUpstreams(), test: { ok: false, code: r.code, message } }
  }
  try {
    ctx.updateUpstreams((draft) => { recordTest(draft, u.id, r.models) })
  } catch (e) {
    upstreamsError(e)
  }
  return { ...describeUpstreams(), test: { ok: true, code: 'ok', count: r.models.length, message: r.models.length ? fmt(tt.ok, { count: String(r.models.length) }) : tt.okEmpty } }
})
