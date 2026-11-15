// Knowledge base manager (decision 65): the registry (data/knowledge.json), one SQLite file per knowledge base, the
// import / re-index queue and hybrid search. Pure of Nitro: the registry store and the embedder are injected.
import { mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { chunkText } from './chunk'
import { decodeText } from './text'
import { ftsMatch } from './tokenize'
import { KbDb, sha256Hex, type ChangeRow, type ChunkHit, type DocKind, type DocRow, type DocStatus, type VersionRow } from './kb-db'
import { KbError } from './errors'
import { applyKbEdit, createKnowledgeBase, guideRev, SOFT_CHUNK_LIMIT, validKbId, type KbEdit, type KnowledgeBase, type KnowledgeDoc } from './registry'
import { t } from '../i18n'
import type { Embedder } from './embed'
import { fuseRrf } from './search'
import { cleanSimilarity, dedupeTags, MAX_FILTER_TAGS, type TagCount } from './tags'

export type { TagCount }

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const EMBED_BATCH = 32
export const DEFAULT_TOP_K = 5
export const MAX_TOP_K = 1000
/** Entries (decision 69). */
export const MAX_ENTRY_TITLE = 200
export const MAX_ENTRY_BODY = 20_000
export const MAX_ENTRY_TAGS = 20
/** One `readSource` call returns at most this many characters. */
export const MAX_READ_LENGTH = 20_000
const MAX_ACTOR_LENGTH = 80
const MAX_SOURCE_NAME = 200
/** Candidates taken from each of the two searches before fusion. */
const MIN_CANDIDATES = 50
const MAX_QUERY_CHARS = 2000

export interface KbStore {
  get(): KnowledgeDoc
  update(fn: (draft: KnowledgeDoc) => KnowledgeDoc | void): KnowledgeDoc
}

export interface KbManagerOptions {
  dataDir: string
  store: KbStore
  embedder: Embedder
  /** Called when the live state (jobs, progress) changed. */
  onChange?: () => void
  log?: (msg: string) => void
  now?: () => number
  /** Texts per embedding request. */
  batchSize?: number
}

export interface KbView extends KnowledgeBase {
  /** Live sources (uploaded / added texts). */
  docCount: number
  /** Live entries (decision 69). */
  entryCount: number
  /** Documents of both kinds in the trash. */
  trashCount: number
  chunkCount: number
  /** More chunks than SOFT_CHUNK_LIMIT: brute-force vector search gets slow. */
  oversize: boolean
  /** Vector search is not used for this knowledge base until it is re-indexed with the current engine. */
  reindexNeeded: boolean
  /** A job (import or re-index) of this knowledge base is queued or running. */
  busy: boolean
  /** Every tag of its chunks with the number of chunks, sorted by tag (decision 65 ⑭). */
  tags: TagCount[]
}

export interface SearchOptions {
  topK?: number
  /** Only chunks that carry any of these tags (decision 65 ⑭); empty = no filter. */
  tags?: readonly string[]
  /** 0..1: knowledge bases searched by vector drop candidates below this cosine similarity; null / undefined = off. */
  minSimilarity?: number | null
}

export interface DocView extends DocRow {
  /** Progress of the job working on this document (chunks done / total); null when none. */
  progress: { done: number, total: number } | null
}

export interface KbJobView {
  kind: 'import' | 'reindex'
  kbId: string
  docId: number | null
  name: string
  state: 'queued' | 'running'
  done: number
  total: number
}

export interface KbLiveState {
  jobs: KbJobView[]
}

export interface EntryView {
  id: number
  title: string
  body: string
  tags: string[]
  version: number
  createdAt: number
  updatedAt: number
  status: DocStatus
}

export interface EntryListItem {
  id: number
  title: string
  tags: string[]
  version: number
  updatedAt: number
  status: DocStatus
  /** The first 200 characters of the body. */
  preview: string
}

export interface TrashItem {
  id: number
  kind: DocKind
  name: string
  deletedAt: number
  /** Entries: the version the trash move created; sources: null. */
  version: number | null
  size: number
}

export interface GuideView {
  /** The effective text: the custom one, or the default of the interface language. */
  guide: string
  /** The stored text; '' = the default is in use. */
  custom: string
  isDefault: boolean
  /** Revision of the effective text (see `guideRev`). */
  rev: string
}

export interface SourceText {
  docId: number
  name: string
  totalChars: number
  offset: number
  text: string
  /** Offset of the next page, null at the end. */
  nextOffset: number | null
}

export interface SearchHit {
  kbId: string
  kbName: string
  /** The entry id for an entry, the document id for a source. */
  docId: number
  /** The title for an entry. */
  docName: string
  kind: DocKind
  /** Entries: the current version; sources: null. */
  entryVersion: number | null
  chunkId: number
  text: string
  startLine: number
  startChar: number
  endChar: number
  headingPath: string
  /** Fused rank score (higher is better). */
  score: number
  /** BM25 of the keyword match (more negative is better), null when the keyword search did not return it. */
  bm25: number | null
  /** Cosine similarity, null when the vector search did not return it. */
  similarity: number | null
  /** `hybrid` when the vector search ran for this chunk's knowledge base, else `keyword`. */
  mode: 'hybrid' | 'keyword'
}

export interface SearchResponse {
  hits: SearchHit[]
  /** `hybrid` when the vector search ran for at least one searched knowledge base. */
  mode: 'hybrid' | 'keyword'
  /** At least one searched knowledge base needs a re-index before its vectors can be used. */
  reindexNeeded: boolean
  reindexKbIds: string[]
  /** The embedding engine failed for this query (the answer is keyword-only). */
  vectorError: boolean
}

export interface AddDocumentInput {
  name: string
  bytes: Uint8Array
  /** Where it came from (a path or a label); defaults to the file name. */
  source?: string
  /** Last-modified time of the file (ms); defaults to now. */
  mtime?: number
}

const SUPPORTED: Record<string, 'txt' | 'md'> = { '.txt': 'txt', '.md': 'md', '.markdown': 'md' }
const extOf = (name: string) => /\.[^./]+$/.exec(name)?.[0]?.toLowerCase() ?? ''

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Who wrote: 'admin', 'local' or 'key:<name>'; cut to MAX_ACTOR_LENGTH. */
const actorOf = (a: unknown) => (typeof a === 'string' ? a : '').slice(0, MAX_ACTOR_LENGTH) || 'unknown'

function cleanTitle(v: unknown): string {
  const title = typeof v === 'string' ? v.trim() : ''
  if (!title || title.length > MAX_ENTRY_TITLE) throw new KbError('bad-title')
  return title
}

/** The body is stored as written; it only must not be blank. */
function cleanBody(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > MAX_ENTRY_BODY) throw new KbError('bad-entry-body')
  return v
}

function cleanEntryTags(v: unknown): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new KbError('bad-tags')
  const tags = dedupeTags(v as string[], MAX_ENTRY_TAGS + 1)
  if (tags.length > MAX_ENTRY_TAGS) throw new KbError('bad-tags')
  return tags
}

function baseVersionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new KbError('bad-base-version')
  return v
}

interface Job {
  kind: 'import' | 'reindex'
  kbId: string
  docId: number | null
  name: string
  state: 'queued' | 'running'
  done: number
  total: number
  ac: AbortController
  run(job: Job): Promise<void>
  finished: Promise<void>
  finish(): void
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || (e as { name?: string })?.name === 'AbortError'

export class KbManager {
  private dbs = new Map<string, Promise<KbDb>>()
  private queue: Job[] = []
  private current: Job | null = null
  private draining: Promise<void> | null = null
  private closed = false
  private readonly batch: number

  constructor(private o: KbManagerOptions) {
    this.batch = o.batchSize ?? EMBED_BATCH
  }

  private now() { return this.o.now?.() ?? Date.now() }
  private changed() { this.o.onChange?.() }
  private log(msg: string) { this.o.log?.(`knowledge: ${msg}`) }
  private bases(): KnowledgeBase[] { return this.o.store.get().bases }

  private base(id: string): KnowledgeBase {
    const b = validKbId(id) ? this.bases().find(x => x.id === id) : undefined
    if (!b) throw new KbError('not-found')
    return b
  }

  private fileOf(id: string) { return join(this.o.dataDir, 'kb', `${id}.sqlite`) }

  private db(id: string): Promise<KbDb> {
    let p = this.dbs.get(id)
    if (!p) {
      mkdirSync(join(this.o.dataDir, 'kb'), { recursive: true })
      p = KbDb.open(this.fileOf(id))
      p.catch(() => { if (this.dbs.get(id) === p) this.dbs.delete(id) })
      this.dbs.set(id, p)
    }
    return p
  }

  private async dbOf(id: string): Promise<KbDb> {
    this.base(id)
    return this.db(id)
  }

  // ---- knowledge bases ----

  /**
   * The engine is on and this knowledge base has chunks without usable vectors: it was built with another model, or
   * some documents are keyword-only / failed. (Documents still being indexed do not count.)
   */
  private needsReindex(b: KnowledgeBase, db: KbDb): boolean {
    const name = this.o.embedder.name()
    if (!name || db.countChunks() === 0) return false
    return (b.embedding.model !== null && b.embedding.model !== name) || db.countUnindexed() > 0
  }

  async list(): Promise<KbView[]> {
    const out: KbView[] = []
    for (const b of this.bases()) out.push(await this.view(b))
    return out
  }

  async get(id: string): Promise<KbView> {
    return this.view(this.base(id))
  }

  private async view(b: KnowledgeBase): Promise<KbView> {
    const db = await this.db(b.id)
    const chunkCount = db.countChunks()
    return {
      ...b,
      docCount: db.countDocuments(),
      entryCount: db.countEntries(),
      trashCount: db.countTrash(),
      chunkCount,
      oversize: chunkCount > SOFT_CHUNK_LIMIT,
      reindexNeeded: this.needsReindex(b, db),
      busy: this.queue.some(j => j.kbId === b.id) || this.current?.kbId === b.id,
      tags: db.listTags(),
    }
  }

  async create(input: KbEdit): Promise<KbView> {
    const doc = this.o.store.update((draft) => { draft.bases.push(createKnowledgeBase(input, draft.bases, this.now())) })
    return this.view(doc.bases[doc.bases.length - 1]!)
  }

  /** Name, description, guide and chunking (the chunk settings apply to documents added afterwards). */
  async update(id: string, edit: KbEdit): Promise<KbView> {
    this.base(id)
    const doc = this.o.store.update((draft) => {
      const b = draft.bases.find(x => x.id === id)
      if (!b) throw new KbError('not-found')
      applyKbEdit(b, edit, draft.bases.filter(x => x.id !== id))
    })
    return this.view(doc.bases.find(x => x.id === id)!)
  }

  async remove(id: string): Promise<void> {
    this.base(id)
    await this.cancelJobs(j => j.kbId === id)
    this.o.store.update((draft) => { draft.bases = draft.bases.filter(b => b.id !== id) })
    const open = this.dbs.get(id)
    this.dbs.delete(id)
    if (open) await open.then(d => d.close(), () => {})
    const file = this.fileOf(id)
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try { rmSync(f, { force: true }) } catch (e) { this.log(`could not delete ${basename(f)}: ${(e as Error).message}`) }
    }
  }

  // ---- documents ----

  async listDocuments(id: string): Promise<DocView[]> {
    const db = await this.dbOf(id)
    return db.listDocuments().map(d => this.docView(id, d))
  }

  private docView(kbId: string, d: DocRow): DocView {
    const job = [...this.queue, ...(this.current ? [this.current] : [])].find(j => j.kbId === kbId && (j.docId === d.id || j.kind === 'reindex'))
    return { ...d, progress: job && job.state === 'running' ? { done: job.done, total: job.total } : null }
  }

  /**
   * Decode, chunk and store a document (status `indexing`), then queue its embedding. Resolves when the document is
   * stored, not when it is embedded: follow `status` and the live `jobs`.
   */
  async addDocument(id: string, input: AddDocumentInput, actor: string = 'admin'): Promise<DocView> {
    const base = this.base(id)
    const name = basename(String(input.name ?? '').replace(/\\/g, '/')).trim()
    const ext = extOf(name)
    const kind = SUPPORTED[ext]
    if (!name || !kind) throw new KbError('unsupported-type', ext || name)
    if (!(input.bytes instanceof Uint8Array)) throw new KbError('bad-body')
    if (input.bytes.length === 0) throw new KbError('empty-file')
    if (input.bytes.length > MAX_UPLOAD_BYTES) throw new KbError('too-large')
    const db = await this.db(id)
    const sha = sha256Hex(input.bytes)
    if (db.findBySha(sha)) throw new KbError('duplicate')
    const { text } = decodeText(input.bytes)
    const chunks = chunkText(text, { kind, chunkSize: base.chunkSize, overlap: base.chunkOverlap })
    if (!chunks.length) throw new KbError('no-text')
    const now = this.now()
    const who = actorOf(actor)
    const docId = db.transaction(() => {
      const docId = db.insertDocument({
        name, source: input.source?.trim() || name, size: input.bytes.length, sha256: sha,
        mtime: Number.isFinite(input.mtime) ? Math.floor(input.mtime!) : now, addedAt: now, raw: text,
      }, chunks)
      db.insertChange({ at: now, actor: who, op: 'add', kind: 'source', docId, version: null, name })
      return docId
    })
    this.queueImport(db, id, docId, name)
    return this.docView(id, db.getDocument(docId)!)
  }

  /**
   * Add a text as a source (decision 69), the same as uploading a .txt / .md file. `name` without a supported extension
   * gets `.txt`. `tags` become a tag line `[tag:a,b]` in front of the stored text, so the chunker applies them to the
   * whole text like any tag line (the line is in no chunk but is part of the stored raw text and its character offsets).
   */
  async addSourceText(id: string, input: { name: unknown, text: unknown, tags?: unknown }, actor: string): Promise<DocView> {
    this.base(id)
    if (!isObj(input)) throw new KbError('bad-body')
    // A re-index rewrites every vector: nothing is added to the content while it runs.
    if (this.hasReindex(id)) throw new KbError('busy')
    const given = basename(String(typeof input.name === 'string' ? input.name : '').replace(/\\/g, '/')).trim()
    if (!given || given.length > MAX_SOURCE_NAME) throw new KbError('bad-doc-name')
    const name = SUPPORTED[extOf(given)] ? given : `${given}.txt`
    if (typeof input.text !== 'string') throw new KbError('bad-body')
    if (input.text.trim() === '') throw new KbError('empty-file')
    let tagLine = ''
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some(x => typeof x !== 'string')) throw new KbError('bad-tags')
      // A tag may not contain what ends or splits a tag line.
      const tags = dedupeTags((input.tags as string[]).map(x => x.replace(/[,，[\]\r\n]/g, ' ')), MAX_ENTRY_TAGS)
      if (tags.length) tagLine = `[tag:${tags.join(',')}]\n`
    }
    const bytes = new TextEncoder().encode(tagLine + input.text)
    if (bytes.length > MAX_UPLOAD_BYTES) throw new KbError('too-large')
    return this.addDocument(id, { name, bytes, source: name }, actor)
  }

  /**
   * Move a source to the trash (its chunks go, its text stays so it can be restored). A source without stored text
   * (added before schema 2) cannot be restored, so it is deleted for good: `trashed` is false then.
   */
  async removeDocument(id: string, docId: number, actor: string = 'admin'): Promise<{ trashed: boolean }> {
    const db = await this.dbOf(id)
    const live = (): DocRow => {
      const d = db.getDocument(docId)
      if (!d || d.kind !== 'source' || d.deletedAt !== null) throw new KbError('doc-not-found')
      return d
    }
    live()
    // A re-index rewrites every vector: a document cannot go while it runs (it would leave vectors without chunks).
    if (this.hasReindex(id)) throw new KbError('busy')
    await this.cancelJobs(j => j.kbId === id && j.docId === docId)
    const d = live()
    const now = this.now()
    const who = actorOf(actor)
    db.transaction(() => {
      if (d.hasRaw) {
        db.trashDocument(docId, now)
        db.insertChange({ at: now, actor: who, op: 'delete', kind: 'source', docId, version: null, name: d.name })
      } else {
        db.deleteDocument(docId)
        db.insertChange({ at: now, actor: who, op: 'purge', kind: 'source', docId, version: null, name: d.name })
      }
    })
    this.changed()
    return { trashed: d.hasRaw }
  }

  /** A page of the stored text of a source (or the body of an entry). `offset` / `length` count UTF-16 code units. */
  async readSource(id: string, docId: number, o: { offset?: number, length?: number } = {}): Promise<SourceText> {
    const db = await this.dbOf(id)
    const d = db.getDocument(docId)
    if (!d || d.deletedAt !== null) throw new KbError('doc-not-found')
    const raw = db.getRaw(docId)
    if (raw === null) throw new KbError('no-raw')
    const offset = Number.isFinite(o.offset) ? Math.min(raw.length, Math.max(0, Math.floor(o.offset!))) : 0
    const length = Number.isFinite(o.length) ? Math.min(MAX_READ_LENGTH, Math.max(1, Math.floor(o.length!))) : MAX_READ_LENGTH
    let end = Math.min(raw.length, offset + length)
    // Do not cut a surrogate pair in two.
    const last = raw.charCodeAt(end - 1)
    if (end < raw.length && end - offset > 1 && last >= 0xd800 && last <= 0xdbff) end--
    return { docId, name: d.name, totalChars: raw.length, offset, text: raw.slice(offset, end), nextOffset: end < raw.length ? end : null }
  }

  // ---- entries (decision 69) ----

  private async writable(id: string): Promise<KbDb> {
    const db = await this.dbOf(id)
    // A re-index rewrites every vector: nothing is written to the content while it runs.
    if (this.hasReindex(id)) throw new KbError('busy')
    return db
  }

  /** The live entry `docId`; a source, a trashed entry and a missing one are all `entry-not-found`. */
  private liveEntry(db: KbDb, docId: number): DocRow {
    const d = Number.isInteger(docId) ? db.getDocument(docId) : undefined
    if (!d || d.kind !== 'entry' || d.deletedAt !== null) throw new KbError('entry-not-found')
    return d
  }

  private entryView(db: KbDb, d: DocRow): EntryView {
    return {
      id: d.id, title: d.name, body: db.getRaw(d.id) ?? '', tags: d.entryTags ?? [], version: d.version,
      createdAt: d.addedAt, updatedAt: d.updatedAt ?? d.addedAt, status: d.status,
    }
  }

  private checkBase(db: KbDb, d: DocRow, baseVersion: number) {
    if (baseVersion !== d.version) throw new KbError('version-conflict', `${baseVersion} / ${d.version}`, { code: 'version_conflict', current: this.entryView(db, d) })
  }

  private entryChunks(base: KnowledgeBase, title: string, body: string, tags: readonly string[]) {
    // Every chunk carries the entry's tags in addition to the tag lines of the body, and the title leads its heading
    // path, so the title is found by keyword search (the FTS text is heading path + text) and shown as provenance.
    return chunkText(body, { kind: 'md', chunkSize: base.chunkSize, overlap: base.chunkOverlap })
      .map(c => ({ ...c, headingPath: c.headingPath ? `${title} > ${c.headingPath}` : title, tags: dedupeTags([...tags, ...c.tags], 2 * MAX_ENTRY_TAGS) }))
  }

  private hasJob(id: string, docId: number) {
    return [...this.queue, ...(this.current ? [this.current] : [])].some(j => j.kbId === id && j.docId === docId)
  }

  private queueImport(db: KbDb, id: string, docId: number, name: string) {
    this.enqueue({ kind: 'import', kbId: id, docId, name, total: db.countChunks(docId), run: j => this.runImport(j) })
  }

  /** A write was refused after its import job had been cancelled: the document still needs its vectors. */
  private requeue(db: KbDb, id: string, docId: number) {
    const d = db.getDocument(docId)
    if (d && d.deletedAt === null && d.status === 'indexing' && !this.hasJob(id, docId)) this.queueImport(db, id, docId, d.name)
  }

  /**
   * Run a write on a live entry: check the version, cancel the import job of the entry, check again (the wait may have
   * let another write in), then run `fn` synchronously. A refusal re-queues the cancelled import.
   */
  private async guarded<T>(id: string, docId: number, baseVersion: unknown, fn: (db: KbDb, row: DocRow) => T): Promise<T> {
    const bv = baseVersionOf(baseVersion)
    const db = await this.writable(id)
    this.checkBase(db, this.liveEntry(db, docId), bv)
    await this.cancelJobs(j => j.kbId === id && j.docId === docId)
    try {
      if (this.hasReindex(id)) throw new KbError('busy')
      const row = this.liveEntry(db, docId)
      this.checkBase(db, row, bv)
      return fn(db, row)
    } catch (e) {
      this.requeue(db, id, docId)
      throw e
    }
  }

  async listEntries(id: string, o: { tag?: string, query?: string, offset?: number, limit?: number } = {}): Promise<{ total: number, items: EntryListItem[], tags: TagCount[] }> {
    const db = await this.dbOf(id)
    const limit = Number.isFinite(o.limit) ? Math.min(200, Math.max(1, Math.floor(o.limit!))) : 50
    const offset = Number.isFinite(o.offset) ? Math.max(0, Math.floor(o.offset!)) : 0
    const tag = typeof o.tag === 'string' ? o.tag.trim() : ''
    const query = typeof o.query === 'string' ? o.query.trim().slice(0, 200) : ''
    const { total, rows } = db.listEntries({ tag: tag || undefined, query: query || undefined, offset, limit })
    // `tags` = entry-level tags of all live entries (not narrowed by tag / query), for the filter of the entry list.
    return { total, items: rows, tags: db.entryTagCounts() }
  }

  async getEntry(id: string, docId: number): Promise<EntryView> {
    const db = await this.dbOf(id)
    return this.entryView(db, this.liveEntry(db, docId))
  }

  async addEntry(id: string, input: { title?: unknown, body?: unknown, tags?: unknown }, actor: string): Promise<EntryView> {
    const base = this.base(id)
    if (!isObj(input)) throw new KbError('bad-body')
    const title = cleanTitle(input.title)
    const body = cleanBody(input.body)
    const tags = input.tags === undefined ? [] : cleanEntryTags(input.tags)
    const db = await this.writable(id)
    const chunks = this.entryChunks(base, title, body, tags)
    if (!chunks.length) throw new KbError('no-text')
    const now = this.now()
    const who = actorOf(actor)
    const docId = db.transaction(() => {
      const docId = db.insertDocument({
        name: title, source: 'entry', size: Buffer.byteLength(body, 'utf8'), sha256: sha256Hex(new TextEncoder().encode(body)),
        mtime: now, addedAt: now, raw: body, kind: 'entry', entryTags: tags, updatedAt: now,
      }, chunks)
      db.insertVersion(docId, { version: 1, op: 'create', title, body, tags, actor: who, at: now })
      db.insertChange({ at: now, actor: who, op: 'create', kind: 'entry', docId, version: 1, name: title })
      return docId
    })
    this.queueImport(db, id, docId, title)
    return this.entryView(db, db.getDocument(docId)!)
  }

  async updateEntry(id: string, docId: number, input: { baseVersion?: unknown, title?: unknown, body?: unknown, tags?: unknown }, actor: string): Promise<EntryView> {
    const base = this.base(id)
    if (!isObj(input)) throw new KbError('bad-body')
    const bv = baseVersionOf(input.baseVersion)
    if (input.title === undefined && input.body === undefined && input.tags === undefined) throw new KbError('bad-body')
    const title = input.title === undefined ? undefined : cleanTitle(input.title)
    const body = input.body === undefined ? undefined : cleanBody(input.body)
    const tags = input.tags === undefined ? undefined : cleanEntryTags(input.tags)
    const who = actorOf(actor)
    const view = await this.guarded(id, docId, bv, (db, row) => {
      const next = { title: title ?? row.name, body: body ?? db.getRaw(docId) ?? '', tags: tags ?? row.entryTags ?? [] }
      const chunks = this.entryChunks(base, next.title, next.body, next.tags)
      if (!chunks.length) throw new KbError('no-text')
      const now = this.now()
      const version = row.version + 1
      db.transaction(() => {
        db.setEntryContent(docId, { ...next, version, now })
        db.replaceChunks(docId, chunks)
        db.insertVersion(docId, { version, op: 'update', ...next, actor: who, at: now })
        db.insertChange({ at: now, actor: who, op: 'update', kind: 'entry', docId, version, name: next.title })
      })
      return this.entryView(db, db.getDocument(docId)!)
    })
    this.queueImport(await this.db(id), id, docId, view.title)
    return view
  }

  /** Move an entry to the trash (a new version with the content unchanged and op `delete`). */
  async deleteEntry(id: string, docId: number, input: { baseVersion?: unknown }, actor: string): Promise<void> {
    if (!isObj(input)) throw new KbError('bad-body')
    const who = actorOf(actor)
    await this.guarded(id, docId, input.baseVersion, (db, row) => {
      const now = this.now()
      const version = row.version + 1
      db.transaction(() => {
        db.setEntryVersion(docId, version, now)
        db.insertVersion(docId, { version, op: 'delete', title: row.name, body: db.getRaw(docId) ?? '', tags: row.entryTags ?? [], actor: who, at: now })
        db.trashDocument(docId, now)
        db.insertChange({ at: now, actor: who, op: 'delete', kind: 'entry', docId, version, name: row.name })
      })
    })
    this.changed()
  }

  /** A new version with the content of `toVersion` (the history is kept). */
  async revertEntry(id: string, docId: number, input: { baseVersion?: unknown, toVersion?: unknown }, actor: string): Promise<EntryView> {
    const base = this.base(id)
    if (!isObj(input)) throw new KbError('bad-body')
    if (typeof input.toVersion !== 'number' || !Number.isInteger(input.toVersion)) throw new KbError('version-not-found')
    const toVersion = input.toVersion
    const who = actorOf(actor)
    const view = await this.guarded(id, docId, input.baseVersion, (db, row) => {
      const old = db.getVersion(docId, toVersion)
      if (!old) throw new KbError('version-not-found', String(toVersion))
      const chunks = this.entryChunks(base, old.title, old.body, old.tags)
      if (!chunks.length) throw new KbError('no-text')
      const now = this.now()
      const version = row.version + 1
      db.transaction(() => {
        db.setEntryContent(docId, { title: old.title, body: old.body, tags: old.tags, version, now })
        db.replaceChunks(docId, chunks)
        db.insertVersion(docId, { version, op: 'revert', title: old.title, body: old.body, tags: old.tags, actor: who, at: now })
        db.insertChange({ at: now, actor: who, op: 'revert', kind: 'entry', docId, version, name: old.title })
      })
      return this.entryView(db, db.getDocument(docId)!)
    })
    this.queueImport(await this.db(id), id, docId, view.title)
    return view
  }

  private anyEntry(db: KbDb, docId: number): DocRow {
    const d = Number.isInteger(docId) ? db.getDocument(docId) : undefined
    if (!d || d.kind !== 'entry') throw new KbError('entry-not-found')
    return d
  }

  /** Newest first. An entry in the trash still has its history. */
  async entryHistory(id: string, docId: number): Promise<Array<Omit<VersionRow, 'body'> & { bodyLength: number }>> {
    const db = await this.dbOf(id)
    this.anyEntry(db, docId)
    return db.listVersions(docId)
  }

  async entryVersion(id: string, docId: number, version: number): Promise<VersionRow> {
    const db = await this.dbOf(id)
    this.anyEntry(db, docId)
    const v = Number.isInteger(version) ? db.getVersion(docId, version) : undefined
    if (!v) throw new KbError('version-not-found', String(version))
    return v
  }

  // ---- trash and change log (decision 69) ----

  async listTrash(id: string): Promise<TrashItem[]> {
    const db = await this.dbOf(id)
    return db.listTrash().map(d => ({
      id: d.id, kind: d.kind, name: d.name, deletedAt: d.deletedAt!, version: d.kind === 'entry' ? d.version : null, size: d.size,
    }))
  }

  /** Take a document out of the trash: it is chunked again from its stored text and embedded in the background. */
  async restore(id: string, docId: number, actor: string): Promise<void> {
    const base = this.base(id)
    const db = await this.writable(id)
    const trashed = (): DocRow => {
      const d = Number.isInteger(docId) ? db.getDocument(docId) : undefined
      if (!d) throw new KbError('doc-not-found')
      if (d.deletedAt === null) throw new KbError('not-in-trash')
      return d
    }
    trashed()
    await this.cancelJobs(j => j.kbId === id && j.docId === docId)
    if (this.hasReindex(id)) throw new KbError('busy')
    const d = trashed()
    const raw = db.getRaw(docId)
    if (raw === null) throw new KbError('no-raw')
    // A source whose twin was uploaded meanwhile would be a duplicate.
    if (d.kind === 'source' && db.findBySha(d.sha256)) throw new KbError('duplicate')
    const kind = SUPPORTED[extOf(d.name)] ?? 'txt'
    const chunks = d.kind === 'entry'
      ? this.entryChunks(base, d.name, raw, d.entryTags ?? [])
      : chunkText(raw, { kind, chunkSize: base.chunkSize, overlap: base.chunkOverlap })
    const now = this.now()
    const who = actorOf(actor)
    db.transaction(() => {
      db.untrashDocument(docId, chunks)
      if (d.kind === 'entry') {
        const version = d.version + 1
        db.setEntryVersion(docId, version, now)
        db.insertVersion(docId, { version, op: 'restore', title: d.name, body: raw, tags: d.entryTags ?? [], actor: who, at: now })
        db.insertChange({ at: now, actor: who, op: 'restore', kind: 'entry', docId, version, name: d.name })
      } else {
        db.insertChange({ at: now, actor: who, op: 'restore', kind: 'source', docId, version: null, name: d.name })
      }
    })
    this.queueImport(db, id, docId, d.name)
  }

  /** Delete a document in the trash for good (with the history of an entry). */
  async purge(id: string, docId: number, actor: string): Promise<void> {
    const db = await this.writable(id)
    const d = Number.isInteger(docId) ? db.getDocument(docId) : undefined
    if (!d) throw new KbError('doc-not-found')
    if (d.deletedAt === null) throw new KbError('not-in-trash')
    const now = this.now()
    db.transaction(() => {
      db.deleteDocument(docId)
      db.insertChange({ at: now, actor: actorOf(actor), op: 'purge', kind: d.kind, docId, version: d.kind === 'entry' ? d.version : null, name: d.name })
    })
    this.changed()
  }

  /** The change log, newest first; `before` = a change id (only older ones). */
  async changes(id: string, o: { limit?: number, before?: number } = {}): Promise<ChangeRow[]> {
    const db = await this.dbOf(id)
    const limit = Number.isFinite(o.limit) ? Math.min(500, Math.max(1, Math.floor(o.limit!))) : 100
    const before = Number.isFinite(o.before) ? Math.floor(o.before!) : undefined
    return db.listChanges(limit, before)
  }

  // ---- usage guide (decision 69) ----

  /** The text the model is told how to use this knowledge base: the custom one, or the default of the interface language. */
  guide(id: string): GuideView {
    const custom = this.base(id).guide
    const guide = custom === '' ? t.kb.defaultGuide : custom
    return { guide, custom, isDefault: custom === '', rev: guideRev(guide) }
  }

  // ---- search ----

  /** Tags with their chunk counts over these knowledge bases (null = all), sorted by tag. */
  async tags(kbIds: readonly string[] | null): Promise<TagCount[]> {
    const targets = kbIds ? [...new Set(kbIds)].map(id => this.base(id)) : this.bases()
    const sum = new Map<string, number>()
    for (const b of targets) for (const r of (await this.db(b.id)).listTags()) sum.set(r.tag, (sum.get(r.tag) ?? 0) + r.count)
    return [...sum].map(([tag, count]) => ({ tag, count })).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  }

  /**
   * Hybrid search. `tags` and `minSimilarity` (decision 65 ⑭) narrow it: tags are applied inside both searches before
   * their candidate limit; the similarity threshold is applied to the candidates before fusion.
   */
  async search(kbIds: readonly string[] | null, query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const q = String(query ?? '').trim().slice(0, MAX_QUERY_CHARS)
    if (!q) throw new KbError('empty-query')
    const topK = Number.isFinite(opts.topK) ? Math.min(MAX_TOP_K, Math.max(1, Math.floor(opts.topK!))) : DEFAULT_TOP_K
    // Each search must be able to supply topK hits, so the candidate pool grows with it.
    const candidates = Math.max(MIN_CANDIDATES, topK)
    const tags = dedupeTags(Array.isArray(opts.tags) ? opts.tags.filter((x): x is string => typeof x === 'string') : [], MAX_FILTER_TAGS)
    const minSim = cleanSimilarity(opts.minSimilarity)
    const targets = kbIds ? [...new Set(kbIds)].map(id => this.base(id)) : this.bases()
    const model = this.o.embedder.name()
    const dbs = new Map<string, KbDb>()
    for (const b of targets) dbs.set(b.id, await this.db(b.id))

    // The query vector is made once, and only when some knowledge base could use it.
    let qvec: Float32Array | null = null
    let vectorError = false
    if (model && targets.some(b => b.embedding.model === model && dbs.get(b.id)!.countVectors() > 0)) {
      try {
        qvec = (await this.o.embedder.embed([q], AbortSignal.timeout(60_000)))[0] ?? null
      } catch (e) {
        vectorError = true
        this.log(`search: the embedding engine failed, keyword only (${(e as Error).message})`)
      }
    }

    const match = ftsMatch(q)
    const reindexKbIds: string[] = []
    const kw: Array<{ key: string, kbId: string, chunkId: number, bm25: number }> = []
    const vec: Array<{ key: string, kbId: string, chunkId: number, sim: number }> = []
    const usedVector = new Set<string>()
    for (const b of targets) {
      const db = dbs.get(b.id)!
      const vectorsMatch = !!model && b.embedding.model === model
      if (this.needsReindex(b, db) || (qvec && vectorsMatch && b.embedding.dims !== qvec.length && db.countChunks() > 0)) reindexKbIds.push(b.id)
      // With tags a knowledge base without a matching chunk has nothing to give: neither search runs.
      const allow = tags.length ? db.chunkIdsWithTags(tags) : undefined
      if (allow && allow.size === 0) continue
      const kbKw = match ? db.keywordSearch(match, candidates, tags) : []
      if (qvec && vectorsMatch && b.embedding.dims === qvec.length) {
        usedVector.add(b.id)
        let kbVec = db.vectorSearch(qvec, candidates, allow)
        let kbKwKept = kbKw
        if (minSim !== null) {
          // Below the threshold is out; a keyword hit stays only when the vector search ranked it at or above it.
          kbVec = kbVec.filter(r => r.sim >= minSim)
          const ok = new Set(kbVec.map(r => r.chunkId))
          kbKwKept = kbKw.filter(r => ok.has(r.chunkId))
        }
        for (const r of kbVec) vec.push({ key: `${b.id}:${r.chunkId}`, kbId: b.id, chunkId: r.chunkId, sim: r.sim })
        for (const r of kbKwKept) kw.push({ key: `${b.id}:${r.chunkId}`, kbId: b.id, chunkId: r.chunkId, bm25: r.bm25 })
      } else {
        for (const r of kbKw) kw.push({ key: `${b.id}:${r.chunkId}`, kbId: b.id, chunkId: r.chunkId, bm25: r.bm25 })
      }
    }
    kw.sort((a, b) => a.bm25 - b.bm25)
    vec.sort((a, b) => b.sim - a.sim)
    const kwTop = kw.slice(0, candidates)
    const vecTop = vec.slice(0, candidates)
    const fused = fuseRrf([kwTop.map(x => x.key), vecTop.map(x => x.key)]).slice(0, topK)
    const bm25 = new Map(kwTop.map(x => [x.key, x.bm25]))
    const sim = new Map(vecTop.map(x => [x.key, x.sim]))

    const byKb = new Map<string, number[]>()
    for (const f of fused) {
      const sep = f.key.lastIndexOf(':')
      const kbId = f.key.slice(0, sep)
      byKb.set(kbId, [...(byKb.get(kbId) ?? []), Number(f.key.slice(sep + 1))])
    }
    const chunks = new Map<string, ChunkHit>()
    for (const [kbId, ids] of byKb) for (const c of dbs.get(kbId)!.chunksByIds(ids)) chunks.set(`${kbId}:${c.chunkId}`, c)
    const names = new Map(targets.map(b => [b.id, b.name]))
    const hits: SearchHit[] = []
    for (const f of fused) {
      const c = chunks.get(f.key)
      if (!c) continue // removed meanwhile
      const kbId = f.key.slice(0, f.key.lastIndexOf(':'))
      hits.push({
        kbId, kbName: names.get(kbId) ?? kbId, docId: c.docId, docName: c.docName, kind: c.kind, entryVersion: c.entryVersion, chunkId: c.chunkId, text: c.text,
        startLine: c.startLine, startChar: c.startChar, endChar: c.endChar, headingPath: c.headingPath,
        score: f.score, bm25: bm25.get(f.key) ?? null, similarity: sim.get(f.key) ?? null,
        mode: usedVector.has(kbId) ? 'hybrid' : 'keyword',
      })
    }
    return { hits, mode: usedVector.size > 0 ? 'hybrid' : 'keyword', reindexNeeded: reindexKbIds.length > 0, reindexKbIds, vectorError }
  }

  // ---- jobs ----

  /**
   * Re-chunk the documents that have their text stored (with the knowledge base's current chunk settings, so tag lines
   * are picked up), re-embed every chunk with the current engine, then record the engine's model and dimensions.
   */
  async reindex(id: string): Promise<void> {
    const db = await this.dbOf(id)
    if (!this.o.embedder.name()) throw new KbError('engine-off')
    if (this.hasReindex(id)) return
    this.enqueue({ kind: 'reindex', kbId: id, docId: null, name: this.base(id).name, total: db.countChunks(), run: j => this.runReindex(j) })
  }

  private hasReindex(id: string): boolean {
    return this.queue.some(j => j.kbId === id && j.kind === 'reindex') || (this.current?.kbId === id && this.current.kind === 'reindex')
  }

  liveView(): KbLiveState {
    return {
      jobs: [...(this.current ? [this.current] : []), ...this.queue].map(j => ({
        kind: j.kind, kbId: j.kbId, docId: j.docId, name: j.name, state: j.state, done: j.done, total: j.total,
      })),
    }
  }

  /** Resolves when no job is queued or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining || this.queue.length) {
      if (!this.draining) this.drain()
      await this.draining
    }
  }

  private enqueue(spec: Pick<Job, 'kind' | 'kbId' | 'docId' | 'name' | 'total' | 'run'>) {
    let finish!: () => void
    const finished = new Promise<void>(r => { finish = r })
    this.queue.push({ ...spec, state: 'queued', done: 0, ac: new AbortController(), finished, finish })
    this.changed()
    this.drain()
  }

  private drain() {
    if (this.draining || this.closed) return
    this.draining = (async () => {
      await Promise.resolve() // the field is assigned before the body can finish
      try {
        while (this.queue.length && !this.closed) {
          const job = this.queue.shift()!
          this.current = job
          job.state = 'running'
          this.changed()
          try {
            if (this.bases().some(b => b.id === job.kbId)) await job.run(job)
          } catch (e) {
            this.log(`${job.kind} of ${job.name} failed: ${(e as Error)?.message ?? e}`)
          } finally {
            this.current = null
            job.finish()
            this.changed()
          }
        }
      } finally {
        this.draining = null
      }
    })()
  }

  /** Abort and wait for the jobs that match; queued ones are dropped. */
  private async cancelJobs(match: (j: Job) => boolean) {
    const dropped = this.queue.filter(match)
    this.queue = this.queue.filter(j => !match(j))
    for (const j of dropped) j.finish()
    const cur = this.current
    if (cur && match(cur)) {
      cur.ac.abort()
      await cur.finished
    }
    this.changed()
  }

  private async embedChunks(db: KbDb, job: Job, docId: number | null, signal: AbortSignal): Promise<number | null> {
    let after = 0
    let dims: number | null = null
    for (;;) {
      signal.throwIfAborted()
      const batch = db.chunkBatch(docId, after, this.batch)
      if (!batch.length) break
      const vecs = await this.o.embedder.embed(batch.map(b => b.text), signal)
      if (vecs.length !== batch.length) throw new KbError('embed-failed', 'unexpected response')
      dims ??= vecs[0]!.length
      if (vecs.some(v => v.length !== dims)) throw new KbError('embed-failed', 'inconsistent dimensions')
      signal.throwIfAborted()
      db.putVectors(batch.map((b, i) => ({ chunkId: b.id, vec: vecs[i]! })))
      after = batch[batch.length - 1]!.id
      job.done += batch.length
      this.changed()
    }
    return dims
  }

  private setModel(id: string, model: string | null, dims: number | null) {
    this.o.store.update((draft) => {
      const b = draft.bases.find(x => x.id === id)
      if (b) b.embedding = { model, dims }
    })
  }

  private failure(e: unknown): { code: string, detail: string } {
    return e instanceof KbError ? { code: e.code, detail: e.detail } : { code: 'embed-failed', detail: (e as Error)?.message ?? String(e) }
  }

  private async runImport(job: Job): Promise<void> {
    const docId = job.docId!
    const db = await this.db(job.kbId)
    const set = (s: DocStatus, code: string | null = null, detail: string | null = null) => {
      if (db.getDocument(docId)) db.setDocStatus(docId, s, code, detail)
    }
    const model = this.o.embedder.name()
    if (!model) return set('keyword-only', 'no-engine')
    const base = this.base(job.kbId)
    if (base.embedding.model !== null && base.embedding.model !== model) return set('keyword-only', 'model-mismatch', `${base.embedding.model} / ${model}`)
    try {
      const dims = await this.embedChunks(db, job, docId, job.ac.signal)
      if (!db.getDocument(docId)) return
      if (base.embedding.dims !== null && dims !== null && base.embedding.dims !== dims) {
        db.deleteVectorsOfDoc(docId)
        return set('keyword-only', 'dims-mismatch', `${base.embedding.dims} / ${dims}`)
      }
      if (base.embedding.model === null && dims !== null) this.setModel(job.kbId, model, dims)
      set('ready')
    } catch (e) {
      // Aborted by a delete: the document is gone. Aborted by shutdown: it stays `indexing` and is fixed by recover().
      if (isAbort(e, job.ac.signal)) return
      if (db.getDocument(docId)) db.deleteVectorsOfDoc(docId)
      const f = this.failure(e)
      set('failed', f.code, f.detail)
    }
  }

  /**
   * Chunk the stored text of every live document that has one again (trashed ones have no chunks); documents without
   * text keep their chunks. An entry is always Markdown (it has no file extension) and carries its entry tags.
   */
  private rechunk(db: KbDb, base: KnowledgeBase) {
    for (const d of db.listLiveDocuments()) {
      const raw = d.hasRaw ? db.getRaw(d.id) : null
      if (raw === null) continue
      if (d.kind === 'entry') {
        db.replaceChunks(d.id, this.entryChunks(base, d.name, raw, d.entryTags ?? []))
        continue
      }
      const kind = SUPPORTED[extOf(d.name)]
      if (!kind) continue
      db.replaceChunks(d.id, chunkText(raw, { kind, chunkSize: base.chunkSize, overlap: base.chunkOverlap }))
    }
  }

  private async runReindex(job: Job): Promise<void> {
    const db = await this.db(job.kbId)
    const model = this.o.embedder.name()
    if (!model) return
    // While the vectors are rebuilt the knowledge base records no model: invariant "no model recorded = no usable vectors".
    this.setModel(job.kbId, null, null)
    db.clearVectors()
    db.setAllDocStatus('indexing')
    job.total = db.countChunks()
    this.changed()
    try {
      this.rechunk(db, this.base(job.kbId))
      job.total = db.countChunks()
      this.changed()
      const dims = await this.embedChunks(db, job, null, job.ac.signal)
      if (dims !== null) this.setModel(job.kbId, model, dims)
      db.setAllDocStatus('ready')
    } catch (e) {
      if (isAbort(e, job.ac.signal)) {
        // Shutdown (a delete of the whole knowledge base also lands here): recover() finishes the clean-up.
        return
      }
      db.clearVectors()
      const f = this.failure(e)
      db.setAllDocStatus('failed', f.code, f.detail)
    }
  }

  /**
   * Startup: a document left `indexing` by a stop in the middle of embedding is marked `keyword-only` (its partial
   * vectors are dropped; when the knowledge base records no model all vectors are dropped), so a re-index fixes it.
   */
  async recover(): Promise<void> {
    for (const b of this.bases()) {
      try {
        const db = await this.db(b.id)
        const stuck = db.docIdsByStatus('indexing')
        if (!stuck.length) continue
        if (b.embedding.model === null) db.clearVectors()
        for (const id of stuck) {
          db.deleteVectorsOfDoc(id)
          db.setDocStatus(id, 'keyword-only', 'interrupted')
        }
        this.log(`${b.name}: ${stuck.length} document(s) were interrupted while indexing and are keyword-only until re-indexed`)
      } catch (e) {
        this.log(`${b.id}: could not open (${(e as Error).message})`)
      }
    }
  }

  /** Stop the jobs (documents they were embedding stay `indexing` for recover()) and close the database files. */
  async close(): Promise<void> {
    this.closed = true
    for (const j of this.queue) j.finish()
    this.queue = []
    this.current?.ac.abort()
    while (this.draining) await this.draining
    const open = [...this.dbs.values()]
    this.dbs.clear()
    for (const p of open) await p.then(d => d.close(), () => {})
  }
}
