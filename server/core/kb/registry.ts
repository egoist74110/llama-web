// data/knowledge.json (decision 65 ②): the list of knowledge bases. The content of each one lives in its own SQLite
// file (`data/kb/<id>.sqlite`); this file only says what exists and how it was built.
import { createHash, randomBytes } from 'node:crypto'
import { KbError } from './errors'

export const KNOWLEDGE_VERSION = 2
export const DEFAULT_CHUNK_SIZE = 500
export const DEFAULT_CHUNK_OVERLAP = 80
export const MIN_CHUNK_SIZE = 100
export const MAX_CHUNK_SIZE = 4000
export const MAX_NAME_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 500
/** The usage guide of a knowledge base (decision 69): custom text, at most this many characters; '' = the default text. */
export const MAX_GUIDE_LENGTH = 20_000
/** Soft limit: above this the interface warns (brute-force vector search is sized for it). */
export const SOFT_CHUNK_LIMIT = 50_000

/** The embedding model the vectors of a knowledge base were made with (null = no vectors yet). */
export interface KbEmbedding {
  model: string | null
  dims: number | null
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  createdAt: number
  /** Characters per chunk; applies to documents added later. */
  chunkSize: number
  /** Characters repeated between neighbouring chunks; applies to documents added later. */
  chunkOverlap: number
  embedding: KbEmbedding
  /** Custom usage guide for the model (decision 69); '' = use the default text of the interface language. */
  guide: string
}

export interface KnowledgeDoc {
  version: number
  bases: KnowledgeBase[]
}

export function defaultKnowledge(): KnowledgeDoc {
  return { version: KNOWLEDGE_VERSION, bases: [] }
}

/** knowledge.json migrations: `[n]` converts a version-n document into version n + 1. */
export const KNOWLEDGE_MIGRATIONS: Record<number, (old: any) => any> = {
  // 1 -> 2 (decision 69): every knowledge base gets a guide ('' = default).
  1: old => ({ ...old, version: 2, bases: (Array.isArray(old?.bases) ? old.bases : []).map((b: any) => ({ ...b, guide: '' })) }),
}

/** Short revision of a guide text (first 12 hex characters of its SHA-256), so a client can tell when it changed. */
export const guideRev = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

/** Safe to use as a file name: lowercase letters, digits, dash, underscore. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/
export const validKbId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)

export function newKbId(taken: readonly string[]): string {
  for (;;) {
    const id = `kb-${randomBytes(4).toString('hex')}`
    if (!taken.includes(id)) return id
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** An overlap that is always valid for `size`. */
export const fallbackOverlap = (size: number) => Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(size / 5))

const validSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= MIN_CHUNK_SIZE && (n as number) <= MAX_CHUNK_SIZE

function normalizeBase(raw: unknown): KnowledgeBase {
  if (!isObj(raw)) throw new Error('knowledge base must be an object')
  if (!validKbId(raw.id)) throw new Error(`invalid knowledge base id "${String(raw.id)}"`)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error(`invalid knowledge base name for ${raw.id}`)
  const chunkSize = validSize(raw.chunkSize) ? raw.chunkSize : DEFAULT_CHUNK_SIZE
  const overlapOk = Number.isInteger(raw.chunkOverlap) && raw.chunkOverlap >= 0 && raw.chunkOverlap < chunkSize
  const e = isObj(raw.embedding) ? raw.embedding : {}
  const model = typeof e.model === 'string' && e.model ? e.model : null
  const dims = model !== null && Number.isInteger(e.dims) && e.dims > 0 ? e.dims : null
  return {
    id: raw.id,
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    chunkSize,
    chunkOverlap: overlapOk ? raw.chunkOverlap : fallbackOverlap(chunkSize),
    // A model without dimensions cannot be matched: treat it as "no vectors yet" so the knowledge base is flagged for a re-index.
    embedding: model !== null && dims !== null ? { model, dims } : { model: null, dims: null },
    guide: typeof raw.guide === 'string' ? raw.guide.slice(0, MAX_GUIDE_LENGTH) : '',
  }
}

/** Store validation: fills missing fields, rejects ids that are not file-name safe and duplicate names. */
export function normalizeKnowledge(doc: KnowledgeDoc): KnowledgeDoc {
  if (!isObj(doc)) throw new Error('knowledge must be an object')
  const list: unknown[] = Array.isArray(doc.bases) ? doc.bases : []
  const bases = list.map(normalizeBase)
  for (let i = 0; i < bases.length; i++) {
    for (let j = 0; j < i; j++) {
      if (bases[i]!.id === bases[j]!.id) throw new Error(`duplicate knowledge base id "${bases[i]!.id}"`)
      if (sameName(bases[i]!.name, bases[j]!.name)) throw new Error(`duplicate knowledge base name "${bases[i]!.name}"`)
    }
  }
  return { version: doc.version, bases }
}

/** Fields the management API may set. */
export interface KbEdit {
  name?: unknown
  description?: unknown
  chunkSize?: unknown
  chunkOverlap?: unknown
  guide?: unknown
}

/** Apply an edit to `base` (mutates it). `others` are the other knowledge bases (names must stay unique). Throws KbError. */
export function applyKbEdit(base: KnowledgeBase, edit: KbEdit, others: readonly KnowledgeBase[]): KnowledgeBase {
  if (!isObj(edit)) throw new KbError('bad-body')
  if (edit.name !== undefined) {
    const name = typeof edit.name === 'string' ? edit.name.trim() : ''
    if (!name || name.length > MAX_NAME_LENGTH) throw new KbError('bad-name')
    if (others.some(o => sameName(o.name, name))) throw new KbError('name-taken')
    base.name = name
  }
  if (edit.description !== undefined) {
    if (typeof edit.description !== 'string' || edit.description.length > MAX_DESCRIPTION_LENGTH) throw new KbError('bad-description')
    base.description = edit.description.trim()
  }
  if (edit.chunkSize !== undefined) {
    const n = Number(edit.chunkSize)
    if (!validSize(n)) throw new KbError('bad-chunk-size')
    base.chunkSize = n
  }
  if (edit.chunkOverlap !== undefined) {
    const n = Number(edit.chunkOverlap)
    if (!Number.isInteger(n) || n < 0) throw new KbError('bad-overlap')
    base.chunkOverlap = n
  }
  if (edit.guide !== undefined) {
    if (typeof edit.guide !== 'string' || edit.guide.length > MAX_GUIDE_LENGTH) throw new KbError('bad-guide')
    base.guide = edit.guide
  }
  if (base.chunkOverlap >= base.chunkSize) throw new KbError('bad-overlap')
  return base
}

/** A new knowledge base from API input (throws KbError). */
export function createKnowledgeBase(input: KbEdit, existing: readonly KnowledgeBase[], now: number): KnowledgeBase {
  if (!isObj(input)) throw new KbError('bad-body')
  const base: KnowledgeBase = {
    id: newKbId(existing.map(b => b.id)), name: '', description: '', createdAt: now,
    chunkSize: DEFAULT_CHUNK_SIZE, chunkOverlap: DEFAULT_CHUNK_OVERLAP, embedding: { model: null, dims: null }, guide: '',
  }
  if (input.name === undefined) throw new KbError('bad-name')
  return applyKbEdit(base, input, existing)
}
