// Cross-site guard for the management API (/api/*). The LAN interface needs no key by design
// (plan 关键决定 20), but that must not let an unrelated web page in the user's browser change
// the configuration: browsers attach Origin / Sec-Fetch-Site to such requests, so writes from
// another origin are refused, and write bodies must be JSON (a cross-site form cannot send
// that without a CORS preflight, which is never granted). Clients that send neither header
// (curl, scripts on the LAN) are allowed.

export type AdminRejection = 'cross-origin' | 'json-required'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface AdminRequestInfo {
  method: string
  /** Request headers (case-insensitive lookup). */
  headers: Headers
}

/** null = allowed. */
export function checkAdminRequest(req: AdminRequestInfo): AdminRejection | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null

  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-origin'

  const origin = req.headers.get('origin')
  if (origin) {
    const host = req.headers.get('host')
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host
    } catch { /* "null" or garbage */ }
    if (!host || !originHost || originHost.toLowerCase() !== host.toLowerCase()) return 'cross-origin'
  }

  const length = req.headers.get('content-length')
  const hasBody = req.headers.has('transfer-encoding') || (length !== null && length !== '0')
  if (hasBody) {
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') return 'json-required'
  }
  return null
}
