// Management side of the web search (decision 67): the switch and the keys of the keyed backends, as the settings page
// edits them. Keys never come back in a view, only whether one is saved.
import { BACKENDS, KEY_BACKENDS, MAX_GUIDE, SEARCH_ORDERS, type BackendId, type KeyBackendId, type SearchOrder } from './backends'
import type { BackendState } from './manager'

export type WebSearchErrorCode = 'bad-request' | 'bad-key' | 'bad-guide'

export class WebSearchAdminError extends Error {
  constructor(public readonly code: WebSearchErrorCode) {
    super(code)
    this.name = 'WebSearchAdminError'
  }
}

export interface WebSearchPatch {
  enabled?: boolean
  order?: SearchOrder
  /** The usage guide; '' = the built-in default. */
  guide?: string
  guideRequired?: boolean
  /** A key replaces the saved one; '' removes it. */
  keys?: Partial<Record<KeyBackendId, string>>
}

export interface WebSearchView {
  enabled: boolean
  order: SearchOrder
  /** The saved guide text ('' = default in use) and the default of the saved language, for the editor. */
  guide: string
  defaultGuide: string
  guideRequired: boolean
  backends: Array<{ id: BackendId, needsKey: boolean, hasKey: boolean, state: BackendState }>
}

const MAX_KEY = 300

/** Validate a request body; nothing is written when any part is wrong. */
export function parseWebSearchPatch(body: unknown): WebSearchPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebSearchAdminError('bad-request')
  const b = body as Record<string, unknown>
  const out: WebSearchPatch = {}
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new WebSearchAdminError('bad-request')
    out.enabled = b.enabled
  }
  if (b.order !== undefined) {
    if (typeof b.order !== 'string' || !(SEARCH_ORDERS as readonly string[]).includes(b.order)) throw new WebSearchAdminError('bad-request')
    out.order = b.order as SearchOrder
  }
  if (b.guide !== undefined) {
    if (typeof b.guide !== 'string') throw new WebSearchAdminError('bad-request')
    if (b.guide.length > MAX_GUIDE) throw new WebSearchAdminError('bad-guide')
    out.guide = b.guide
  }
  if (b.guideRequired !== undefined) {
    if (typeof b.guideRequired !== 'boolean') throw new WebSearchAdminError('bad-request')
    out.guideRequired = b.guideRequired
  }
  if (b.keys !== undefined) {
    if (!b.keys || typeof b.keys !== 'object' || Array.isArray(b.keys)) throw new WebSearchAdminError('bad-request')
    const keys: Partial<Record<KeyBackendId, string>> = {}
    for (const [id, v] of Object.entries(b.keys)) {
      if (!(KEY_BACKENDS as readonly string[]).includes(id)) throw new WebSearchAdminError('bad-request')
      if (typeof v !== 'string') throw new WebSearchAdminError('bad-key')
      const key = v.trim()
      // eslint-disable-next-line no-control-regex
      if (key.length > MAX_KEY || /[\s\u0000-\u001f\u007f]/.test(key)) throw new WebSearchAdminError('bad-key')
      keys[id as KeyBackendId] = key
    }
    out.keys = keys
  }
  return out
}

/** Write the keys of a validated patch into the secrets draft. */
export function applyKeys(secrets: { searchKeys: Record<string, string> }, keys: WebSearchPatch['keys']): void {
  for (const [id, key] of Object.entries(keys ?? {})) {
    if (key) secrets.searchKeys[id] = key
    else delete secrets.searchKeys[id]
  }
}

export function describeWebSearch(s: { enabled: boolean, order: SearchOrder, guide: string, guideRequired: boolean }, defaultGuide: string, searchKeys: Record<string, string>, status: ReadonlyArray<{ id: BackendId, state: BackendState }>): WebSearchView {
  return {
    enabled: s.enabled,
    order: s.order,
    guide: s.guide,
    defaultGuide,
    guideRequired: s.guideRequired,
    backends: status.map(s => ({ id: s.id, needsKey: BACKENDS[s.id].needsKey, hasKey: !!searchKeys[s.id], state: s.state })),
  }
}
