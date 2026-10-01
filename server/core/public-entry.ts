// Public entry (plan 关键决定 3 / 来源识别): a second listener, only on 127.0.0.1, meant for the
// Cloudflare tunnel. It serves nothing but /v1/* and only with a valid API key; everything else
// is 404. Authenticated requests go straight to the in-process /v1 handler with the key name as
// the request source, so no header a client sends can mark a request as public or local, and no
// path here can reach Nitro (pages, /api/*), /upstream/* or /api/stream.
import { t } from './i18n'
import type { AuthResult } from './keys'
import type { RequestMeta } from './request-log'

/** The public listener never binds anywhere else (AGENTS.md: :8080 只能绑定 127.0.0.1). */
export const PUBLIC_HOST = '127.0.0.1'

export interface PublicHandlerDeps {
  authenticate(header: string | null): AuthResult
  handleV1(req: Request, meta: RequestMeta): Promise<Response>
}

// Encoded dots, slashes and backslashes have no business in an OpenAI API path; refusing them
// keeps a path from meaning something else once llama-server decodes it.
const SUSPICIOUS_PATH = /%2e|%2f|%5c|\\/i

export function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function unauthorized(): Response {
  return Response.json(
    { error: { message: t.api.unauthorized, type: 'invalid_request_error', code: 'invalid_api_key' } },
    { status: 401, headers: { 'www-authenticate': 'Bearer' } },
  )
}

/** Whether a public request path may be served at all (before the key is looked at). */
export function isPublicPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') && !SUSPICIOUS_PATH.test(pathname)
}

/** One request on the public listener. `ip` is the socket address (the tunnel, normally loopback). */
export async function handlePublic(req: Request, deps: PublicHandlerDeps, ip?: string | null): Promise<Response> {
  let pathname: string
  try {
    pathname = new URL(req.url).pathname
  } catch {
    return notFound()
  }
  if (!isPublicPath(pathname)) return notFound()
  const auth = deps.authenticate(req.headers.get('authorization'))
  if (!auth.ok) return unauthorized()
  try {
    return await deps.handleV1(req, { ip: ip ?? null, keyName: auth.key.name })
  } catch {
    // Never let a runtime error page (stack, paths) reach the internet.
    return Response.json({ error: { message: t.api.internalError, type: 'server_error', code: 'internal_error' } }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------------------
// Listener lifecycle

export interface PublicServeOptions {
  hostname: string
  port: number
  fetch(req: Request, ip: string | null): Promise<Response> | Response
}

export interface PublicServer {
  stop(): void
}

/** Starts a listener (Bun.serve under the custom entry). Throws when the port cannot be bound. */
export type PublicServe = (opts: PublicServeOptions) => PublicServer

export type PublicStatus =
  | { state: 'off' }
  /** No listener implementation attached (nuxt dev runs on Node and has no public entry). */
  | { state: 'unavailable' }
  | { state: 'listening', host: string, port: number }
  | { state: 'error', port: number, detail: string }

export interface PublicConfig {
  enabled: boolean
  port: number
}

/**
 * Keeps the public listener in line with settings.public: `apply` is called at startup and after
 * every settings change, and only restarts the listener when `enabled` or `port` changed.
 */
export class PublicListener {
  private serve: PublicServe | null = null
  private server: PublicServer | null = null
  private current: PublicConfig | null = null
  private state: PublicStatus = { state: 'unavailable' }

  constructor(private readonly handler: (req: Request, ip: string | null) => Promise<Response>) {}

  /** Provide the listener implementation (the custom Bun entry does this). */
  attach(serve: PublicServe): void {
    this.serve = serve
    this.state = { state: 'off' }
  }

  status(): PublicStatus {
    return this.state
  }

  apply(cfg: PublicConfig): PublicStatus {
    if (!this.serve) return this.state
    const same = this.current && this.current.enabled === cfg.enabled && this.current.port === cfg.port
    // A failed bind is retried on the next apply (the port may have been freed).
    if (same && this.state.state !== 'error') return this.state
    this.stopServer()
    this.current = { enabled: cfg.enabled, port: cfg.port }
    if (!cfg.enabled) {
      this.state = { state: 'off' }
      return this.state
    }
    try {
      this.server = this.serve({ hostname: PUBLIC_HOST, port: cfg.port, fetch: this.handler })
      this.state = { state: 'listening', host: PUBLIC_HOST, port: cfg.port }
    } catch (e) {
      this.state = { state: 'error', port: cfg.port, detail: String((e as Error)?.message ?? e) }
    }
    return this.state
  }

  close(): void {
    this.stopServer()
    this.current = null
    if (this.serve) this.state = { state: 'off' }
  }

  private stopServer() {
    const s = this.server
    this.server = null
    if (!s) return
    try { s.stop() } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------------------
// Tunnel hints

/** `cloudflared tunnel route dns <tunnel> <domain>`, or null until both are set. */
export function routeDnsCommand(tunnelName: string, domain: string): string | null {
  if (!tunnelName || !domain) return null
  return `cloudflared tunnel route dns ${tunnelName} ${domain}`
}
