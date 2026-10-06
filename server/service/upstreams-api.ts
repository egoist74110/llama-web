// Shared by the /api/upstreams routes: the list the page shows, the edit context and error mapping.
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { UpstreamError, viewUpstreams, type ConnectionView, type EditContext } from '../core/upstreams'
import { getContext } from './context'

export function describeUpstreams(): { upstreams: ConnectionView[], exclusiveHolder: string | null } {
  const ctx = getContext()
  const upstreams = viewUpstreams(ctx.getUpstreams(), ctx.getSecrets().upstreamKeys).map(u => ({
    ...u, up: ctx.health.isUp(u.id), checkedAt: ctx.health.state(u.id)?.checkedAt ?? null,
  }))
  return { upstreams, exclusiveHolder: ctx.health.holder() }
}

/** Local model names (a prefix must not shadow them) and the ports llama-web itself listens on (no forwarding loops; the public port only while the public entry is on, since 8080 is also where other engines like to live). */
export function editContext(): EditContext {
  const ctx = getContext()
  const s = ctx.getSettings()
  return { localNames: ctx.getModels().models.map(m => m.name), selfPorts: [s.server.port, ctx.bootPort, ...(s.public.enabled ? [s.public.port] : [])] }
}

/** An API key from a form: undefined = keep, '' = remove, otherwise the new one. */
export function cleanKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw.trim()) || raw.length > 2000) throw new UpstreamError('bad-key')
  return raw.trim()
}

/** Turn an upstream / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function upstreamsError(e: unknown): never {
  if (e instanceof UpstreamError) {
    const errors = t.upstreams.errors as Record<string, string>
    const status = e.code === 'not-found' ? 404 : e.code === 'name-taken' ? 409 : 400
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail: e.detail }) })
  }
  // upstreams.json / secrets.json is broken (hand edit): never overwrite it with the cached copy.
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.upstreams.errors['store'], { detail: e.message }) })
  throw e
}
