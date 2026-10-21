// Knowledge for the chat models (decision 65 ⑨): what a profile / an external upstream is bound to, the optional
// `knowledge` field of a request, and how the two are resolved into what one request uses. Pure module (no Nitro, no
// SQLite): the list of existing knowledge bases and the permission list are passed in.

export type KnowledgeMode = 'inject' | 'tool'

export interface KnowledgeBinding {
  enabled: boolean
  /** True = every knowledge base that exists at request time (later ones included); `kbs` is then ignored. */
  all: boolean
  /** Knowledge base ids (used when `all` is false). */
  kbs: string[]
  mode: KnowledgeMode
  /** Hits per search, 1..20. */
  topK: number
}

export const BINDING_DEFAULT_TOP_K = 5
export const BINDING_MAX_TOP_K = 20
/** More than this in one binding is a hand-edit gone wrong; the extra ones are dropped. */
const MAX_BOUND = 50

export function defaultBinding(): KnowledgeBinding {
  return { enabled: false, all: false, kbs: [], mode: 'inject', topK: BINDING_DEFAULT_TOP_K }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const isMode = (v: unknown): v is KnowledgeMode => v === 'inject' || v === 'tool'

export const clampTopK = (n: number) => Math.min(BINDING_MAX_TOP_K, Math.max(1, Math.floor(n)))

/** Thrown for a malformed binding / override; `code` is mapped to a message by the caller. */
export class BindingError extends Error {
  constructor(public code: 'bad-knowledge') {
    super(code)
    this.name = 'BindingError'
  }
}

/** A stored binding (data files may be hand-edited): anything wrong falls back to the default for that field. */
export function normalizeBinding(raw: unknown): KnowledgeBinding {
  const out = defaultBinding()
  if (!isObj(raw)) return out
  out.enabled = raw.enabled === true
  out.all = raw.all === true
  if (Array.isArray(raw.kbs)) out.kbs = [...new Set(raw.kbs.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, MAX_BOUND)
  if (isMode(raw.mode)) out.mode = raw.mode
  if (typeof raw.topK === 'number' && Number.isFinite(raw.topK)) out.topK = clampTopK(raw.topK)
  return out
}

/** A binding from the management API: wrong types are refused (missing fields take the defaults). */
export function parseBinding(raw: unknown): KnowledgeBinding {
  if (!isObj(raw)) throw new BindingError('bad-knowledge')
  const out = defaultBinding()
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new BindingError('bad-knowledge')
    out.enabled = raw.enabled
  }
  if (raw.all !== undefined) {
    if (typeof raw.all !== 'boolean') throw new BindingError('bad-knowledge')
    out.all = raw.all
  }
  if (raw.kbs !== undefined) {
    if (!Array.isArray(raw.kbs) || raw.kbs.length > MAX_BOUND || !raw.kbs.every(x => typeof x === 'string' && x.length > 0)) throw new BindingError('bad-knowledge')
    out.kbs = [...new Set(raw.kbs as string[])]
  }
  if (raw.mode !== undefined) {
    if (!isMode(raw.mode)) throw new BindingError('bad-knowledge')
    out.mode = raw.mode
  }
  if (raw.topK !== undefined) {
    if (typeof raw.topK !== 'number' || !Number.isFinite(raw.topK)) throw new BindingError('bad-knowledge')
    out.topK = clampTopK(raw.topK)
  }
  return out
}

/** First knowledge base id of `binding` that is not in `existing`, or null. Used when a binding is saved. */
export function unknownBoundKb(binding: KnowledgeBinding, existing: readonly string[]): string | null {
  if (binding.all) return null
  return binding.kbs.find(id => !existing.includes(id)) ?? null
}

// ---------------------------------------------------------------------------------------
// Request override

export interface KbRef {
  id: string
  name: string
}

export interface EffectiveKnowledge {
  mode: KnowledgeMode
  /** Existing, permitted knowledge base ids (at least one). */
  kbs: string[]
  topK: number
}

export type ResolveResult =
  | {
    ok: true
    /** null = this request uses no knowledge. */
    effective: EffectiveKnowledge | null
    /** Bound knowledge bases that no longer exist (skipped). */
    skipped: string[]
  }
  | { ok: false, status: 400 | 403, code: 'kb_not_found' | 'invalid_knowledge' | 'kb_forbidden', name: string }

/**
 * The knowledge one request uses: the request's own `knowledge` field (`raw`, already read from the body; undefined /
 * null = absent) over the binding of the profile / upstream.
 *  - `false`: none.
 *  - `{ kbs?, mode?, top_k? }`: replaces the fields it carries; `kbs` present = use them even if the binding is off
 *    (an empty list means none). Names match case-insensitively, ids exactly.
 *  - anything else: 400 `invalid_knowledge`; a named knowledge base that does not exist: 400 `kb_not_found`.
 * A bound knowledge base that was deleted later is skipped. `allowed` = the ids the caller may use (null = all); asking
 * for another one is 403 `kb_forbidden`.
 */
export function resolveKnowledge(args: {
  binding: KnowledgeBinding | null | undefined
  raw: unknown
  bases: readonly KbRef[]
  allowed: readonly string[] | null
}): ResolveResult {
  const { raw, bases, allowed } = args
  const binding = args.binding ? normalizeBinding(args.binding) : null
  const bad = (code: 'kb_not_found' | 'invalid_knowledge', name = ''): ResolveResult => ({ ok: false, status: 400, code, name })
  if (raw === false) return { ok: true, effective: null, skipped: [] }

  let mode: KnowledgeMode = binding?.mode ?? 'inject'
  let topK = binding?.topK ?? BINDING_DEFAULT_TOP_K
  // `all` = every knowledge base that exists now; the not-allowed ones are dropped silently (the caller did not name them).
  const bindAll = !!binding?.enabled && binding.all
  let explicit = false
  let wanted: string[] = binding?.enabled ? (binding.all ? bases.map(b => b.id) : binding.kbs) : []

  if (raw !== undefined && raw !== null) {
    if (!isObj(raw)) return bad('invalid_knowledge')
    if (raw.mode !== undefined) {
      if (!isMode(raw.mode)) return bad('invalid_knowledge')
      mode = raw.mode
    }
    if (raw.top_k !== undefined) {
      if (typeof raw.top_k !== 'number' || !Number.isFinite(raw.top_k)) return bad('invalid_knowledge')
      topK = clampTopK(raw.top_k)
    }
    if (raw.kbs !== undefined) {
      if (!Array.isArray(raw.kbs) || !raw.kbs.every(x => typeof x === 'string')) return bad('invalid_knowledge')
      const ids: string[] = []
      for (const ref of raw.kbs as string[]) {
        const text = ref.trim()
        const hit = bases.find(b => b.id === text) ?? bases.find(b => b.name.toLowerCase() === text.toLowerCase())
        if (!hit) return bad('kb_not_found', ref)
        if (!ids.includes(hit.id)) ids.push(hit.id)
      }
      wanted = ids
      explicit = true
    }
  }

  const existing = new Set(bases.map(b => b.id))
  const skipped = wanted.filter(id => !existing.has(id))
  const kbs = wanted.filter(id => existing.has(id))
  if (allowed && bindAll && !explicit) {
    const permitted = kbs.filter(id => allowed.includes(id))
    return { ok: true, effective: permitted.length ? { mode, kbs: permitted, topK } : null, skipped }
  }
  if (allowed) {
    const denied = kbs.find(id => !allowed.includes(id))
    if (denied) return { ok: false, status: 403, code: 'kb_forbidden', name: bases.find(b => b.id === denied)?.name ?? denied }
  }
  return { ok: true, effective: kbs.length ? { mode, kbs, topK } : null, skipped }
}
