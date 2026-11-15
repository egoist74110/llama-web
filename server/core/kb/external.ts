// External knowledge base operations (decisions 65 ⑦ / 69 ⑦): the one implementation behind both REST (/v1/kb) and MCP
// (/v1/mcp). Inputs are plain parsed JSON objects, outputs plain snake_case JSON objects, failures a KbApiError.
// Pure module (no Nitro): the manager and the list of knowledge bases are injected, the caller's rights come as a KbAccess.
import { fmt, t } from '../i18n'
import type { KbAccess } from './access'
import { KbError } from './errors'
import type { EntryView, KbManager } from './manager'
import { kbMessage, kbStatus } from './messages'
import { parseSearchFilters } from './search'

/** What the external operations need of the manager (tests may pass the real one). */
export type KbOps = Pick<KbManager,
  'list' | 'guide' | 'search' | 'listEntries' | 'getEntry' | 'addEntry' | 'updateEntry' | 'deleteEntry'
  | 'entryHistory' | 'listDocuments' | 'readSource' | 'addSourceText'>

export interface ExternalDeps {
  kb: KbOps
  /** The knowledge bases that exist now. */
  bases(): ReadonlyArray<{ id: string }>
}

/** An operation failed in a way the caller should see: `status` is the HTTP status, `code` the snake_case error code. */
export class KbApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message)
    this.name = 'KbApiError'
  }
}

export const READ_OPS = [
  'list_knowledge_bases', 'kb_guide', 'search_knowledge', 'list_entries', 'get_entry', 'get_entry_history', 'list_sources', 'read_source',
] as const
export const WRITE_OPS = ['add_entry', 'update_entry', 'delete_entry', 'add_source'] as const
export type OpName = typeof READ_OPS[number] | typeof WRITE_OPS[number]

export const isOpName = (v: unknown): v is OpName => typeof v === 'string' && ((READ_OPS as readonly string[]).includes(v) || (WRITE_OPS as readonly string[]).includes(v))
export const isWriteOp = (v: OpName): boolean => (WRITE_OPS as readonly string[]).includes(v)

/** Hits per search: default and ceiling for external callers (decision 65 ④). */
export const EXTERNAL_DEFAULT_TOP_K = 5
export const EXTERNAL_MAX_TOP_K = 20

type Args = Record<string, unknown>
const isObj = (v: unknown): v is Args => !!v && typeof v === 'object' && !Array.isArray(v)
const iso = (ms: number) => new Date(ms).toISOString()

const badParam = (name: string) => new KbApiError(400, 'invalid_parameter', fmt(t.kbApi.badParam, { name }), { param: name })

/** JSON null on an optional field means the same as leaving it out (many clients send nulls). */
const orUndef = (v: unknown): unknown => (v === null ? undefined : v)

function snake(code: string) { return code.replace(/-/g, '_') }

/** A KbError as the external API reports it; anything else is not ours to describe. */
function fromKbError(e: KbError): KbApiError {
  const extra: Record<string, unknown> = {}
  const data = e.data as { current?: EntryView } | undefined
  if (e.code === 'version-conflict' && data?.current) extra.current = entryOut(data.current)
  return new KbApiError(kbStatus(e.code), snake(e.code), kbMessage(e.code, e.detail), Object.keys(extra).length ? extra : undefined)
}

async function wrapped<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof KbError) throw fromKbError(e)
    throw e
  }
}

// ---- argument helpers ----

function optString(a: Args, name: string): string | undefined {
  const v = a[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw badParam(name)
  return v
}

function optNumber(a: Args, name: string): number | undefined {
  const v = a[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badParam(name)
  return v
}

/** A required positive integer id; anything else cannot name an existing item, so it is the same as an unknown one. */
function idArg(a: Args, name: string, code: 'entry-not-found' | 'doc-not-found'): number {
  const v = a[name]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new KbError(code)
  return v
}

// ---- rights ----

/**
 * The knowledge base `kbId`, checked in the order that leaks nothing: a restricted key hears 403 for every id outside its
 * list, whether or not it exists (rule 1), then 404 for an unknown one (rule 2), then read-only for a write (rule 3).
 */
function scoped(deps: ExternalDeps, access: KbAccess, kbId: unknown, write: boolean): string {
  if (typeof kbId !== 'string' || !kbId) throw badParam('kb_id')
  assertAllowed(access, kbId)
  assertExists(deps, kbId)
  if (write && !access.write) throw new KbApiError(403, 'kb_read_only', t.kbApi.kbReadOnly)
  return kbId
}

function assertAllowed(access: KbAccess, kbId: string) {
  if (access.allowed && !access.allowed.includes(kbId)) throw new KbApiError(403, 'kb_forbidden', fmt(t.kbApi.kbForbidden, { id: kbId }))
}

function assertExists(deps: ExternalDeps, kbId: string) {
  if (!deps.bases().some(b => b.id === kbId)) throw new KbApiError(404, 'kb_not_found', fmt(t.kbApi.kbNotFound, { id: kbId }))
}

/** Rule 4: a write must carry the revision of the guide as it is now (the current one is never told). */
function requireGuide(deps: ExternalDeps, kbId: string, a: Args) {
  if (typeof a.guide_rev !== 'string' || a.guide_rev !== deps.kb.guide(kbId).rev) {
    throw new KbApiError(412, 'guide_required', fmt(t.kbApi.guideRequired, { id: kbId }))
  }
}

async function scopedWrite(deps: ExternalDeps, access: KbAccess, a: Args): Promise<string> {
  const id = scoped(deps, access, a.kb_id, true)
  requireGuide(deps, id, a)
  return id
}

// ---- views ----

function entryOut(e: EntryView) {
  return { id: e.id, title: e.title, body: e.body, tags: e.tags, version: e.version, created_at: iso(e.createdAt), updated_at: iso(e.updatedAt), status: e.status }
}

function sourceOut(d: { id: number, name: string, size: number, chunkCount: number, status: string, errorCode: string | null, addedAt: number, tags: string[], hasRaw: boolean }) {
  // `source` of a document may be a file system path: never part of the view.
  return {
    id: d.id, name: d.name, size: d.size, chunks: d.chunkCount, status: d.status, error_code: d.errorCode,
    created_at: iso(d.addedAt), tags: d.tags, readable: d.hasRaw,
  }
}

// ---- operations ----

async function listKnowledgeBases(deps: ExternalDeps, access: KbAccess) {
  const views = await deps.kb.list()
  return {
    knowledge_bases: views
      .filter(b => !access.allowed || access.allowed.includes(b.id))
      .map(b => ({
        id: b.id, name: b.name, description: b.description, sources: b.docCount, entries: b.entryCount, chunks: b.chunkCount,
        tags: b.tags, guide_rev: deps.kb.guide(b.id).rev, writable: access.write, reindex_needed: b.reindexNeeded,
      })),
  }
}

async function searchKnowledge(deps: ExternalDeps, access: KbAccess, a: Args) {
  if (typeof a.query !== 'string') throw badParam('query')
  let ids: string[] | null
  const given = a.kb_ids
  if (given !== undefined && given !== null && (!Array.isArray(given) || !given.every(x => typeof x === 'string'))) throw badParam('kb_ids')
  if (Array.isArray(given) && given.length > 0) {
    ids = [...new Set(given as string[])]
    for (const id of ids) { assertAllowed(access, id); assertExists(deps, id) }
  } else if (access.allowed === null) {
    ids = null
  } else {
    // A listed id whose knowledge base was deleted matches nothing.
    ids = access.allowed.filter(id => deps.bases().some(b => b.id === id))
  }
  const topK = optNumber(a, 'top_k')
  const filters = parseSearchFilters({ tags: a.tags, minSimilarity: a.min_similarity })
  const r = await deps.kb.search(ids, a.query, {
    topK: topK === undefined ? EXTERNAL_DEFAULT_TOP_K : Math.min(EXTERNAL_MAX_TOP_K, Math.max(1, Math.floor(topK))),
    ...filters,
  })
  return {
    mode: r.mode,
    results: r.hits.map(h => ({
      kb_id: h.kbId, kb_name: h.kbName, kind: h.kind, id: h.docId, title_or_name: h.docName, version: h.entryVersion,
      text: h.text, heading_path: h.headingPath, start_line: h.startLine, start_char: h.startChar, end_char: h.endChar,
      score: h.score, similarity: h.similarity,
    })),
    reindex_needed: r.reindexNeeded,
  }
}

const OPS: Record<OpName, (deps: ExternalDeps, access: KbAccess, a: Args) => Promise<unknown>> = {
  list_knowledge_bases: (deps, access) => listKnowledgeBases(deps, access),

  async kb_guide(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    const g = deps.kb.guide(id)
    return { kb_id: id, guide: g.guide, guide_rev: g.rev, is_default: g.isDefault }
  },

  search_knowledge: (deps, access, a) => searchKnowledge(deps, access, a),

  async list_entries(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    const r = await deps.kb.listEntries(id, { tag: optString(a, 'tag'), query: optString(a, 'query'), offset: optNumber(a, 'offset'), limit: optNumber(a, 'limit') })
    return {
      total: r.total,
      entries: r.items.map(e => ({ id: e.id, title: e.title, tags: e.tags, version: e.version, updated_at: iso(e.updatedAt), status: e.status, preview: e.preview })),
    }
  },

  async get_entry(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    return entryOut(await deps.kb.getEntry(id, idArg(a, 'entry_id', 'entry-not-found')))
  },

  async get_entry_history(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    const rows = await deps.kb.entryHistory(id, idArg(a, 'entry_id', 'entry-not-found'))
    return { versions: rows.map(v => ({ version: v.version, op: v.op, title: v.title, tags: v.tags, actor: v.actor, at: iso(v.at), body_length: v.bodyLength })) }
  },

  async list_sources(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    // The manager lists live sources only (not entries, not the trash).
    return { sources: (await deps.kb.listDocuments(id)).filter(d => d.kind === 'source' && d.deletedAt === null).map(sourceOut) }
  },

  async read_source(deps, access, a) {
    const id = scoped(deps, access, a.kb_id, false)
    const docId = idArg(a, 'source_id', 'doc-not-found')
    const offset = optNumber(a, 'offset')
    const length = optNumber(a, 'length')
    if (!(await deps.kb.listDocuments(id)).some(d => d.id === docId && d.kind === 'source' && d.deletedAt === null)) throw new KbError('doc-not-found')
    const r = await deps.kb.readSource(id, docId, { offset, length })
    return { id: r.docId, name: r.name, total_chars: r.totalChars, offset: r.offset, text: r.text, next_offset: r.nextOffset }
  },

  async add_entry(deps, access, a) {
    const id = await scopedWrite(deps, access, a)
    return entryOut(await deps.kb.addEntry(id, { title: a.title, body: a.body, tags: orUndef(a.tags) }, access.actor))
  },

  async update_entry(deps, access, a) {
    const id = await scopedWrite(deps, access, a)
    const docId = idArg(a, 'entry_id', 'entry-not-found')
    const baseVersion = a.base_version !== undefined ? a.base_version : a.baseVersion
    return entryOut(await deps.kb.updateEntry(id, docId, { baseVersion, title: orUndef(a.title), body: orUndef(a.body), tags: orUndef(a.tags) }, access.actor))
  },

  async delete_entry(deps, access, a) {
    const id = await scopedWrite(deps, access, a)
    const docId = idArg(a, 'entry_id', 'entry-not-found')
    await deps.kb.deleteEntry(id, docId, { baseVersion: a.base_version !== undefined ? a.base_version : a.baseVersion }, access.actor)
    return { deleted: true, entry_id: docId }
  },

  async add_source(deps, access, a) {
    const id = await scopedWrite(deps, access, a)
    return sourceOut(await deps.kb.addSourceText(id, { name: a.name, text: a.text, tags: orUndef(a.tags) }, access.actor))
  },
}

/**
 * Run one operation as `access`. `args` is the parsed JSON object of the call (REST: body and path parameters merged;
 * MCP: `arguments`). Throws a KbApiError; anything else is an unexpected failure.
 */
export async function runOp(deps: ExternalDeps, access: KbAccess, name: OpName, args: unknown): Promise<unknown> {
  const a: Args = isObj(args) ? args : {}
  return wrapped(() => OPS[name](deps, access, a))
}
