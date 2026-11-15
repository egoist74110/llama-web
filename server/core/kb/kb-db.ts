// One knowledge base's SQLite file (decision 65 ②): documents, chunks, vectors and the FTS5 index.
//
// FTS layout: `fts` is an ordinary FTS5 table (unicode61) whose only column holds the PRE-TOKENIZED text (see
// tokenize.ts: CJK bigrams, lowercase words) and whose rowid is the chunk id. It stores its own copy of the tokens, so
// a chunk can be removed with a plain DELETE by rowid (a contentless table could not on older SQLite builds).
import { createHash } from 'node:crypto'
import { openDatabase, type SqlDatabase, type SqlValue } from './sqlite'
import { indexText } from './tokenize'
import type { Chunk } from './chunk'

export const KB_SCHEMA_VERSION = 3

/** Tables added by schema 3 (shared by a new file and the 2 -> 3 migration). */
const V3_TABLES = `
  CREATE TABLE entry_versions (
    doc_id INTEGER NOT NULL, version INTEGER NOT NULL,
    op TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL,
    actor TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, version)) WITHOUT ROWID;
  CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
    op TEXT NOT NULL,
    kind TEXT NOT NULL,
    doc_id INTEGER NOT NULL, version INTEGER, name TEXT NOT NULL);
  CREATE INDEX changes_doc ON changes (doc_id, id);
`

export type DocStatus = 'indexing' | 'ready' | 'keyword-only' | 'failed'
/** A source is an uploaded / added text that is never edited; an entry is an editable, versioned note (decision 69). */
export type DocKind = 'source' | 'entry'
export type EntryOp = 'create' | 'update' | 'delete' | 'restore' | 'revert'

export interface DocRow {
  id: number
  name: string
  source: string
  size: number
  sha256: string
  mtime: number
  addedAt: number
  chunkCount: number
  status: DocStatus
  errorCode: string | null
  errorDetail: string | null
  /** Chunks of this document that have a vector. */
  vectorCount: number
  /** The decoded text is stored (schema 2): the document can be re-chunked and tags work. False for older documents. */
  hasRaw: boolean
  /** Tags that occur in the document's chunks, sorted, at most DOC_TAG_LIMIT. */
  tags: string[]
  kind: DocKind
  /** Entries: the current version; sources: 1. */
  version: number
  /** Entries: the entry-level tags; sources: null. */
  entryTags: string[] | null
  /** Entries: time of the last write; sources: null. */
  updatedAt: number | null
  /** Set = the document is in the trash (no chunks, raw kept). */
  deletedAt: number | null
}

const DOC_TAG_LIMIT = 20

export interface NewDoc {
  name: string
  source: string
  size: number
  sha256: string
  mtime: number
  addedAt: number
  /** The decoded text of the file (entries: the body). */
  raw: string
  /** Default 'source'. */
  kind?: DocKind
  /** Entries only. */
  entryTags?: readonly string[]
  /** Entries only: time of the last write. */
  updatedAt?: number
}

export interface EntryRow {
  id: number
  title: string
  tags: string[]
  version: number
  updatedAt: number
  status: DocStatus
  preview: string
}

export interface VersionRow {
  version: number
  op: EntryOp
  title: string
  body: string
  tags: string[]
  actor: string
  at: number
}

export type ChangeOp = EntryOp | 'purge' | 'add'
export interface ChangeRow {
  id: number
  at: number
  actor: string
  op: ChangeOp
  kind: DocKind
  docId: number
  version: number | null
  name: string
}

export interface ChunkHit {
  chunkId: number
  docId: number
  docName: string
  text: string
  startChar: number
  endChar: number
  startLine: number
  headingPath: string
  kind: DocKind
  /** Entries: the current version; sources: null. */
  entryVersion: number | null
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function parseTags(json: string | null): string[] {
  try {
    const v = json ? JSON.parse(json) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/** Escape the LIKE wildcards and the escape character (backslash) of a pattern used with ESCAPE. */
const likeEscape = (v: string) => v.replace(/[\\%_]/g, m => '\\' + m)

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)

function fromBlob(b: Uint8Array): Float32Array {
  // Copy: a view into the driver's buffer may be unaligned or reused.
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

interface VectorCache {
  ids: number[]
  dims: number
  data: Float32Array
}

export class KbDb {
  private cache: VectorCache | null = null

  private constructor(readonly file: string, private db: SqlDatabase) {}

  static async open(file: string): Promise<KbDb> {
    const db = await openDatabase(file)
    try {
      const kb = new KbDb(file, db)
      kb.migrate()
      return kb
    } catch (e) {
      db.close()
      throw e
    }
  }

  get engine() { return this.db.engine }

  private migrate() {
    const { db } = this
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get<{ value: string }>()
    const version = row ? Number(row.value) : 0
    if (version > KB_SCHEMA_VERSION) throw new Error(`knowledge base file has schema ${version}, newer than supported ${KB_SCHEMA_VERSION}`)
    if (version < 1) {
      // A new file is created at the current schema directly.
      db.transaction(() => {
        db.exec(`
          CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source TEXT NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_code TEXT,
            error_detail TEXT,
            raw TEXT,
            kind TEXT NOT NULL DEFAULT 'source',
            version INTEGER NOT NULL DEFAULT 1,
            tags TEXT,
            updated_at INTEGER,
            deleted_at INTEGER
          );
          CREATE TABLE chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            ord INTEGER NOT NULL,
            text TEXT NOT NULL,
            start_char INTEGER NOT NULL,
            end_char INTEGER NOT NULL,
            start_line INTEGER NOT NULL,
            heading_path TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX chunks_doc ON chunks (doc_id, ord);
          CREATE TABLE vectors (chunk_id INTEGER PRIMARY KEY, blob BLOB NOT NULL);
          CREATE VIRTUAL TABLE fts USING fts5(tokens, tokenize = 'unicode61 remove_diacritics 0');
          CREATE TABLE chunk_tags (chunk_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (chunk_id, tag)) WITHOUT ROWID;
          CREATE INDEX chunk_tags_tag ON chunk_tags (tag, chunk_id);
          ${V3_TABLES}
        `)
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(KB_SCHEMA_VERSION))
      })
      return
    }
    if (version < 2) {
      // 1 -> 2 (decision 65 ⑭): the decoded text of new documents (NULL = an older document, no text) and chunk tags.
      db.transaction(() => {
        db.exec(`
          ALTER TABLE documents ADD COLUMN raw TEXT;
          CREATE TABLE chunk_tags (chunk_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (chunk_id, tag)) WITHOUT ROWID;
          CREATE INDEX chunk_tags_tag ON chunk_tags (tag, chunk_id);
        `)
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '2')").run()
      })
    }
    if (version < 3) {
      // 2 -> 3 (decision 69): entries (editable, versioned), the trash (deleted_at) and the change log.
      db.transaction(() => {
        db.exec(`
          ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'source';
          ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE documents ADD COLUMN tags TEXT;
          ALTER TABLE documents ADD COLUMN updated_at INTEGER;
          ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
          ${V3_TABLES}
        `)
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(KB_SCHEMA_VERSION))
      })
    }
  }

  close() {
    this.cache = null
    this.db.close()
  }

  // ---- documents ----

  private docSelect = `SELECT d.id, d.name, d.source, d.size, d.sha256, d.mtime, d.added_at AS addedAt, d.chunk_count AS chunkCount,
    d.status, d.error_code AS errorCode, d.error_detail AS errorDetail,
    (SELECT COUNT(*) FROM vectors v JOIN chunks c ON c.id = v.chunk_id WHERE c.doc_id = d.id) AS vectorCount,
    (d.raw IS NOT NULL) AS hasRaw,
    d.kind, d.version, d.tags AS entryTagsJson, d.updated_at AS updatedAt, d.deleted_at AS deletedAt
    FROM documents d`

  private docRow(r: Omit<DocRow, 'hasRaw' | 'tags' | 'entryTags'> & { hasRaw: number, entryTagsJson: string | null }): DocRow {
    const tags = this.db.prepare(
      'SELECT DISTINCT t.tag FROM chunk_tags t JOIN chunks c ON c.id = t.chunk_id WHERE c.doc_id = ? ORDER BY t.tag LIMIT ?',
    ).all<{ tag: string }>(r.id, DOC_TAG_LIMIT).map(x => x.tag)
    const { entryTagsJson, ...rest } = r
    return { ...rest, hasRaw: !!r.hasRaw, tags, entryTags: r.kind === 'entry' ? parseTags(entryTagsJson) : null }
  }

  /** Run `fn` in one transaction (a nested call joins the outer one). */
  transaction<T>(fn: () => T): T { return this.db.transaction(fn) }

  /** Chunk rows with their FTS rows and tags (inside a transaction). The FTS text is heading path + text, no tags. */
  private insertChunks(docId: number, chunks: readonly Chunk[]) {
    const insChunk = this.db.prepare('INSERT INTO chunks (doc_id, ord, text, start_char, end_char, start_line, heading_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insFts = this.db.prepare('INSERT INTO fts (rowid, tokens) VALUES (?, ?)')
    const insTag = this.db.prepare('INSERT OR IGNORE INTO chunk_tags (chunk_id, tag) VALUES (?, ?)')
    for (const c of chunks) {
      const { lastInsertRowid } = insChunk.run(docId, c.ord, c.text, c.startChar, c.endChar, c.startLine, c.headingPath)
      insFts.run(lastInsertRowid, indexText(c.headingPath ? `${c.headingPath}\n${c.text}` : c.text))
      for (const tag of c.tags) insTag.run(lastInsertRowid, tag)
    }
  }

  private deleteChunksOf(docId: number) {
    this.db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId)
    this.db.prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId)
    this.db.prepare('DELETE FROM chunk_tags WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId)
    this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
  }

  /** Insert a document with its text, chunks, tags and FTS rows in one transaction; the status is `indexing`. */
  insertDocument(doc: NewDoc, chunks: readonly Chunk[]): number {
    return this.db.transaction(() => {
      const entry = doc.kind === 'entry'
      const r = this.db.prepare(
        "INSERT INTO documents (name, source, size, sha256, mtime, added_at, chunk_count, status, raw, kind, version, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, 1, ?, ?)",
      ).run(doc.name, doc.source, doc.size, doc.sha256, doc.mtime, doc.addedAt, chunks.length, doc.raw,
        entry ? 'entry' : 'source', entry ? JSON.stringify(doc.entryTags ?? []) : null, entry ? (doc.updatedAt ?? doc.addedAt) : null)
      const docId = r.lastInsertRowid
      this.insertChunks(docId, chunks)
      return docId
    })
  }

  /** The stored text of a document; null for a document without one (added before schema 2). */
  getRaw(docId: number): string | null {
    return this.db.prepare('SELECT raw FROM documents WHERE id = ?').get<{ raw: string | null }>(docId)?.raw ?? null
  }

  /**
   * Swap all chunks of a document for `chunks` (re-chunking): FTS rows, vectors and tags of the old ones go, and the
   * document needs new vectors afterwards. One transaction.
   */
  replaceChunks(docId: number, chunks: readonly Chunk[]) {
    this.db.transaction(() => {
      this.deleteChunksOf(docId)
      this.insertChunks(docId, chunks)
      this.db.prepare('UPDATE documents SET chunk_count = ? WHERE id = ?').run(chunks.length, docId)
    })
    this.cache = null
  }

  /** Live sources (the Docs list): entries and the trash are not in it. */
  listDocuments(): DocRow[] {
    return this.db.prepare(`${this.docSelect} WHERE d.kind = 'source' AND d.deleted_at IS NULL ORDER BY d.id`).all<any>().map(r => this.docRow(r))
  }

  /** Every live document, sources and entries (re-chunking). */
  listLiveDocuments(): DocRow[] {
    return this.db.prepare(`${this.docSelect} WHERE d.deleted_at IS NULL ORDER BY d.id`).all<any>().map(r => this.docRow(r))
  }

  /** Documents in the trash (both kinds), newest first. */
  listTrash(): DocRow[] {
    return this.db.prepare(`${this.docSelect} WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC, d.id DESC`).all<any>().map(r => this.docRow(r))
  }

  /** Any document by id, whatever its kind and whether it is in the trash. */
  getDocument(id: number): DocRow | undefined {
    const r = this.db.prepare(`${this.docSelect} WHERE d.id = ?`).get<any>(id)
    return r && this.docRow(r)
  }

  /** A live source with this hash (entries and the trash do not count). */
  findBySha(sha256: string): DocRow | undefined {
    const r = this.db.prepare(`${this.docSelect} WHERE d.sha256 = ? AND d.kind = 'source' AND d.deleted_at IS NULL LIMIT 1`).get<any>(sha256)
    return r && this.docRow(r)
  }

  /** Remove a document with its chunks, vectors, tags, FTS rows and entry versions in one transaction. */
  deleteDocument(id: number): boolean {
    const removed = this.db.transaction(() => {
      this.deleteChunksOf(id)
      this.db.prepare('DELETE FROM entry_versions WHERE doc_id = ?').run(id)
      return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0
    })
    this.cache = null
    return removed
  }

  setDocStatus(id: number, status: DocStatus, code: string | null = null, detail: string | null = null) {
    this.db.prepare('UPDATE documents SET status = ?, error_code = ?, error_detail = ? WHERE id = ?').run(status, code, detail, id)
  }

  /** Every live document (trashed ones have no chunks and keep their status). */
  setAllDocStatus(status: DocStatus, code: string | null = null, detail: string | null = null) {
    this.db.prepare('UPDATE documents SET status = ?, error_code = ?, error_detail = ? WHERE deleted_at IS NULL').run(status, code, detail)
  }

  docIdsByStatus(status: DocStatus): number[] {
    return this.db.prepare('SELECT id FROM documents WHERE status = ? AND deleted_at IS NULL ORDER BY id').all<{ id: number }>(status).map(r => r.id)
  }

  // ---- entries, trash, history (decision 69); the manager wraps the writes in `transaction` ----

  /** Live entries, newest write first. `tag` = an entry-level tag; `query` = case-insensitive substring of title or body. */
  listEntries(o: { tag?: string, query?: string, offset: number, limit: number }): { total: number, rows: EntryRow[] } {
    const where = ["d.kind = 'entry'", 'd.deleted_at IS NULL']
    const params: SqlValue[] = []
    if (o.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(d.tags) j WHERE j.value = ?)')
      params.push(o.tag)
    }
    if (o.query) {
      where.push("(d.name LIKE ? ESCAPE '\\' OR d.raw LIKE ? ESCAPE '\\')")
      const like = `%${likeEscape(o.query)}%`
      params.push(like, like)
    }
    const cond = where.join(' AND ')
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${cond}`).get<{ n: number }>(...params)?.n ?? 0
    const rows = this.db.prepare(
      `SELECT d.id, d.name AS title, d.tags AS tagsJson, d.version, COALESCE(d.updated_at, d.added_at) AS updatedAt, d.status, substr(d.raw, 1, 200) AS preview
       FROM documents d WHERE ${cond} ORDER BY COALESCE(d.updated_at, d.added_at) DESC, d.id DESC LIMIT ? OFFSET ?`,
    ).all<any>(...params, o.limit, o.offset).map((r): EntryRow => ({
      id: r.id, title: r.title, tags: parseTags(r.tagsJson), version: r.version, updatedAt: r.updatedAt, status: r.status, preview: r.preview ?? '',
    }))
    return { total, rows }
  }

  /** Entry-level tags of the live entries with the number of entries that carry each, sorted by tag (trash excluded). */
  entryTagCounts(): Array<{ tag: string, count: number }> {
    return this.db.prepare(
      "SELECT j.value AS tag, COUNT(*) AS count FROM documents d, json_each(d.tags) j WHERE d.kind = 'entry' AND d.deleted_at IS NULL GROUP BY j.value ORDER BY j.value",
    ).all()
  }

  /** Overwrite the content of an entry; it needs new chunks and vectors afterwards (status `indexing`). */
  setEntryContent(id: number, c: { title: string, body: string, tags: readonly string[], version: number, now: number }) {
    this.db.prepare(
      "UPDATE documents SET name = ?, raw = ?, size = ?, sha256 = ?, tags = ?, version = ?, updated_at = ?, mtime = ?, status = 'indexing', error_code = NULL, error_detail = NULL WHERE id = ?",
    ).run(c.title, c.body, Buffer.byteLength(c.body, 'utf8'), createHash('sha256').update(c.body, 'utf8').digest('hex'), JSON.stringify(c.tags), c.version, c.now, c.now, id)
  }

  /** A version bump without a content change (delete / restore of an entry). */
  setEntryVersion(id: number, version: number, now: number) {
    this.db.prepare('UPDATE documents SET version = ?, updated_at = ? WHERE id = ?').run(version, now, id)
  }

  insertVersion(docId: number, v: VersionRow) {
    this.db.prepare('INSERT INTO entry_versions (doc_id, version, op, title, body, tags, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(docId, v.version, v.op, v.title, v.body, JSON.stringify(v.tags), v.actor, v.at)
  }

  getVersion(docId: number, version: number): VersionRow | undefined {
    const r = this.db.prepare('SELECT version, op, title, body, tags, actor, at FROM entry_versions WHERE doc_id = ? AND version = ?').get<any>(docId, version)
    return r && { version: r.version, op: r.op, title: r.title, body: r.body, tags: parseTags(r.tags), actor: r.actor, at: r.at }
  }

  /** Newest first; `bodyLength` is in characters. */
  listVersions(docId: number): Array<Omit<VersionRow, 'body'> & { bodyLength: number }> {
    return this.db.prepare(
      'SELECT version, op, title, tags, actor, at, length(body) AS bodyLength FROM entry_versions WHERE doc_id = ? ORDER BY version DESC',
    ).all<any>(docId).map(r => ({ version: r.version, op: r.op, title: r.title, tags: parseTags(r.tags), actor: r.actor, at: r.at, bodyLength: r.bodyLength }))
  }

  insertChange(c: Omit<ChangeRow, 'id'>) {
    this.db.prepare('INSERT INTO changes (at, actor, op, kind, doc_id, version, name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.at, c.actor, c.op, c.kind, c.docId, c.version, c.name)
  }

  /** Newest first; `before` = only changes with a smaller id. */
  listChanges(limit: number, before?: number): ChangeRow[] {
    const sql = `SELECT id, at, actor, op, kind, doc_id AS docId, version, name FROM changes ${before === undefined ? '' : 'WHERE id < ?'} ORDER BY id DESC LIMIT ?`
    return before === undefined ? this.db.prepare(sql).all<ChangeRow>(limit) : this.db.prepare(sql).all<ChangeRow>(before, limit)
  }

  /** Move a document to the trash: its chunks, vectors, tags and FTS rows go, the text stays. */
  trashDocument(id: number, at: number) {
    this.db.transaction(() => {
      this.deleteChunksOf(id)
      this.db.prepare("UPDATE documents SET deleted_at = ?, chunk_count = 0, status = 'ready', error_code = NULL, error_detail = NULL WHERE id = ?").run(at, id)
    })
    this.cache = null
  }

  /** Take a document out of the trash with freshly made chunks; it needs vectors (status `indexing`). */
  untrashDocument(id: number, chunks: readonly Chunk[]) {
    this.db.transaction(() => {
      this.deleteChunksOf(id)
      this.insertChunks(id, chunks)
      this.db.prepare("UPDATE documents SET deleted_at = NULL, chunk_count = ?, status = 'indexing', error_code = NULL, error_detail = NULL WHERE id = ?").run(chunks.length, id)
    })
    this.cache = null
  }

  // ---- chunks ----

  countChunks(docId: number | null = null): number {
    const r = docId === null
      ? this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get<{ n: number }>()
      : this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get<{ n: number }>(docId)
    return r?.n ?? 0
  }

  /** Live sources. */
  countDocuments(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind = 'source' AND deleted_at IS NULL").get<{ n: number }>()?.n ?? 0
  }

  /** Live entries. */
  countEntries(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind = 'entry' AND deleted_at IS NULL").get<{ n: number }>()?.n ?? 0
  }

  countTrash(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL').get<{ n: number }>()?.n ?? 0
  }

  /** Documents without vectors that no job is working on: `keyword-only` or `failed`. */
  countUnindexed(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status IN ('keyword-only', 'failed') AND deleted_at IS NULL").get<{ n: number }>()?.n ?? 0
  }

  /** Chunks after `afterId` (one document, or all) for embedding. */
  chunkBatch(docId: number | null, afterId: number, limit: number): Array<{ id: number, text: string }> {
    return docId === null
      ? this.db.prepare('SELECT id, text FROM chunks WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit)
      : this.db.prepare('SELECT id, text FROM chunks WHERE doc_id = ? AND id > ? ORDER BY id LIMIT ?').all(docId, afterId, limit)
  }

  chunksByIds(ids: readonly number[]): ChunkHit[] {
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return this.db.prepare(
      `SELECT c.id AS chunkId, c.doc_id AS docId, d.name AS docName, c.text, c.start_char AS startChar, c.end_char AS endChar,
        c.start_line AS startLine, c.heading_path AS headingPath, d.kind AS kind,
        CASE WHEN d.kind = 'entry' THEN d.version ELSE NULL END AS entryVersion
       FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${marks})`,
    ).all<ChunkHit>(...ids)
  }

  // ---- vectors ----

  putVectors(rows: ReadonlyArray<{ chunkId: number, vec: Float32Array }>) {
    this.db.transaction(() => {
      const st = this.db.prepare('INSERT OR REPLACE INTO vectors (chunk_id, blob) VALUES (?, ?)')
      for (const r of rows) st.run(r.chunkId, toBlob(r.vec) as SqlValue)
    })
    this.cache = null
  }

  deleteVectorsOfDoc(docId: number) {
    this.db.prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId)
    this.cache = null
  }

  clearVectors() {
    this.db.exec('DELETE FROM vectors')
    this.cache = null
  }

  countVectors(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get<{ n: number }>()?.n ?? 0
  }

  private loadVectors(): VectorCache {
    if (this.cache) return this.cache
    const rows = this.db.prepare('SELECT chunk_id AS id, blob FROM vectors ORDER BY chunk_id').all<{ id: number, blob: Uint8Array }>()
    let dims = 0
    const ids: number[] = []
    const parts: Float32Array[] = []
    for (const r of rows) {
      const v = fromBlob(r.blob)
      if (!dims) dims = v.length
      if (v.length !== dims) continue // defensive: a stray vector of another size is never compared
      ids.push(r.id)
      parts.push(v)
    }
    const data = new Float32Array(ids.length * dims)
    parts.forEach((v, i) => data.set(v, i * dims))
    return (this.cache = { ids, dims, data })
  }

  /**
   * Top `limit` chunks by cosine similarity (vectors are stored normalized; `query` must be too). `allow` = only these
   * chunk ids take part (checked before ranking, so the limit applies to the allowed ones); undefined = all.
   */
  vectorSearch(query: Float32Array, limit: number, allow?: ReadonlySet<number>): Array<{ chunkId: number, sim: number }> {
    const { ids, dims, data } = this.loadVectors()
    if (!ids.length || dims !== query.length) return []
    const top: Array<{ chunkId: number, sim: number }> = []
    for (let i = 0; i < ids.length; i++) {
      if (allow && !allow.has(ids[i]!)) continue
      let dot = 0
      const base = i * dims
      for (let j = 0; j < dims; j++) dot += data[base + j]! * query[j]!
      if (top.length >= limit && dot <= top[top.length - 1]!.sim) continue
      let k = top.length
      while (k > 0 && top[k - 1]!.sim < dot) k--
      top.splice(k, 0, { chunkId: ids[i]!, sim: dot })
      if (top.length > limit) top.pop()
    }
    return top
  }

  // ---- keyword search ----

  /**
   * BM25 (more negative = better) over an FTS5 MATCH expression built by `ftsMatch`. With `tags` only chunks that carry
   * any of them are ranked: the filter is part of the query, so it applies before LIMIT.
   */
  keywordSearch(match: string, limit: number, tags?: readonly string[]): Array<{ chunkId: number, bm25: number }> {
    if (!tags?.length) return this.db.prepare('SELECT rowid AS chunkId, bm25(fts) AS bm25 FROM fts WHERE fts MATCH ? ORDER BY bm25 LIMIT ?').all(match, limit)
    const marks = tags.map(() => '?').join(',')
    return this.db.prepare(
      `SELECT rowid AS chunkId, bm25(fts) AS bm25 FROM fts WHERE fts MATCH ? AND rowid IN (SELECT chunk_id FROM chunk_tags WHERE tag IN (${marks})) ORDER BY bm25 LIMIT ?`,
    ).all(match, ...tags, limit)
  }

  // ---- tags ----

  /** Every tag with the number of chunks that carry it, sorted by tag. */
  listTags(): Array<{ tag: string, count: number }> {
    return this.db.prepare('SELECT tag, COUNT(*) AS count FROM chunk_tags GROUP BY tag ORDER BY tag').all()
  }

  /** Ids of the chunks that carry any of `tags`. */
  chunkIdsWithTags(tags: readonly string[]): Set<number> {
    if (!tags.length) return new Set()
    const marks = tags.map(() => '?').join(',')
    return new Set(this.db.prepare(`SELECT DISTINCT chunk_id AS id FROM chunk_tags WHERE tag IN (${marks})`).all<{ id: number }>(...tags).map(r => r.id))
  }
}
