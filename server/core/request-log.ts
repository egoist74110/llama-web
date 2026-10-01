// Request records (data/logs/requests): who asked, for which model, how long it took, how many
// tokens, what the image step did and a short parameter summary. Conversation content never
// goes in: parameters are picked from an allow-list of scalar sampling options, the
// Authorization header is never read, and message / prompt text is only counted.
import { networkInterfaces } from 'node:os'
import type { ImageReport } from './preprocess/image'

export type RequestSource = 'local' | 'lan' | 'public'

export interface RequestMeta {
  /** Client address as seen by the server socket (null / missing = unknown, treated as local). */
  ip?: string | null
  /** Name of the API key that authenticated the request (set by the public entry; makes the source `public`). */
  keyName?: string | null
}

export interface RequestRecord {
  id: number
  /** Epoch ms when the request arrived. */
  at: number
  source: RequestSource
  /** API key name for `public` requests. */
  keyName: string | null
  method: string
  path: string
  /** Model as configured (null when the request did not resolve to one). */
  modelId: string | null
  modelName: string | null
  profile: string | null
  stream: boolean
  /** HTTP status of the response (the upstream status when a stream had to relay an error). */
  status: number
  /** `ok`: finished normally; `error`: HTTP error or upstream failure; `aborted`: client left or model unloaded mid-way. */
  outcome: 'ok' | 'error' | 'aborted'
  /** Error code of an error response (`model_load_failed`, ...). */
  error: string | null
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
  images: ImageSummary | null
  /** Allow-listed request parameters (reasoning, sampling, limits), plus `messages` / `tools` counts. */
  params: Record<string, string | number | boolean>
}

export interface ImageSummary {
  count: number
  /** Total bytes before / after the image step (only images that were looked at). */
  beforeBytes: number
  afterBytes: number
  /** Images that were actually recompressed / resized. */
  compressed: number
  /** Largest edge before and after, over all images (px; 0 when unknown). */
  maxEdgeBefore: number
  maxEdgeAfter: number
}

// ---------------------------------------------------------------------------------------
// Source

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i

function ownAddresses(): Set<string> {
  const out = new Set<string>()
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) out.add(a.address.toLowerCase())
    }
  } catch { /* no interface info */ }
  return out
}

/** True for loopback addresses and for this machine's own LAN addresses. */
export function isLocalAddress(ip: string, own: () => Set<string> = ownAddresses): boolean {
  const a = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  if (LOOPBACK.test(a)) return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  return own().has(a) || own().has(v4)
}

export function sourceOf(meta: RequestMeta | undefined): { source: RequestSource, keyName: string | null } {
  if (meta?.keyName) return { source: 'public', keyName: meta.keyName }
  if (meta?.ip && !isLocalAddress(meta.ip)) return { source: 'lan', keyName: null }
  return { source: 'local', keyName: null }
}

// ---------------------------------------------------------------------------------------
// Parameters

/** Scalar request options worth showing. Nothing here can carry conversation text. */
const PARAM_KEYS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'typical_p', 'repeat_penalty', 'presence_penalty', 'frequency_penalty',
  'max_tokens', 'max_completion_tokens', 'n_predict', 'n', 'seed',
  'reasoning_effort', 'reasoning_format', 'reasoning', 'thinking', 'enable_thinking',
  'stream', 'parallel_tool_calls',
] as const

const SHORT_TEXT = /^[\w.:-]{1,32}$/

function scalar(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && SHORT_TEXT.test(v)) return v
  return undefined
}

/** Parameter summary of a parsed request body. */
export function summarizeParams(body: unknown): RequestRecord['params'] {
  const out: RequestRecord['params'] = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out
  const b = body as Record<string, unknown>
  for (const k of PARAM_KEYS) {
    const v = scalar(b[k])
    if (v !== undefined) out[k] = v
  }
  // `thinking: { type: 'enabled' }`, `reasoning: { effort: 'high' }`, `chat_template_kwargs: { enable_thinking: false }`.
  for (const k of ['thinking', 'reasoning', 'chat_template_kwargs'] as const) {
    const o = b[k]
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue
    for (const [kk, vv] of Object.entries(o as Record<string, unknown>)) {
      const v = typeof vv === 'string' ? (SHORT_TEXT.test(vv) ? vv : undefined) : scalar(vv)
      if (v !== undefined && /^[\w-]{1,32}$/.test(kk)) out[`${k}.${kk}`] = v
    }
  }
  if (Array.isArray(b.messages)) out.messages = b.messages.length
  if (Array.isArray(b.tools)) out.tools = b.tools.length
  return out
}

export function summarizeImages(reports: ImageReport[] | undefined): ImageSummary | null {
  if (!reports?.length) return null
  const s: ImageSummary = { count: reports.length, beforeBytes: 0, afterBytes: 0, compressed: 0, maxEdgeBefore: 0, maxEdgeAfter: 0 }
  for (const r of reports) {
    const before = r.before
    const after = r.after ?? r.before
    if (before) {
      s.beforeBytes += before.bytes
      s.maxEdgeBefore = Math.max(s.maxEdgeBefore, before.width, before.height)
    }
    if (after) {
      s.afterBytes += after.bytes
      s.maxEdgeAfter = Math.max(s.maxEdgeAfter, after.width, after.height)
    }
    if (r.action === 'compressed') s.compressed++
  }
  return s
}

// ---------------------------------------------------------------------------------------
// Token usage

/**
 * Keeps the last bytes of a response (non-stream JSON or an SSE stream) so the token usage can
 * be read at the end without decoding every chunk while it streams.
 */
export class UsageTap {
  private chunks: Uint8Array[] = []
  private held = 0

  constructor(private readonly keep = 16 * 1024) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.held += chunk.byteLength
    // Drop whole chunks that are no longer needed to cover `keep` bytes.
    while (this.chunks.length > 1 && this.held - this.chunks[0]!.byteLength >= this.keep) {
      this.held -= this.chunks.shift()!.byteLength
    }
  }

  result(): { promptTokens: number | null, completionTokens: number | null } {
    if (!this.chunks.length) return { promptTokens: null, completionTokens: null }
    const all = new Uint8Array(this.held)
    let off = 0
    for (const c of this.chunks) { all.set(c, off); off += c.byteLength }
    const text = new TextDecoder().decode(all.subarray(Math.max(0, all.byteLength - this.keep)))
    return { promptTokens: lastNumber(text, 'prompt_tokens'), completionTokens: lastNumber(text, 'completion_tokens') }
  }
}

function lastNumber(text: string, key: string): number | null {
  const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'g')
  let last: number | null = null
  for (let m = re.exec(text); m; m = re.exec(text)) last = Number(m[1])
  return last
}
