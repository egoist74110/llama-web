// Knowledge base manager (decision 65): the registry (data/knowledge.json), one SQLite file per knowledge base, the
// import / re-index queue and hybrid search. Pure of Nitro: the registry store and the embedder are injected.
import { mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { chunkText } from './chunk'
import { decodeText } from './text'
import { ftsMatch } from './tokenize'
import { KbDb, sha256Hex, type ChunkHit, type DocRow, type DocStatus } from './kb-db'
import { KbError } from './errors'
import { applyKbEdit, createKnowledgeBase, SOFT_CHUNK_LIMIT, validKbId, type KbEdit, type KnowledgeBase, type KnowledgeDoc } from './registry'
import type { Embedder } from './embed'
import { fuseRrf } from './search'
import { cleanSimilarity, dedupeTags, MAX_FILTER_TAGS, type TagCount } from './tags'

export type { TagCount }

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const EMBED_BATCH = 32
export const DEFAULT_TOP_K = 5
export const MAX_TOP_K = 20
/** Candidates taken from each of the two searches before fusion. */
const CANDIDATES = 50
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
  docCount: number
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

export interface SearchHit {
  kbId: string
  kbName: string
  docId: number
  docName: string
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

  /** Name, description and chunking (the chunk settings apply to documents added afterwards). */
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
  async addDocument(id: string, input: AddDocumentInput): Promise<DocView> {
    const base = this.base(id)
    const name = basename(String(input.name ?? '').replace(/\\/g, '/')).trim()
    const ext = /\.[^./]+$/.exec(name)?.[0]?.toLowerCase() ?? ''
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
    const docId = db.insertDocument({
      name, source: input.source?.trim() || name, size: input.bytes.length, sha256: sha,
      mtime: Number.isFinite(input.mtime) ? Math.floor(input.mtime!) : now, addedAt: now, raw: text,
    }, chunks)
    this.enqueue({ kind: 'import', kbId: id, docId, name, total: chunks.length, run: j => this.runImport(j) })
    return this.docView(id, db.getDocument(docId)!)
  }

  async removeDocument(id: string, docId: number): Promise<void> {
    const db = await this.dbOf(id)
    if (!db.getDocument(docId)) throw new KbError('doc-not-found')
    // A re-index rewrites every vector: a document cannot go while it runs (it would leave vectors without chunks).
    if (this.hasReindex(id)) throw new KbError('busy')
    await this.cancelJobs(j => j.kbId === id && j.docId === docId)
    db.deleteDocument(docId)
    this.changed()
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
      const kbKw = match ? db.keywordSearch(match, CANDIDATES, tags) : []
      if (qvec && vectorsMatch && b.embedding.dims === qvec.length) {
        usedVector.add(b.id)
        let kbVec = db.vectorSearch(qvec, CANDIDATES, allow)
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
    const kwTop = kw.slice(0, CANDIDATES)
    const vecTop = vec.slice(0, CANDIDATES)
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
        kbId, kbName: names.get(kbId) ?? kbId, docId: c.docId, docName: c.docName, chunkId: c.chunkId, text: c.text,
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

  /** Chunk the stored text of every document that has one again; documents without text keep their chunks. */
  private rechunk(db: KbDb, base: KnowledgeBase) {
    for (const d of db.listDocuments()) {
      const kind = SUPPORTED[/\.[^./]+$/.exec(d.name)?.[0]?.toLowerCase() ?? '']
      const raw = d.hasRaw ? db.getRaw(d.id) : null
      if (raw === null || !kind) continue
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
