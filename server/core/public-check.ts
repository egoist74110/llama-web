// Self-check of the public addresses (plan 阶段 4, 4-6): request each address's /v1/models
// from this machine without a key, through Cloudflare and the tunnel back to the public entry.
// The entry answers 401 to a request without a key, so 401 means the whole path works.
// Pure module (no Nitro); fetch is injected.
import { lookup as dnsLookup } from 'node:dns/promises'
import type { TunnelMode } from './config'
import type { FetchFn } from './llamacpp'

export type CheckCode =
  /** 401 from the public entry: reachable. */
  | 'ok'
  /** Cloudflare 530 / 1033: the tunnel the DNS record points to has no connector. */
  | 'tunnel-down'
  /** 502 / 503 / 504: the tunnel is up but cannot reach the entry port (ingress points elsewhere?). */
  | 'origin'
  /** 404: the tunnel has no ingress rule for this host name. */
  | 'no-route'
  /** Another status code. */
  | 'unexpected'
  | 'timeout'
  /** Name could not be resolved (no DNS record yet, or blocked). */
  | 'dns'
  /** Other network failure (refused, reset, TLS, blocked by this network). */
  | 'network'

export interface CheckResult {
  host: string
  code: CheckCode
  status: number | null
  /** Short non-secret detail (error code / status text). */
  detail: string
  ms: number
}

/**
 * Addresses to show and check. Own tunnel: the saved domain first, then what the tunnel routes
 * here. Quick tunnel (decision 31): only the *.trycloudflare.com address the running process
 * printed; the saved domain and the own tunnel's host names do not lead here then.
 */
export function publicAddresses(
  pub: { tunnelMode: TunnelMode, domain: string },
  tunnel: { hostnames: string[] | null | undefined, quickHost: string | null | undefined },
): string[] {
  const hosts = pub.tunnelMode === 'quick' ? [tunnel.quickHost ?? ''] : [pub.domain, ...(tunnel.hostnames ?? [])]
  return [...new Set(hosts.map(h => h.trim().toLowerCase()).filter(Boolean))]
}

function classify(status: number, body: string): CheckCode {
  if (status === 401) return 'ok'
  if (status === 530 || /error code:?\s*1033/i.test(body)) return 'tunnel-down'
  if (status === 502 || status === 503 || status === 504) return 'origin'
  if (status === 404) return 'no-route'
  return 'unexpected'
}

function networkCode(e: unknown): { code: CheckCode, detail: string } {
  const err = e as { name?: string, code?: string, message?: string, cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code ?? ''
  const text = `${code} ${err?.message ?? ''}`
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { code: 'timeout', detail: '' }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(text)) return { code: 'dns', detail: code }
  return { code: 'network', detail: (code || err?.message || '').slice(0, 120) }
}

export interface CheckOptions {
  fetch: FetchFn
  /** Name lookup used to tell "no such name" apart (Bun's fetch reports it as ConnectionRefused). */
  lookup?: (host: string) => Promise<unknown>
  timeoutMs?: number
  now?: () => number
}

/** Check one address. Never sends a key or any other credential. */
export async function checkAddress(host: string, opts: CheckOptions): Promise<CheckResult> {
  const now = opts.now ?? Date.now
  const started = now()
  // Own timer (not AbortSignal.timeout, which Bun does not count as pending work).
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), opts.timeoutMs ?? 10_000)
  try {
    const res = await opts.fetch(`https://${host}/v1/models`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'llama-web-check' },
      signal: ac.signal,
    })
    const body = res.status === 401 ? '' : (await res.text().catch(() => '')).slice(0, 4000)
    const code = classify(res.status, body)
    return { host, code, status: res.status, detail: code === 'ok' ? '' : `${res.status}`, ms: now() - started }
  } catch (e) {
    const failed = networkCode(ac.signal.aborted ? ac.signal.reason : e)
    if (failed.code === 'network') {
      try {
        await (opts.lookup ?? dnsLookup)(host)
      } catch {
        failed.code = 'dns'
      }
    }
    return { host, ...failed, status: null, ms: now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Check every address in parallel. */
export function checkAddresses(hosts: string[], opts: CheckOptions): Promise<CheckResult[]> {
  return Promise.all(hosts.map(h => checkAddress(h, opts)))
}
