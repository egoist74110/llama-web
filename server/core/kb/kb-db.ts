// One knowledge base's SQLite file (decision 65 ②): documents, chunks, vectors and the FTS5 index.
//
// FTS layout: `fts` is an ordinary FTS5 table (unicode61) whose only column holds the PRE-TOKENIZED text (see
// tokenize.ts: CJK bigrams, lowercase words) and whose rowid is the chunk id. It stores its own copy of the tokens, so
// a chunk can be removed with a plain DELETE by rowid (a contentless table could not on older SQLite builds).
import { createHash } from 'node:crypto'
import { openDatabase, type SqlDatabase, type SqlValue } from './sqlite'
import { indexText } from './tokenize'
import type { Chunk } from './chunk'

export const KB_SCHEMA_VERSION = 1

export type DocStatus = 'indexing' | 'ready' | 'keyword-only' | 'failed'

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
}

export interface NewDoc {
  name: string
  source: string
  size: number
  sha256: string
  mtime: number
  addedAt: number
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
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

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
            error_detail TEXT
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
    (SELECT COUNT(*) FROM vectors v JOIN chunks c ON c.id = v.chunk_id WHERE c.doc_id = d.id) AS vectorCount
    FROM documents d`

  /** Insert a document with its chunks and FTS rows in one transaction; the status is `indexing`. */
  insertDocument(doc: NewDoc, chunks: readonly Chunk[]): number {
    return this.db.transaction(() => {
      const r = this.db.prepare(
        "INSERT INTO documents (name, source, size, sha256, mtime, added_at, chunk_count, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing')",
      ).run(doc.name, doc.source, doc.size, doc.sha256, doc.mtime, doc.addedAt, chunks.length)
      const docId = r.lastInsertRowid
      const insChunk = this.db.prepare('INSERT INTO chunks (doc_id, ord, text, start_char, end_char, start_line, heading_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const insFts = this.db.prepare('INSERT INTO fts (rowid, tokens) VALUES (?, ?)')
      for (const c of chunks) {
        const { lastInsertRowid } = insChunk.run(docId, c.ord, c.text, c.startChar, c.endChar, c.startLine, c.headingPath)
        insFts.run(lastInsertRowid, indexText(c.headingPath ? `${c.headingPath}\n${c.text}` : c.text))
      }
      return docId
    })
  }

  listDocuments(): DocRow[] {
    return this.db.prepare(`${this.docSelect} ORDER BY d.id`).all<DocRow>()
  }

  getDocument(id: number): DocRow | undefined {
    return this.db.prepare(`${this.docSelect} WHERE d.id = ?`).get<DocRow>(id)
  }

  findBySha(sha256: string): DocRow | undefined {
    return this.db.prepare(`${this.docSelect} WHERE d.sha256 = ? LIMIT 1`).get<DocRow>(sha256)
  }

  /** Remove a document with its chunks, vectors and FTS rows in one transaction. */
  deleteDocument(id: number): boolean {
    const removed = this.db.transaction(() => {
      this.db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(id)
      this.db.prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)').run(id)
      this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id)
      return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0
    })
    this.cache = null
    return removed
  }

  setDocStatus(id: number, status: DocStatus, code: string | null = null, detail: string | null = null) {
    this.db.prepare('UPDATE documents SET status = ?, error_code = ?, error_detail = ? WHERE id = ?').run(status, code, detail, id)
  }

  setAllDocStatus(status: DocStatus, code: string | null = null, detail: string | null = null) {
    this.db.prepare('UPDATE documents SET status = ?, error_code = ?, error_detail = ?').run(status, code, detail)
  }

  docIdsByStatus(status: DocStatus): number[] {
    return this.db.prepare('SELECT id FROM documents WHERE status = ? ORDER BY id').all<{ id: number }>(status).map(r => r.id)
  }

  // ---- chunks ----

  countChunks(docId: number | null = null): number {
    const r = docId === null
      ? this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get<{ n: number }>()
      : this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get<{ n: number }>(docId)
    return r?.n ?? 0
  }

  countDocuments(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM documents').get<{ n: number }>()?.n ?? 0
  }

  /** Documents without vectors that no job is working on: `keyword-only` or `failed`. */
  countUnindexed(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status IN ('keyword-only', 'failed')").get<{ n: number }>()?.n ?? 0
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
        c.start_line AS startLine, c.heading_path AS headingPath
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

  /** Top `limit` chunks by cosine similarity (vectors are stored normalized; `query` must be too). */
  vectorSearch(query: Float32Array, limit: number): Array<{ chunkId: number, sim: number }> {
    const { ids, dims, data } = this.loadVectors()
    if (!ids.length || dims !== query.length) return []
    const top: Array<{ chunkId: number, sim: number }> = []
    for (let i = 0; i < ids.length; i++) {
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

  /** BM25 (more negative = better) over an FTS5 MATCH expression built by `ftsMatch`. */
  keywordSearch(match: string, limit: number): Array<{ chunkId: number, bm25: number }> {
    return this.db.prepare('SELECT rowid AS chunkId, bm25(fts) AS bm25 FROM fts WHERE fts MATCH ? ORDER BY bm25 LIMIT ?').all(match, limit)
  }
}
