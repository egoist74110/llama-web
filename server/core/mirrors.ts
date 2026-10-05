// Public GitHub mirrors for people who cannot reach github.com (decision 53). Never used on their
// own: a mirror is offered only after the user started an update (llama.cpp or llama-web itself)
// and the official site could not be reached, and the user picks it. Every mirror here takes the
// original URL as a path suffix (`<base><https://github.com/...>`). Downloads are still checked
// against a SHA-256; with a mirror that digest comes through the mirror as well, which the dialog
// says out loud. Pure module (no Nitro).
import type { FetchFn } from './llamacpp'

export interface Mirror {
  id: string
  /** Shown to the user. */
  host: string
  /** Prefix put in front of the original URL; ends with `/`. */
  base: string
}

/** Ordered by recommendation: the first two are what the dialog offers. */
export const MIRRORS: readonly Mirror[] = [
  { id: 'ghfast', host: 'ghfast.top', base: 'https://ghfast.top/' },
  { id: 'gh-proxy', host: 'gh-proxy.com', base: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', host: 'ghproxy.net', base: 'https://ghproxy.net/' },
]

/** Id of the user's own mirror (settings.mirror.custom); it is not part of MIRRORS. */
export const CUSTOM_MIRROR_ID = 'custom'

/**
 * The user's own mirror prefix, normalized (ends with `/`): '' when empty, null when not acceptable.
 * https only, a public-looking DNS name (no IP literal, no single-label / local names, so a typo or a
 * hostile value cannot point requests at this machine or the LAN), no credentials, query or fragment.
 */
export function normalizeCustomMirror(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return ''
  if (text.length > 200 || /[\u0000-\u0020\u007f]/.test(text)) return null
  let u: URL
  try { u = new URL(text) } catch { return null }
  const h = u.hostname
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) || /^[\d.]+$/.test(h)) return null
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|test|invalid)$/.test(h)) return null
  return u.pathname.endsWith('/') ? `https://${h}${u.pathname}` : `https://${h}${u.pathname}/`
}

export function customMirror(raw: unknown): Mirror | null {
  const base = normalizeCustomMirror(raw)
  return base ? { id: CUSTOM_MIRROR_ID, host: new URL(base).host, base } : null
}

/** `custom` is the saved settings.mirror.custom; the id `custom` resolves to it (the client never sends a URL). */
export const mirrorById = (id: unknown, custom: unknown = ''): Mirror | null =>
  id === CUSTOM_MIRROR_ID ? customMirror(custom) : MIRRORS.find(m => m.id === id) ?? null

/** The mirrors offered after a failed manual update: the recommended one first, then one alternative. */
export const offeredMirrors = (): Mirror[] => MIRRORS.slice(0, 2).map(m => ({ ...m }))

/** Only these hosts are ever sent through a mirror: nothing else may leave through a third party. */
const MIRRORED_HOSTS = new Set(['github.com', 'api.github.com'])

const MAX_REDIRECTS = 8
const redirectOk = (u: URL, mirror: Mirror) => u.protocol === 'https:' && !u.username && !u.password
  && (u.host === new URL(mirror.base).host || u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))

/**
 * `fetch` that sends GitHub URLs through `mirror`; any other URL is refused. Redirects are followed
 * here: mirrors answer with a path-absolute `Location: /https://github.com/...` that the runtime's own
 * redirect handling rejects, and a redirect may only lead to the mirror itself or to GitHub.
 */
export function mirrorFetch(mirror: Mirror, inner: FetchFn): FetchFn {
  return async (url, init) => {
    let u: URL
    try { u = new URL(url) } catch { throw new TypeError('Invalid URL') }
    if (u.protocol !== 'https:' || !MIRRORED_HOSTS.has(u.hostname) || u.username || u.password) {
      throw new TypeError(`Refusing to send ${u.hostname} through a mirror`)
    }
    let current = `${mirror.base}${u.href}`
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await inner(current, { ...init, redirect: 'manual' })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) return res
      await res.body?.cancel().catch(() => {})
      const next = new URL(location, current)
      if (!redirectOk(next, mirror)) throw new TypeError(`Refusing a redirect to ${next.hostname}`)
      current = next.href
    }
    throw new TypeError('Too many redirects')
  }
}

/** Failures a mirror could help with (the site is unreachable or limits us); other errors are not about the network path. */
export const mirrorHelps = (code: string): boolean => code === 'network' || code === 'rate-limited' || code === 'http'
