// Shared by the /api/cloudflare routes: the client built from the saved API token, the request
// body of a setup, and error mapping. Responses never contain the API token or the tunnel token.
import { CF_API, CfClient, CfError, maskApiToken, type SetupInput } from '../core/cloudflare'
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { tunnelIdOf } from '../core/tunnel'
import { getContext } from './context'

export function tokenView(): { hasToken: boolean, maskedToken: string | null } {
  const token = getContext().getSecrets().cloudflareToken
  return token ? { hasToken: true, maskedToken: maskApiToken(token) } : { hasToken: false, maskedToken: null }
}

/** Client for the saved token; 400 when none is saved. */
export function savedClient(): CfClient {
  const token = getContext().getSecrets().cloudflareToken
  if (!token) throw createError({ statusCode: 400, message: t.cloudflare.errors['no-token'] })
  return clientFor(token)
}

/** API base; LLAMA_WEB_CLOUDFLARE_API points it at a fake Cloudflare for local testing only. */
export const apiBase = () => process.env.LLAMA_WEB_CLOUDFLARE_API || CF_API

/** Client for a token the user just pasted. */
export const clientFor = (token: string) => new CfClient(token, fetch, apiBase())

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The setup the page asks for; the port is always the public entry port from settings. */
export function setupInput(body: any): SetupInput {
  const opt = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    zoneId: str(body?.zoneId), subdomain: str(body?.subdomain), tunnelName: str(body?.tunnelName),
    port: getContext().getSettings().public.port, tunnel: opt(body?.tunnel), dns: opt(body?.dns),
    currentTunnelId: tunnelIdOf(getContext().getSecrets().tunnelToken),
  }
}

const STATUS: Partial<Record<string, number>> = { 'network': 502, 'changed': 409, 'busy': 409, 'no-job': 404 }

/** Turn a Cloudflare / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function cloudflareError(e: unknown): never {
  if (e instanceof CfError) {
    throw createError({ statusCode: STATUS[e.code] ?? 400, message: describeCfError(e.code, e.detail), data: { code: e.code } })
  }
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.cloudflare.errors.store, { detail: e.message }) })
  throw e
}

export function describeCfError(code: string, detail: string): string {
  const errors = t.cloudflare.errors as Record<string, string>
  if (code === 'forbidden') {
    const perm = (t.cloudflare.permissions as Record<string, string>)[detail]
    return perm ? fmt(errors['forbidden-perm']!, { perm }) : errors.forbidden!
  }
  const text = errors[code] ?? code
  return fmt(text, { detail: detail ? `（${detail}）` : '' })
}
