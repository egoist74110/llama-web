// Pure helpers of the chat page: incremental SSE parsing, reading llama-server's stream chunks,
// and a small Markdown renderer. The renderer escapes everything first, so model output can
// never inject HTML; only the constructs below turn into tags.

export interface ChatStats { tokens: number | null, perSec: number | null }
export interface ChatDelta { content: string, reasoning: string, done: boolean, stats: ChatStats | null, /** An error event of the stream (message, possibly empty). */ error?: string }

/** Split a growing SSE text into complete `data:` payloads and the unfinished rest. */
export function parseSse(buffer: string): { data: string[], rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  const data: string[] = []
  for (const block of parts) {
    const lines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
    if (lines.length) data.push(lines.join('\n'))
  }
  return { data, rest }
}

/** One stream payload -> what it adds. `[DONE]` and unreadable payloads add nothing. */
export function readDelta(payload: string): ChatDelta {
  const none: ChatDelta = { content: '', reasoning: '', done: false, stats: null }
  if (payload.trim() === '[DONE]') return { ...none, done: true }
  let j: any
  try { j = JSON.parse(payload) } catch { return none }
  // The proxy reports a failure after the stream has begun (load failed, no room) as a last event with an `error`.
  if (j?.error) return { ...none, error: typeof j.error?.message === 'string' && j.error.message ? j.error.message : typeof j.error === 'string' ? j.error : '' }
  const d = j?.choices?.[0]?.delta
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const timings = j?.timings
  const stats = timings ? { tokens: num(timings.predicted_n), perSec: num(timings.predicted_per_second) } : null
  return {
    content: typeof d?.content === 'string' ? d.content : '',
    reasoning: typeof d?.reasoning_content === 'string' ? d.reasoning_content : '',
    done: false,
    stats,
  }
}

/** The message of an OpenAI-style error body, or a fallback. */
export function errorMessage(body: string, fallback: string): string {
  try {
    const m = JSON.parse(body)?.error?.message
    if (typeof m === 'string' && m) return m
  } catch { /* not JSON */ }
  return fallback
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function inline(escaped: string): string {
  const codes: string[] = []
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? '')
}

/** Markdown subset: fenced code, headings, bullet / numbered lists, quotes, bold, italic, inline code, http(s) links. */
export function renderMarkdown(src: string): string {
  const out: string[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const isBlockStart = (l: string) => /^(```|#{1,6}\s|\s*([-*_])(\s*\2){2,}\s*$|\s*[-*+]\s|\s*\d+[.)]\s|>\s?)/.test(l)
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      i++ // closing fence (a stream may end before it)
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h${Math.min(h[1]!.length + 2, 6)}>${inline(esc(h[2]!))}</h${Math.min(h[1]!.length + 2, 6)}>`); i++; continue }
    const ul = /^\s*[-*+]\s+/.test(line)
    const ol = /^\s*\d+[.)]\s+/.test(line)
    if (ul || ol) {
      const re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/
      const items: string[] = []
      while (i < lines.length && re.test(lines[i]!)) items.push(`<li>${inline(esc(re.exec(lines[i]!)![1]!))}</li>`), i++
      out.push(`<${ul ? 'ul' : 'ol'}>${items.join('')}</${ul ? 'ul' : 'ol'}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote>${inline(esc(q.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!)
    if (!para.length) para.push(lines[i++]!)
    out.push(`<p>${inline(esc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`)
  }
  return out.join('')
}

// ---------------------------------------------------------------------------------------
// Conversation model, request building and streaming

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  /** Images as data URLs (user messages only). */
  images: string[]
  stats: ChatStats | null
  /** Shown instead of / after the text when the request failed or was cut off. */
  error: string | null
  at: number
}

export interface ChatSession {
  id: string
  title: string
  /** Last used `name:profile`. */
  model: string
  /** The user renamed it, so the first message no longer sets the title. */
  renamed: boolean
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

// Images are compressed by the server before they reach the model, so the limits only guard the browser store.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_SESSION_IMAGE_BYTES = 200 * 1024 * 1024

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Decoded size of a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const i = url.indexOf(',')
  const b64 = i < 0 ? '' : url.slice(i + 1)
  return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

export const sessionImageBytes = (s: Pick<ChatSession, 'messages'>) =>
  s.messages.reduce((n, m) => n + m.images.reduce((k, u) => k + dataUrlBytes(u), 0), 0)

/** Why an image of `bytes` cannot be added to a session already holding `used` bytes of images. */
export function imageLimit(bytes: number, used: number): 'single' | 'total' | null {
  if (bytes > MAX_IMAGE_BYTES) return 'single'
  if (used + bytes > MAX_SESSION_IMAGE_BYTES) return 'total'
  return null
}

/** Default title: the first line of the first message, shortened. */
export function titleFrom(text: string, fallback: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
}

export function newMessage(role: ChatMessage['role'], content = '', images: string[] = []): ChatMessage {
  return { id: newId(), role, content, reasoning: '', images, stats: null, error: null, at: Date.now() }
}

/** OpenAI `messages` of a conversation: failed or empty replies are left out, images become `image_url` parts. */
export function toRequestMessages(messages: ChatMessage[]): Array<{ role: string, content: unknown }> {
  const out: Array<{ role: string, content: unknown }> = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content })
      continue
    }
    out.push({
      role: 'user',
      content: m.images.length
        ? [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))]
        : m.content,
    })
  }
  return out
}

export interface StreamResult { stats: ChatStats | null }

/**
 * POST a streaming chat completion and report every delta. Throws an Error carrying the server's
 * message when the response is not OK; an abort rejects with the AbortError of `fetch` / the reader.
 */
export async function streamChat(
  doFetch: typeof fetch,
  body: { model: string, messages: unknown[] },
  signal: AbortSignal,
  onDelta: (d: ChatDelta) => void,
  failed: (status: number) => string,
): Promise<StreamResult> {
  const res = await doFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(errorMessage(await res.text().catch(() => ''), failed(res.status)))
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let stats: ChatStats | null = null
  const handle = (chunk: string) => {
    const { data, rest } = parseSse(buf + chunk)
    buf = rest
    for (const p of data) {
      const d = readDelta(p)
      // Text that arrived before stays with the caller; the failure is thrown so it is shown next to it.
      if (d.error !== undefined) {
        reader.cancel().catch(() => {})
        throw new Error(d.error || failed(res.status))
      }
      if (d.stats) stats = d.stats
      onDelta(d)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    handle(dec.decode(value, { stream: true }))
  }
  handle(`${dec.decode()}\n\n`)
  return { stats }
}
