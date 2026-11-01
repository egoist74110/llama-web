// The tools the gateway adds to a chat request (decision 67 ①): `web_search` and `fetch_url`. Definitions, argument
// parsing and the text a model gets back. Pure functions; the labels come from the dictionary of the saved locale and
// are plain descriptions of the function, not instructions: how to use search is left to the user's own prompts.
import { fmt, t } from '../i18n'
import { BACKENDS, type BackendId, type SearchHit } from './backends'
import { DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS, type Page } from './fetch'
import { DEFAULT_COUNT, MAX_COUNT, type BackendOption } from './manager'

export const WEB_TOOL_NAME = 'web_search'
export const FETCH_TOOL_NAME = 'fetch_url'
export const GUIDE_TOOL_NAME = 'web_search_guide'
export const WEB_TOOL_NAMES = [WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME]
/** Tool rounds the gateway answers itself in a request with web tools (search, read, read again... needs more than 3). */
export const MAX_WEB_ROUNDS = 8
/** After the cap, how often a call of ours is still answered with the "limit reached" text before the turn is closed as text. */
export const MAX_LIMIT_ROUNDS = 2
/** Title / snippet limits: search results are untrusted text and must stay small. */
const MAX_TITLE = 200
const MAX_SNIPPET = 500

const nameOf = (tool: any): unknown => tool?.function?.name ?? tool?.name
const hasNamed = (json: any, name: string): boolean => Array.isArray(json?.tools) && json.tools.some((x: unknown) => nameOf(x) === name)

/** The client already defines its own `web_search`: ours stays out and the request is passed through. */
export const hasWebTool = (json: any): boolean => hasNamed(json, WEB_TOOL_NAME)

/** With `needsGuide` the description sends the model to the usage guide first (the only sentence we add to it). */
const withGuideHint = (text: string, needsGuide: boolean) => (needsGuide ? `${text}${t.webPrompt.useGuide}` : text)

/** `DuckDuckGo（免费）` / `Tavily（付费）`: the name the user sees in the settings and whether it spends quota. */
export function backendLabel(id: BackendId): string {
  const name = (t.webSearch.backend as Record<string, string>)[id] ?? id
  return `${name}（${BACKENDS[id].needsKey ? t.webPrompt.paid : t.webPrompt.free}）`
}

export const backendList = (backends: readonly BackendOption[]): string => backends.map(b => backendLabel(b.id)).join('、')

/**
 * The backends the model may name: a paid one only when the guide tool is offered too, because the gateway refuses a paid
 * search until the guide has been read and a model that cannot read it must not be offered one.
 */
export function offerableBackends(json: any, available: readonly BackendOption[]): BackendOption[] {
  return hasNamed(json, GUIDE_TOOL_NAME) ? available.filter(b => !b.paid) : [...available]
}

export interface WebToolOptions {
  needsGuide?: boolean
  /** The backends that can be named (see offerableBackends); none = no `backend` parameter. */
  backends?: readonly BackendOption[]
  /** The gateway may use a paid backend by itself when the model names none (order setting is not free-only). */
  autoPaid?: boolean
}

export function webToolDefinition(o: WebToolOptions = {}) {
  const backends = o.backends ?? []
  const available = backends.length ? ` ${fmt(t.webPrompt.availableLine, { list: backendList(backends), auto: o.autoPaid ? t.webPrompt.autoMixed : t.webPrompt.autoFree })}` : ''
  const properties: Record<string, unknown> = {
    query: { type: 'string', description: t.webPrompt.toolQuery },
    count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: fmt(t.webPrompt.toolCount, { max: MAX_COUNT }) },
  }
  if (backends.length) {
    properties.backend = { type: 'string', enum: backends.map(b => b.id), description: backends.some(b => b.paid) ? t.webPrompt.toolBackendPaid : t.webPrompt.toolBackend }
  }
  return {
    type: 'function',
    function: {
      name: WEB_TOOL_NAME,
      description: withGuideHint(`${t.webPrompt.toolDescription}${available}`, !!o.needsGuide),
      parameters: { type: 'object', properties, required: ['query'] },
    },
  }
}

export function fetchToolDefinition(needsGuide = false) {
  return {
    type: 'function',
    function: {
      name: FETCH_TOOL_NAME,
      description: withGuideHint(t.webPrompt.fetchDescription, needsGuide),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: t.webPrompt.fetchUrl },
          max_chars: { type: 'integer', minimum: 500, maximum: MAX_FETCH_CHARS, description: fmt(t.webPrompt.fetchMaxChars, { default: DEFAULT_FETCH_CHARS, max: MAX_FETCH_CHARS }) },
        },
        required: ['url'],
      },
    },
  }
}

export function guideToolDefinition() {
  return {
    type: 'function',
    function: { name: GUIDE_TOOL_NAME, description: t.webPrompt.guideDescription, parameters: { type: 'object', properties: {} } },
  }
}

/** The usage guide the model reads: the user's own text, or the built-in default of the saved language. */
export const guideText = (custom: string): string => custom.trim() || t.webPrompt.defaultGuide

/**
 * Add our tools (creating `tools` when absent); `fetch_url` and the guide stay out when the client has its own tool of that
 * name. `tool_choice` is left alone. Returns the names that were added.
 */
export function addWebTools(json: any, o: WebToolOptions = {}): string[] {
  const needsGuide = !!o.needsGuide
  if (!Array.isArray(json.tools)) json.tools = []
  json.tools.push(webToolDefinition(o))
  const added = [WEB_TOOL_NAME]
  if (!hasNamed(json, FETCH_TOOL_NAME)) {
    json.tools.push(fetchToolDefinition(needsGuide))
    added.push(FETCH_TOOL_NAME)
  }
  if (!hasNamed(json, GUIDE_TOOL_NAME)) {
    json.tools.push(guideToolDefinition())
    added.push(GUIDE_TOOL_NAME)
  }
  return added
}

/** Take our tools out again; `tools` goes away entirely when nothing else is left. */
export function removeWebTool(json: any): void {
  if (!Array.isArray(json.tools)) return
  json.tools = json.tools.filter((x: unknown) => !WEB_TOOL_NAMES.includes(nameOf(x) as string))
  if (json.tools.length === 0) delete json.tools
}

/** `{ query, count, backend }` out of the arguments text of a `web_search` call; null when they are not usable. */
export function parseWebArguments(text: string): { query: string, count: number, backend?: string } | null {
  let v: unknown
  try { v = JSON.parse(text.trim() || '{}') } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.query !== 'string' || !o.query.trim()) return null
  const raw = typeof o.count === 'number' ? o.count : typeof o.count === 'string' && /^\d+$/.test(o.count) ? Number(o.count) : DEFAULT_COUNT
  const count = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_COUNT, Math.floor(raw))) : DEFAULT_COUNT
  const backend = typeof o.backend === 'string' && o.backend.trim() ? o.backend.trim().toLowerCase() : undefined
  return { query: o.query.trim().slice(0, 400), count, ...(backend ? { backend } : {}) }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The results as one text: the backend that answered and whether it is paid (facts the model can report), then `[n] title / url / snippet`. */
export function formatWebResults(hits: readonly SearchHit[], backend: BackendId): string {
  const body = hits.map((h, i) => `[${i + 1}] ${clip(h.title, MAX_TITLE)}\n${h.url}${h.snippet ? `\n${clip(h.snippet, MAX_SNIPPET)}` : ''}`).join('\n\n')
  return `${fmt(t.webPrompt.backendLine, { backend: backendLabel(backend) })}\n\n${body}`
}

/** A fetched page as one text: title, final address, then the text (cut at the limit, marked with an ellipsis). */
export function formatPage(page: Page): string {
  return `${page.title ? `${page.title}\n` : ''}${page.url}\n\n${page.text}${page.truncated ? '\n…' : ''}`
}
