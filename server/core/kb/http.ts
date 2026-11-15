// HTTP side of the external knowledge base API (decisions 65 ⑦ / 69 ⑦): REST under /v1/kb and the MCP endpoint /v1/mcp.
// Two thin adapters over external.ts. Pure of Nitro: `proxy.handleV1` calls `handle` before it creates a request record
// (knowledge calls are not in the request log; writes are in the knowledge base's own change log).
import { APP_VERSION } from '../app-info'
import { fmt, t } from '../i18n'
import { checkAdminRequest } from '../origin'
import { BodyTooLarge, readBodyLimited } from '../proxy'
import type { RequestMeta } from '../request-log'
import type { SecretsDoc } from '../keys'
import { kbAccessOf } from './access'
import { KbApiError, runOp, type ExternalDeps, type OpName } from './external'
import { handleMcpBody, parseErrorResponse } from './mcp'

/** Most a request body may be (an added source text is the big one). */
export const MAX_KB_BODY_BYTES = 64 * 1024 * 1024

export interface KbApiOptions {
  deps: ExternalDeps
  /** Read at every request: key permissions apply the moment they are saved. */
  secrets(): SecretsDoc
  maxBodyBytes?: number
  version?: string
}

export interface KbApiHandler {
  handle(req: Request, meta: RequestMeta | undefined): Promise<Response>
}

/** Whether `/v1/kb`, `/v1/kb/...` or `/v1/mcp` (the paths this API owns). */
export const isKbApiPath = (pathname: string): boolean => pathname === '/v1/mcp' || pathname === '/v1/kb' || pathname.startsWith('/v1/kb/')

function errorBody(status: number, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>): Response {
  const type = status === 404 ? 'not_found_error' : status < 500 ? 'invalid_request_error' : 'server_error'
  return Response.json({ error: { message, type, code, ...(extra ?? {}) } }, { status, headers })
}

const fromApiError = (e: KbApiError) => errorBody(e.status, e.code, e.message, e.extra)

function safeDecode(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** A path segment as a positive integer id; NaN (matches nothing) otherwise. */
const intSegment = (raw: string): number => (/^[0-9]{1,15}$/.test(raw) ? Number(raw) : NaN)

/** A query value as a number (undefined when absent or blank, NaN when not a number). */
function numQuery(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name)
  return v === null || v.trim() === '' ? undefined : Number(v)
}

interface Route {
  op: OpName
  /** Merged into the arguments after the body (path parameters win). */
  args: Record<string, unknown>
  /** Whether the request carries a JSON body. */
  body: boolean
  /** Query parameters copied into the arguments when the body did not carry them. */
  query?: (q: URLSearchParams) => Record<string, unknown>
  /** Success status. */
  status?: number
}

type Resolved = { route: Route } | { allow: string[] } | null

/** The route of (method, path segments after /v1/kb), the methods the path knows when the method is wrong, or null for an unknown path. */
function resolve(method: string, parts: string[]): Resolved {
  const table: Array<{ shape: (p: string[]) => boolean, routes: Record<string, (p: string[]) => Route> }> = [
    { shape: p => p.length === 0, routes: { GET: () => ({ op: 'list_knowledge_bases', args: {}, body: false }) } },
    { shape: p => p.length === 1 && p[0] === 'search', routes: { POST: () => ({ op: 'search_knowledge', args: {}, body: true }) } },
    { shape: p => p.length === 2 && p[1] === 'guide', routes: { GET: p => ({ op: 'kb_guide', args: { kb_id: p[0] }, body: false }) } },
    {
      shape: p => p.length === 2 && p[1] === 'entries',
      routes: {
        GET: p => ({
          op: 'list_entries', args: { kb_id: p[0] }, body: false,
          query: q => ({ tag: q.get('tag') ?? undefined, query: q.get('query') ?? undefined, offset: numQuery(q, 'offset'), limit: numQuery(q, 'limit') }),
        }),
        POST: p => ({ op: 'add_entry', args: { kb_id: p[0] }, body: true, status: 201 }),
      },
    },
    {
      shape: p => p.length === 3 && p[1] === 'entries',
      routes: {
        GET: p => ({ op: 'get_entry', args: { kb_id: p[0], entry_id: intSegment(p[2]!) }, body: false }),
        PATCH: p => ({ op: 'update_entry', args: { kb_id: p[0], entry_id: intSegment(p[2]!) }, body: true }),
        DELETE: p => ({
          op: 'delete_entry', args: { kb_id: p[0], entry_id: intSegment(p[2]!) }, body: true,
          query: q => ({ guide_rev: q.get('guide_rev') ?? undefined, base_version: numQuery(q, 'base_version') }),
        }),
      },
    },
    { shape: p => p.length === 4 && p[1] === 'entries' && p[3] === 'versions', routes: { GET: p => ({ op: 'get_entry_history', args: { kb_id: p[0], entry_id: intSegment(p[2]!) }, body: false }) } },
    {
      shape: p => p.length === 2 && p[1] === 'sources',
      routes: {
        GET: p => ({ op: 'list_sources', args: { kb_id: p[0] }, body: false }),
        POST: p => ({ op: 'add_source', args: { kb_id: p[0] }, body: true, status: 201 }),
      },
    },
    {
      shape: p => p.length === 3 && p[1] === 'sources',
      routes: { GET: p => ({ op: 'read_source', args: { kb_id: p[0], source_id: intSegment(p[2]!) }, body: false, query: q => ({ offset: numQuery(q, 'offset'), length: numQuery(q, 'length') }) }) },
    },
  ]
  for (const entry of table) {
    if (!entry.shape(parts)) continue
    const make = entry.routes[method]
    return make ? { route: make(parts) } : { allow: Object.keys(entry.routes) }
  }
  return null
}

export function createKbApi(opts: KbApiOptions): KbApiHandler {
  const limit = opts.maxBodyBytes ?? MAX_KB_BODY_BYTES
  const version = opts.version ?? APP_VERSION

  /** The request body as bytes (null = none), or the 413 answer when it is over the limit. */
  async function readBody(req: Request): Promise<Uint8Array | null | Response> {
    try {
      const raw = await readBodyLimited(req, limit)
      // The guard in `handle` goes by the headers; a body that arrived must be declared JSON as well.
      if (raw && raw.byteLength > 0 && (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
        return errorBody(415, 'json_required', t.kbApi.jsonRequired)
      }
      return raw
    } catch (e) {
      if (e instanceof BodyTooLarge) return errorBody(413, 'body_too_large', fmt(t.api.bodyTooLarge, { limit: Math.round(limit / 1024 / 1024) }))
      throw e
    }
  }

  async function rest(req: Request, url: URL, meta: RequestMeta | undefined): Promise<Response> {
    const rest = url.pathname.slice('/v1/kb'.length)
    const parts = rest.split('/').map(safeDecode)
    // `/v1/kb/` and `/v1/kb` are the same path.
    if (parts[0] === '') parts.shift()
    if (parts.length && parts[parts.length - 1] === '') parts.pop()
    const resolved = resolve(req.method.toUpperCase(), parts)
    if (!resolved) return errorBody(404, 'not_found', fmt(t.api.notFound, { path: url.pathname }))
    if ('allow' in resolved) return errorBody(405, 'method_not_allowed', fmt(t.kbApi.methodNotAllowed, { method: req.method }), undefined, { allow: resolved.allow.join(', ') })
    const route = resolved.route

    let args: Record<string, unknown> = {}
    if (route.body) {
      const raw = await readBody(req)
      if (raw instanceof Response) return raw
      if (raw && raw.byteLength > 0) {
        let json: unknown
        try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { return errorBody(400, 'invalid_json', t.api.badJson) }
        if (!json || typeof json !== 'object' || Array.isArray(json)) return errorBody(400, 'invalid_json', t.api.badJson)
        args = json as Record<string, unknown>
      }
    }
    if (route.query) {
      for (const [k, v] of Object.entries(route.query(url.searchParams))) if (v !== undefined && args[k] === undefined) args[k] = v
    }
    Object.assign(args, route.args)
    try {
      const result = await runOp(opts.deps, kbAccessOf(meta, opts.secrets()), route.op, args)
      return Response.json(result, { status: route.status ?? 200 })
    } catch (e) {
      if (e instanceof KbApiError) return fromApiError(e)
      throw e
    }
  }

  async function mcp(req: Request, meta: RequestMeta | undefined): Promise<Response> {
    if (req.method.toUpperCase() !== 'POST') return errorBody(405, 'method_not_allowed', fmt(t.kbApi.methodNotAllowed, { method: req.method }), undefined, { allow: 'POST' })
    const raw = await readBody(req)
    if (raw instanceof Response) return raw
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw ?? new Uint8Array())) } catch { return Response.json(parseErrorResponse(), { status: 400 }) }
    const r = await handleMcpBody(body, { deps: opts.deps, access: kbAccessOf(meta, opts.secrets()), version })
    return r.json === undefined ? new Response(null, { status: r.status }) : Response.json(r.json, { status: r.status })
  }

  return {
    async handle(req, meta) {
      const url = new URL(req.url)
      if (!isKbApiPath(url.pathname)) return errorBody(404, 'not_found', fmt(t.api.notFound, { path: url.pathname }))
      // The main port needs no key, so a page in the user's browser could otherwise write the knowledge base with a
      // cross-site form post (and MCP asks for Origin validation anyway).
      const rejection = checkAdminRequest(req)
      if (rejection === 'cross-origin') return errorBody(403, 'cross_origin', t.kbApi.crossOrigin)
      if (rejection === 'json-required') return errorBody(415, 'json_required', t.kbApi.jsonRequired)
      return url.pathname === '/v1/mcp' ? mcp(req, meta) : rest(req, url, meta)
    },
  }
}
