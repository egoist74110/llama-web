// Order, fallback and health of the search backends (decision 67 ③). By default the two without a key (DuckDuckGo, Bing)
// come first and the keyed, paid ones (Tavily, Brave) are only the fallback; a setting puts the keyed ones first. A failed backend hands over to the next one; an
// auth failure keeps a backend out until its key changes, a transient one for COOLDOWN_MS.
import { BACKENDS, SearchError, type BackendId, type SearchHit, type SearchOrder } from './backends'

export const COOLDOWN_MS = 60_000
export const DEFAULT_COUNT = 5
export const MAX_COUNT = 10
const SEARCH_TIMEOUT_MS = 12_000

const KEYED: BackendId[] = ['tavily', 'brave']
const FREE: BackendId[] = ['duckduckgo', 'bing']

export interface WebSearchDeps {
  /** Keys by backend id ('' or absent = none). */
  getKeys(): Partial<Record<BackendId, string>>
  /** Which group is tried first; absent = free-first, so paid backends are only spent when the free ones fail. */
  getOrder?(): SearchOrder
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** The backend that answered. */
  backend: BackendId
}

export class AllBackendsFailed extends Error {
  constructor() { super('no search backend answered'); this.name = 'AllBackendsFailed' }
}

export type BackendState = 'ready' | 'blocked' | 'cooldown' | 'no-key'

/** A backend that can be used right now, and whether it spends the user's quota. */
export interface BackendOption { id: BackendId, paid: boolean }
export interface BackendStatus { id: BackendId, needsKey: boolean, state: BackendState }

interface Health {
  /** The key this backend was blocked with; a different key clears the block. */
  blockedKey?: string
  cooldownUntil?: number
}

export function createWebSearch(deps: WebSearchDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const health = new Map<BackendId, Health>()

  function stateOf(id: BackendId, key: string): BackendState {
    if (BACKENDS[id].needsKey && !key) return 'no-key'
    const h = health.get(id)
    if (h?.blockedKey !== undefined) {
      if (h.blockedKey === key) return 'blocked'
      health.delete(id)
      return 'ready'
    }
    if (h?.cooldownUntil !== undefined && h.cooldownUntil > now()) return 'cooldown'
    return 'ready'
  }

  /** Backends in the order they are tried, with their keys: just `only` when the model named one. */
  function plan(only?: BackendId): Array<{ id: BackendId, key: string, state: BackendState }> {
    const keys = deps.getKeys()
    const mode = deps.getOrder?.()
    const order = only ? [only] : mode === 'keyed-first' ? [...KEYED, ...FREE] : mode === 'free-only' ? FREE : [...FREE, ...KEYED]
    return order.map(id => ({ id, key: keys[id] ?? '', state: stateOf(id, keys[id] ?? '') }))
  }

  /** Search with the first backend that gives results (only `only`, when given). Throws AllBackendsFailed when none does; an aborted `signal` rethrows its reason. */
  async function search(query: string, count: number, signal: AbortSignal, only?: BackendId): Promise<SearchOutcome> {
    const n = Math.max(1, Math.min(MAX_COUNT, Math.floor(count) || DEFAULT_COUNT))
    for (const { id, key, state } of plan(only)) {
      if (state !== 'ready') continue
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      const own = new AbortController()
      const onAbort = () => own.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => own.abort(new Error('timeout')), deps.timeoutMs ?? SEARCH_TIMEOUT_MS)
      try {
        const hits = await BACKENDS[id].search(query, { count: n, signal: own.signal, fetchImpl, key })
        if (hits.length) {
          health.delete(id)
          return { hits, backend: id }
        }
        // An empty answer is no failure of the backend: the next one may know more.
      } catch (e) {
        if (signal.aborted) throw signal.reason ?? e
        const kind = e instanceof SearchError ? e.kind : 'transient'
        if (kind === 'auth') health.set(id, { blockedKey: key })
        else if (kind === 'transient') health.set(id, { cooldownUntil: now() + COOLDOWN_MS })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }
    throw new AllBackendsFailed()
  }

  /** Backends that can answer right now (free ones first), independent of the order setting: what the model may name. */
  function available(): BackendOption[] {
    const keys = deps.getKeys()
    return [...FREE, ...KEYED]
      .filter(id => stateOf(id, keys[id] ?? '') === 'ready')
      .map(id => ({ id, paid: BACKENDS[id].needsKey }))
  }

  function status(): BackendStatus[] {
    return plan().map(p => ({ id: p.id, needsKey: BACKENDS[p.id].needsKey, state: p.state }))
  }

  return { search, status, available }
}

export type WebSearch = ReturnType<typeof createWebSearch>
