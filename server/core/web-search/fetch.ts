// The gateway's `fetch_url` tool (decision 67): read one web page as plain text. Private use by the user's choice: any
// http(s) address is allowed (no private-address block); time, size and text length are capped.
import { fmt, t } from '../i18n'
import { decodeEntities } from './backends'

export const DEFAULT_FETCH_CHARS = 8000
export const MAX_FETCH_CHARS = 30000
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export type FetchFailure = 'bad-url' | 'http' | 'type' | 'network'

export class PageFetchError extends Error {
  constructor(public readonly kind: FetchFailure, detail = '') {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'PageFetchError'
  }
}

export interface Page {
  url: string
  title: string
  text: string
  truncated: boolean
}

const BLOCKS = /<\/?(?:p|div|br|li|ul|ol|tr|table|section|article|header|footer|h[1-6]|pre|blockquote)\b[^>]*>/gi

/** Readable text of an HTML page: scripts, styles and page chrome dropped, block tags become line breaks. */
export function htmlToText(html: string): { title: string, text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(BLOCKS, '\n')
    .replace(/<[^>]*>/g, '')
  const text = decodeEntities(body)
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n')
  return { title, text }
}

/** Text for the model when a page could not be read: the kind and its detail, no advice. */
export function fetchFailureText(e: unknown): string {
  const kind = e instanceof PageFetchError ? e.kind : 'network'
  const detail = e instanceof PageFetchError ? e.message.slice(kind.length + 2) : ''
  return fmt(t.webPrompt.fetchFailed[kind] ?? t.webPrompt.fetchFailed.network!, { detail })
}

export function parseFetchArguments(raw: string): { url: string, maxChars: number } | null {
  let v: unknown
  try { v = JSON.parse(raw.trim() || '{}') } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.url !== 'string' || !o.url.trim()) return null
  const asked = typeof o.max_chars === 'number' ? o.max_chars : typeof o.max_chars === 'string' && /^\d+$/.test(o.max_chars) ? Number(o.max_chars) : DEFAULT_FETCH_CHARS
  const maxChars = Number.isFinite(asked) ? Math.max(500, Math.min(MAX_FETCH_CHARS, Math.floor(asked))) : DEFAULT_FETCH_CHARS
  return { url: o.url.trim(), maxChars }
}

export async function fetchPage(rawUrl: string, opts: { maxChars: number, signal: AbortSignal, fetchImpl?: typeof fetch }): Promise<Page> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new PageFetchError('bad-url') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageFetchError('bad-url')
  const own = new AbortController()
  const onAbort = () => own.abort(opts.signal.reason)
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => own.abort(new Error('timeout')), TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await (opts.fetchImpl ?? fetch)(url.toString(), { signal: own.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } })
    } catch (e) {
      if (opts.signal.aborted) throw opts.signal.reason ?? e
      throw new PageFetchError('network', e instanceof Error ? e.message : String(e))
    }
    if (!res.ok) throw new PageFetchError('http', String(res.status))
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = type.includes('html') || type === ''
    if (!isHtml && !type.startsWith('text/') && !type.includes('json') && !type.includes('xml')) throw new PageFetchError('type', type)
    const reader = res.body?.getReader()
    let raw = ''
    if (reader) {
      const dec = new TextDecoder()
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        raw += dec.decode(value, { stream: true })
        if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break }
      }
      raw += dec.decode()
    } else raw = await res.text()
    const { title, text } = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() }
    const truncated = text.length > opts.maxChars
    return { url: res.url || url.toString(), title, text: truncated ? text.slice(0, opts.maxChars) : text, truncated }
  } catch (e) {
    if (opts.signal.aborted) throw opts.signal.reason ?? e
    if (e instanceof PageFetchError) throw e
    throw new PageFetchError('network', e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
  }
}
