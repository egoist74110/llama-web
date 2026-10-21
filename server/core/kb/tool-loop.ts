// Pieces of the tool-mode loop (decision 65 ⑪) that need no network: SSE event splitting, reassembling streamed tool
// calls, merging token usage, building the follow-up messages. The loop itself (rounds, lease, abort) is in proxy.ts.
import { TOOL_NAME } from './inject'
import { cleanTags } from './tags'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export const noUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `a` + the numbers of a response's `usage` object (anything missing counts as 0). */
export function addUsage(a: Usage, usage: unknown): Usage {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>
  const prompt = num(u.prompt_tokens)
  const completion = num(u.completion_tokens)
  return {
    prompt_tokens: a.prompt_tokens + prompt,
    completion_tokens: a.completion_tokens + completion,
    total_tokens: a.total_tokens + (typeof u.total_tokens === 'number' ? num(u.total_tokens) : prompt + completion),
  }
}

export const hasUsage = (u: Usage) => u.prompt_tokens > 0 || u.completion_tokens > 0 || u.total_tokens > 0

/** `usage` of `obj` replaced by the sum of `prior` and its own numbers (other fields of usage are kept). */
export function withMergedUsage(obj: any, prior: Usage): void {
  if (!obj || typeof obj !== 'object' || !obj.usage || typeof obj.usage !== 'object') return
  Object.assign(obj.usage, addUsage(prior, obj.usage))
}

export interface ToolCall {
  id: string
  name: string
  /** The JSON text the model wrote (not parsed). */
  arguments: string
}

/** True when there is at least one call and every one is `search_knowledge`. */
export const allOurs = (calls: readonly ToolCall[]) => calls.length > 0 && calls.every(c => c.name === TOOL_NAME)

/** Tool calls of a non-streamed assistant message. */
export function callsOfMessage(message: any): ToolCall[] {
  const raw = message && Array.isArray(message.tool_calls) ? message.tool_calls : []
  return raw.map((c: any, i: number) => ({
    id: typeof c?.id === 'string' && c.id ? c.id : `call_kb_${i}`,
    name: typeof c?.function?.name === 'string' ? c.function.name : '',
    arguments: typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {}),
  }))
}

/**
 * The two kinds of message that continue the conversation after our tool calls: the assistant turn that made them and
 * one `tool` message per call. `assistant` is the turn as the model wrote it (content may be null).
 */
export function followUp(assistant: { content: string | null, extra?: Record<string, unknown> }, calls: readonly ToolCall[], results: readonly string[]): any[] {
  return [
    {
      role: 'assistant', ...assistant.extra, content: assistant.content,
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    },
    ...calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: results[i] ?? '' })),
  ]
}

/**
 * `{ query, top_k, tags }` out of the arguments text of a `search_knowledge` call; null when they are not usable.
 * `tags` is an array of strings or one string; anything else is ignored.
 */
export function parseSearchArguments(text: string): { query: string, topK?: number, tags?: string[] } | null {
  let v: unknown
  try { v = JSON.parse(text.trim() || '{}') } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.query !== 'string' || !o.query.trim()) return null
  const topK = typeof o.top_k === 'number' && Number.isFinite(o.top_k) ? o.top_k : typeof o.top_k === 'string' && /^\d+$/.test(o.top_k) ? Number(o.top_k) : undefined
  const tags = cleanTags(typeof o.tags === 'string' ? [o.tags] : o.tags)
  return { query: o.query.trim(), ...(topK === undefined ? {} : { topK }), ...(tags.length ? { tags } : {}) }
}

// ---------------------------------------------------------------------------------------
// SSE

/** Cuts a byte stream into SSE events (each returned with its terminating blank line). */
export class SseSplitter {
  private buf = ''
  private readonly dec = new TextDecoder()

  push(chunk: Uint8Array): string[] {
    this.buf += this.dec.decode(chunk, { stream: true })
    const out: string[] = []
    for (;;) {
      const lf = this.buf.indexOf('\n\n')
      const crlf = this.buf.indexOf('\r\n\r\n')
      let end = -1
      let len = 0
      if (lf >= 0 && (crlf < 0 || lf < crlf)) { end = lf; len = 2 } else if (crlf >= 0) { end = crlf; len = 4 }
      if (end < 0) break
      out.push(this.buf.slice(0, end + len))
      this.buf = this.buf.slice(end + len)
    }
    return out
  }

  /** What is left when the stream ends (an event without its blank line), '' if nothing. */
  flush(): string {
    const rest = this.buf + this.dec.decode()
    this.buf = ''
    return rest
  }
}

/** The `data:` payload of one event (several data lines joined by a newline); null when it has none (a comment). */
export function dataOf(event: string): string | null {
  const lines: string[] = []
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  return lines.length ? lines.join('\n') : null
}

interface Deferred {
  raw: string
  obj?: any
}

/**
 * One streamed round of the model. Events go through `push`, which returns what may be sent to the client at once;
 * tool-call events, the finish / usage events and `[DONE]` are held until the round ends, because only then it is known
 * whether the round is ours (then they are dropped) or the client's (then they are flushed as they came).
 */
export class StreamRound {
  private readonly pending = new Map<number, { id: string, name: string, args: string }>()
  private readonly held: Deferred[] = []
  private lastIndex = -1
  /** Text content of the assistant turn so far. */
  content = ''
  /** Reasoning text of the assistant turn so far (`reasoning_content`). */
  reasoning = ''
  /** `usage` of the round, when it sent one. */
  usage: unknown = null

  /** `later`: a round after the first one; its bare `role` delta is dropped (the client has seen one). */
  constructor(private readonly later = false) {}

  /** Text to send to the client now ('' = hold or drop). */
  push(raw: string): string {
    const data = dataOf(raw)
    if (data === null) return raw
    if (data.trim() === '[DONE]') {
      this.held.push({ raw })
      return ''
    }
    let obj: any
    try { obj = JSON.parse(data) } catch { return raw }
    const choice = obj?.choices?.[0]
    const delta = choice?.delta
    if (delta && Array.isArray(delta.tool_calls)) {
      this.assemble(delta.tool_calls)
      if (typeof delta.content === 'string') this.content += delta.content
      if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content
      this.held.push({ raw, obj })
      return ''
    }
    if (typeof delta?.content === 'string') this.content += delta.content
    if (typeof delta?.reasoning_content === 'string') this.reasoning += delta.reasoning_content
    const finished = choice?.finish_reason !== undefined && choice.finish_reason !== null
    if (obj?.usage && typeof obj.usage === 'object') this.usage = obj.usage
    if (finished || (obj?.usage && typeof obj.usage === 'object')) {
      this.held.push({ raw, obj })
      return ''
    }
    if (this.later && delta && typeof delta === 'object' && Object.keys(delta).every(k => k === 'role' || (k === 'content' && !delta.content))) return ''
    return raw
  }

  private assemble(list: any[]) {
    for (const tc of list) {
      if (!tc || typeof tc !== 'object') continue
      let index: number
      if (Number.isInteger(tc.index)) index = tc.index
      else if (typeof tc.id === 'string' && tc.id) index = this.lastIndex + 1
      else index = Math.max(this.lastIndex, 0)
      this.lastIndex = Math.max(this.lastIndex, index)
      const e = this.pending.get(index) ?? { id: '', name: '', args: '' }
      if (typeof tc.id === 'string' && tc.id) e.id = tc.id
      if (typeof tc.function?.name === 'string') e.name += tc.function.name
      if (typeof tc.function?.arguments === 'string') e.args += tc.function.arguments
      this.pending.set(index, e)
    }
  }

  /** The tool calls the round made, in index order. */
  calls(): ToolCall[] {
    return [...this.pending.entries()].sort((a, b) => a[0] - b[0]).map(([, e], i) => ({ id: e.id || `call_kb_${i}`, name: e.name, arguments: e.args }))
  }

  /** The held events as they came; `prior` = usage of the earlier rounds, added to this round's usage chunk. */
  flush(prior: Usage): string {
    return this.held.map((d) => {
      if (hasUsage(prior) && d.obj?.usage && typeof d.obj.usage === 'object') {
        withMergedUsage(d.obj, prior)
        return `data: ${JSON.stringify(d.obj)}\n\n`
      }
      return d.raw
    }).join('')
  }
}
