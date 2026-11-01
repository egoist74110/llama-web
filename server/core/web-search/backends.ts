// Search backends of the gateway's `web_search` tool (decision 67 ③). Two need no key (DuckDuckGo and Bing result pages,
// fetched and parsed here), two need one (Tavily, Brave). Each returns plain hits or throws a SearchError whose `kind`
// tells the manager what to remember about it.

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * auth = key / permission refused (stays unusable until the key changes); transient = timeout, rate limit, server error,
 * blocked page (tried again after a pause); empty = it answered without a usable result (nothing remembered).
 */
export type SearchErrorKind = 'auth' | 'transient' | 'empty'

export class SearchError extends Error {
  constructor(public readonly kind: SearchErrorKind, message: string) {
    super(message)
    this.name = 'SearchError'
  }
}

export type BackendId = 'duckduckgo' | 'bing' | 'tavily' | 'brave'
export const KEY_BACKENDS = ['tavily', 'brave'] as const
export type KeyBackendId = typeof KEY_BACKENDS[number]

/** Longest usage guide a user may save (characters). */
export const MAX_GUIDE = 8000

/**
 * What the gateway picks when the model names no backend. free-only (default): the keyless ones only, a paid backend is used
 * only when the model asks for it by name; free-first: keyless first, the keyed (paid) ones when those fail or find nothing;
 * keyed-first: the keyed ones first.
 */
export const SEARCH_ORDERS = ['free-only', 'free-first', 'keyed-first'] as const
export type SearchOrder = typeof SEARCH_ORDERS[number]

export interface SearchOptions {
  count: number
  signal: AbortSignal
  fetchImpl: typeof fetch
  key: string
}

export interface Backend {
  id: BackendId
  needsKey: boolean
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MAX_PAGE_BYTES = 2 * 1024 * 1024

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/** Only http(s) results are passed on. */
function cleanUrl(u: string): string | null {
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch { return null }
}

async function getText(opts: SearchOptions, url: string, init: RequestInit = {}): Promise<string> {
  let res: Response
  try {
    res = await opts.fetchImpl(url, { ...init, signal: opts.signal, redirect: 'follow' })
  } catch (e) {
    throw new SearchError('transient', e instanceof Error ? e.message : String(e))
  }
  if (res.status === 401 || res.status === 403) throw new SearchError('auth', `HTTP ${res.status}`)
  if (!res.ok) throw new SearchError('transient', `HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) return res.text()
  const dec = new TextDecoder()
  let out = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    out += dec.decode(value, { stream: true })
    if (size > MAX_PAGE_BYTES) { await reader.cancel().catch(() => {}); break }
  }
  return out + dec.decode()
}

// ---------------------------------------------------------------------------------------
// DuckDuckGo (html.duckduckgo.com, no key)

/** The result links of DuckDuckGo go through `//duckduckgo.com/l/?uddg=<url>`. */
export function ddgTarget(href: string): string | null {
  const h = decodeEntities(href)
  const full = h.startsWith('//') ? `https:${h}` : h
  try {
    const u = new URL(full)
    const real = u.searchParams.get('uddg')
    return cleanUrl(real ?? full)
  } catch { return null }
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const url = ddgTarget(m[1]!)
    const title = stripTags(m[2]!)
    if (!url || !title) continue
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(m[3]!)
    hits.push({ title, url, snippet: snip ? stripTags(snip[1]!) : '' })
  }
  return hits
}

const duckduckgo: Backend = {
  id: 'duckduckgo',
  needsKey: false,
  async search(query, opts) {
    const html = await getText(opts, 'https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.6' },
      body: new URLSearchParams({ q: query }).toString(),
    })
    const hits = parseDuckDuckGo(html)
    // A bot-check page has no results and no "no results" text: treat it as a pause, not as an empty answer.
    if (!hits.length && /anomaly|captcha|challenge/i.test(html)) throw new SearchError('transient', 'blocked')
    return hits.slice(0, opts.count)
  },
}

// ---------------------------------------------------------------------------------------
// Bing (www.bing.com result page, no key)

/** Some Bing results go through `bing.com/ck/a?...&u=a1<base64url>`. */
export function bingTarget(href: string): string | null {
  const h = decodeEntities(href)
  try {
    const u = new URL(h, 'https://www.bing.com')
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u')
      if (enc && enc.startsWith('a1')) {
        const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        return cleanUrl(Buffer.from(b64, 'base64').toString('utf8'))
      }
      return null
    }
    return cleanUrl(u.toString())
  } catch { return null }
}

export function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const blocks = html.split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1)
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = bingTarget(a[1]!)
    const title = stripTags(a[2]!)
    if (!url || !title) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({ title, url, snippet: p ? stripTags(p[1]!) : '' })
  }
  return hits
}

const bing: Backend = {
  id: 'bing',
  needsKey: false,
  async search(query, opts) {
    const html = await getText(opts, `https://www.bing.com/search?${new URLSearchParams({ q: query, count: String(Math.min(opts.count, 20)) })}`, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.6' },
    })
    return parseBing(html).slice(0, opts.count)
  },
}

// ---------------------------------------------------------------------------------------
// Tavily and Brave (key)

const tavily: Backend = {
  id: 'tavily',
  needsKey: true,
  async search(query, opts) {
    const text = await getText(opts, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({ query, max_results: opts.count }),
    })
    let obj: any
    try { obj = JSON.parse(text) } catch { throw new SearchError('transient', 'bad response') }
    const list: any[] = Array.isArray(obj?.results) ? obj.results : []
    return list.flatMap((r) => {
      const url = typeof r?.url === 'string' ? cleanUrl(r.url) : null
      const title = typeof r?.title === 'string' ? r.title.trim() : ''
      return url && title ? [{ title, url, snippet: typeof r.content === 'string' ? r.content.replace(/\s+/g, ' ').trim() : '' }] : []
    }).slice(0, opts.count)
  },
}

const brave: Backend = {
  id: 'brave',
  needsKey: true,
  async search(query, opts) {
    const text = await getText(opts, `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(Math.min(opts.count, 20)) })}`, {
      headers: { accept: 'application/json', 'x-subscription-token': opts.key },
    })
    let obj: any
    try { obj = JSON.parse(text) } catch { throw new SearchError('transient', 'bad response') }
    const list: any[] = Array.isArray(obj?.web?.results) ? obj.web.results : []
    return list.flatMap((r) => {
      const url = typeof r?.url === 'string' ? cleanUrl(r.url) : null
      const title = typeof r?.title === 'string' ? stripTags(r.title) : ''
      return url && title ? [{ title, url, snippet: typeof r.description === 'string' ? stripTags(r.description) : '' }] : []
    }).slice(0, opts.count)
  },
}

export const BACKENDS: Record<BackendId, Backend> = { duckduckgo, bing, tavily, brave }
