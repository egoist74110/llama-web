// Knowledge base storage and retrieval (decision 65 ② ④ ⑤): registry, SQLite files, import jobs and hybrid search,
// with a fake embedder (deterministic bag-of-words vectors). Temp directories only.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../../server/core/store'
import { KbError } from '../../server/core/kb/errors'
import { KbManager, MAX_UPLOAD_BYTES } from '../../server/core/kb/manager'
import { KbDb } from '../../server/core/kb/kb-db'
import { openDatabase } from '../../server/core/kb/sqlite'
import { normalizeVector, type Embedder } from '../../server/core/kb/embed'
import { tokenize } from '../../server/core/kb/tokenize'
import {
  applyKbEdit, createKnowledgeBase, defaultKnowledge, KNOWLEDGE_VERSION, normalizeKnowledge, type KnowledgeBase, type KnowledgeDoc,
} from '../../server/core/kb/registry'

const dirs: string[] = []
const managers: KbManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'llama-web-kb-'))
  dirs.push(d)
  return d
}

const DIMS = 32
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const textVector = (t: string) => {
  const v = new Array<number>(DIMS).fill(0)
  for (const tok of tokenize(t)) v[hash(tok) % DIMS]! += 1
  return normalizeVector(v)
}

interface Fake extends Embedder {
  model: string | null
  fail: boolean
  calls: number
  dims: number
  /** When set, embed() waits for this promise (or the abort signal). */
  gate: Promise<void> | null
}
function fake(model: string | null = 'embed-a'): Fake {
  const f: Fake = {
    model, fail: false, calls: 0, dims: DIMS, gate: null,
    name: () => f.model,
    async embed(texts, signal) {
      f.calls++
      if (f.gate) {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          f.gate!.then(resolve)
        })
      }
      if (f.fail) throw new KbError('embed-failed', 'boom')
      return texts.map((t) => {
        const v = textVector(t)
        return f.dims === DIMS ? v : normalizeVector([...v.slice(0, f.dims)].map(x => x + 0.001))
      })
    },
  }
  return f
}

function make(dataDir: string, embedder: Embedder, opts: { batchSize?: number, onChange?: () => void } = {}) {
  const store = new JsonStore<KnowledgeDoc>({ dataDir, name: 'knowledge.json', version: KNOWLEDGE_VERSION, defaults: defaultKnowledge, validate: normalizeKnowledge })
  store.load()
  const kb = new KbManager({ dataDir, store, embedder, batchSize: opts.batchSize, onChange: opts.onChange })
  managers.push(kb)
  return { kb, store }
}

const enc = (s: string) => new TextEncoder().encode(s)

const CATS = '猫是一种常见的宠物，喜欢吃鱼和睡觉。\n\n猫的听力很好，能听到老鼠的声音。'
const SPACE = '火星是太阳系中的一颗行星，表面呈红色。\n\n木星是太阳系中最大的行星。'
const ENGLISH = 'The embedding engine turns text into vectors.\n\nSQLite FTS5 provides keyword ranking with BM25.'

describe('registry', () => {
  test('defaults and normalisation', () => {
    expect(defaultKnowledge()).toEqual({ version: 1, bases: [] })
    const n = normalizeKnowledge({ version: 1, bases: [{ id: 'kb-1234abcd', name: ' 笔记 ', chunkSize: 5, chunkOverlap: 999, embedding: { model: 'm' } }] } as unknown as KnowledgeDoc)
    expect(n.bases[0]).toMatchObject({
      id: 'kb-1234abcd', name: '笔记', description: '', chunkSize: 500, chunkOverlap: 80, embedding: { model: null, dims: null },
    })
    const k = normalizeKnowledge({ version: 1, bases: [{ id: 'kb-1234abcd', name: 'a', chunkSize: 1000, chunkOverlap: 100, embedding: { model: 'm', dims: 8 } }] } as unknown as KnowledgeDoc)
    expect(k.bases[0]).toMatchObject({ chunkSize: 1000, chunkOverlap: 100, embedding: { model: 'm', dims: 8 } })
  })

  test('ids must be file-name safe, names unique ignoring case', () => {
    const base = (over: object) => ({ id: 'kb-1234abcd', name: 'a', ...over })
    for (const id of ['../x', 'a/b', 'A-B-C', '', 'ab', 'x'.repeat(41), 'kb 1']) {
      expect(() => normalizeKnowledge({ version: 1, bases: [base({ id })] } as unknown as KnowledgeDoc)).toThrow()
    }
    expect(() => normalizeKnowledge({ version: 1, bases: [base({}), base({ id: 'kb-2' + 'x'.repeat(5), name: 'A' })] } as unknown as KnowledgeDoc)).toThrow()
    expect(() => normalizeKnowledge({ version: 1, bases: [base({ name: '' })] } as unknown as KnowledgeDoc)).toThrow()
  })

  test('create and edit validate input', () => {
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as KbError).code } return null }
    const a = createKnowledgeBase({ name: 'Notes', chunkSize: 1000 }, [], 5)
    expect(a).toMatchObject({ name: 'Notes', chunkSize: 1000, chunkOverlap: 80, createdAt: 5 })
    expect(a.id).toMatch(/^kb-[0-9a-f]{8}$/)
    expect(code(() => createKnowledgeBase({}, [], 0))).toBe('bad-name')
    expect(code(() => createKnowledgeBase({ name: 'notes' }, [a], 0))).toBe('name-taken')
    expect(code(() => createKnowledgeBase({ name: 'b', chunkSize: 50 }, [], 0))).toBe('bad-chunk-size')
    expect(code(() => createKnowledgeBase({ name: 'b', chunkSize: 200, chunkOverlap: 200 }, [], 0))).toBe('bad-overlap')
    const b: KnowledgeBase = structuredClone(a)
    expect(code(() => applyKbEdit(b, { description: 'x'.repeat(501) }, []))).toBe('bad-description')
    expect(code(() => applyKbEdit(b, { chunkSize: 100 }, []))).toBeNull() // overlap 80 < 100 stays valid
    expect(b.chunkSize).toBe(100)
    expect(code(() => applyKbEdit(b, { chunkOverlap: 100 }, []))).toBe('bad-overlap')
  })

  test('the store writes version 1 atomically with a backup on change', () => {
    const dir = tmp()
    const { kb } = make(dir, fake())
    return kb.create({ name: 'A' }).then(async () => {
      await kb.create({ name: 'B' })
      expect(JSON.parse(readFileSync(join(dir, 'knowledge.json'), 'utf8')).version).toBe(1)
      expect(readdirSync(join(dir, 'backups')).some(f => f.startsWith('knowledge.'))).toBe(true)
    })
  })
})

describe('import and search', () => {
  test('a document is chunked, embedded and searchable (hybrid), progress is reported', async () => {
    const dir = tmp()
    let notified = 0
    const emb = fake()
    const { kb } = make(dir, emb, { batchSize: 1, onChange: () => notified++ })
    const base = await kb.create({ name: '测试', chunkSize: 100, chunkOverlap: 20 })
    const doc = await kb.addDocument(base.id, { name: 'cats.txt', bytes: enc(CATS) })
    expect(doc.status).toBe('indexing')
    expect(doc.chunkCount).toBeGreaterThan(0)
    expect(kb.liveView().jobs).toHaveLength(1)
    expect(kb.liveView().jobs[0]).toMatchObject({ kind: 'import', kbId: base.id, total: doc.chunkCount })
    await kb.idle()
    expect(kb.liveView().jobs).toEqual([])
    expect(notified).toBeGreaterThan(2)
    const [done] = await kb.listDocuments(base.id)
    expect(done).toMatchObject({ status: 'ready', vectorCount: doc.chunkCount, errorCode: null })
    expect((await kb.get(base.id)).embedding).toEqual({ model: 'embed-a', dims: DIMS })

    const r = await kb.search([base.id], '猫喜欢吃什么')
    expect(r.mode).toBe('hybrid')
    expect(r.reindexNeeded).toBe(false)
    expect(r.hits.length).toBeGreaterThan(0)
    const top = r.hits[0]!
    expect(top).toMatchObject({ kbId: base.id, kbName: '测试', docName: 'cats.txt', mode: 'hybrid' })
    expect(top.text).toContain('猫')
    expect(top.startLine).toBeGreaterThanOrEqual(1)
    expect(CATS.slice(top.startChar, top.endChar)).toBe(top.text)
    expect(top.similarity).not.toBeNull()
  })

  test('topK defaults to 5, is capped at 20 and honoured', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'many', chunkSize: 100, chunkOverlap: 10 })
    const text = Array.from({ length: 60 }, (_, i) => `第${i}段都提到了苹果和香蕉，另外还有很多别的内容用来凑字数，让每一段都接近一个分块的大小。`).join('\n\n')
    await kb.addDocument(base.id, { name: 'fruit.txt', bytes: enc(text) })
    await kb.idle()
    expect((await kb.search([base.id], '苹果')).hits).toHaveLength(5)
    expect((await kb.search([base.id], '苹果', { topK: 99 })).hits).toHaveLength(20)
    expect((await kb.search([base.id], '苹果', { topK: 2 })).hits).toHaveLength(2)
  })

  test('without an engine: keyword only, documents are keyword-only, nothing to re-index yet', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    const [d] = await kb.listDocuments(base.id)
    expect(d).toMatchObject({ status: 'keyword-only', errorCode: 'no-engine', vectorCount: 0 })
    const r = await kb.search([base.id], '老鼠')
    expect(r.mode).toBe('keyword')
    expect(r.hits[0]!.mode).toBe('keyword')
    expect(r.hits[0]!.text).toContain('老鼠')
    expect(r.hits[0]!.bm25).not.toBeNull()
    expect(r.reindexNeeded).toBe(false) // engine off: nothing could be re-indexed
    await expect(kb.reindex(base.id)).rejects.toMatchObject({ code: 'engine-off' })
  })

  test('engine model differs from the recorded one: keyword only and re-index flagged, re-index fixes it', async () => {
    const dir = tmp()
    const emb = fake('embed-a')
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    emb.model = 'embed-b'
    const r = await kb.search([base.id], '猫')
    expect(r.mode).toBe('keyword')
    expect(r.reindexNeeded).toBe(true)
    expect(r.reindexKbIds).toEqual([base.id])
    expect((await kb.get(base.id)).reindexNeeded).toBe(true)

    // a document added now cannot get vectors of the other model
    await kb.addDocument(base.id, { name: 'b.txt', bytes: enc(SPACE) })
    await kb.idle()
    expect((await kb.listDocuments(base.id))[1]).toMatchObject({ status: 'keyword-only', errorCode: 'model-mismatch' })

    await kb.reindex(base.id)
    await kb.idle()
    const after = await kb.get(base.id)
    expect(after.embedding).toEqual({ model: 'embed-b', dims: DIMS })
    expect(after.reindexNeeded).toBe(false)
    expect((await kb.listDocuments(base.id)).map(d => d.status)).toEqual(['ready', 'ready'])
    const r2 = await kb.search([base.id], '火星')
    expect(r2.mode).toBe('hybrid')
    expect(r2.reindexNeeded).toBe(false)
  })

  test('same model name but other dimensions is detected at search time', async () => {
    const dir = tmp()
    const emb = fake('embed-a')
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    emb.dims = 16
    const r = await kb.search([base.id], '猫')
    expect(r.mode).toBe('keyword')
    expect(r.reindexNeeded).toBe(true)
  })

  test('an engine failure during search degrades to keyword; the search does not fail', async () => {
    const dir = tmp()
    const emb = fake()
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    emb.fail = true
    const r = await kb.search([base.id], '老鼠')
    expect(r.mode).toBe('keyword')
    expect(r.vectorError).toBe(true)
    expect(r.reindexNeeded).toBe(false)
    expect(r.hits[0]!.text).toContain('老鼠')
  })

  test('import failure: the document is marked failed with the reason, keeps no vectors, stays keyword-searchable', async () => {
    const dir = tmp()
    const emb = fake()
    emb.fail = true
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    const [d] = await kb.listDocuments(base.id)
    expect(d).toMatchObject({ status: 'failed', errorCode: 'embed-failed', errorDetail: 'boom', vectorCount: 0 })
    expect((await kb.get(base.id)).embedding).toEqual({ model: null, dims: null })
    expect((await kb.search([base.id], '老鼠')).hits.length).toBeGreaterThan(0)
    expect((await kb.get(base.id)).reindexNeeded).toBe(true)
    emb.fail = false
    await kb.reindex(base.id)
    await kb.idle()
    expect((await kb.listDocuments(base.id))[0]).toMatchObject({ status: 'ready', errorCode: null })
  })

  test('a failing re-index leaves no vectors and no recorded model', async () => {
    const dir = tmp()
    const emb = fake()
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    emb.fail = true
    await kb.reindex(base.id)
    await kb.idle()
    expect((await kb.get(base.id)).embedding).toEqual({ model: null, dims: null })
    expect((await kb.listDocuments(base.id))[0]).toMatchObject({ status: 'failed', vectorCount: 0 })
    expect((await kb.search([base.id], '猫')).mode).toBe('keyword')
  })

  test('several knowledge bases are searched together and fused', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake())
    const a = await kb.create({ name: 'cats' })
    const b = await kb.create({ name: 'space' })
    await kb.addDocument(a.id, { name: 'cats.txt', bytes: enc(CATS) })
    await kb.addDocument(b.id, { name: 'space.md', bytes: enc(`# 天文\n\n${SPACE}`) })
    await kb.idle()
    const both = await kb.search(null, '太阳系的行星')
    expect(both.hits[0]!.kbName).toBe('space')
    const names = new Set(both.hits.map(h => h.kbName))
    expect(names.has('cats') || names.has('space')).toBe(true)
    const onlyCats = await kb.search([a.id], '太阳系的行星')
    expect(onlyCats.hits.every(h => h.kbId === a.id)).toBe(true)
    const md = (await kb.search([b.id], '火星')).hits[0]!
    expect(md.headingPath).toBe('天文')
    await expect(kb.search(['kb-missing1'], 'x')).rejects.toMatchObject({ code: 'not-found' })
    await expect(kb.search(null, '   ')).rejects.toMatchObject({ code: 'empty-query' })
  })

  test('English words and hostile query text', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'en' })
    await kb.addDocument(base.id, { name: 'e.txt', bytes: enc(ENGLISH) })
    await kb.idle()
    expect((await kb.search([base.id], 'bm25 ranking')).hits[0]!.text).toContain('BM25')
    for (const evil of ['"', 'a AND', 'NEAR(', '*', 'text OR', '-bm25', 'fts5:keyword', '(((']) {
      const r = await kb.search([base.id], evil)
      expect(Array.isArray(r.hits)).toBe(true)
    }
    expect((await kb.search([base.id], '!!! ???')).hits).toEqual([])
  })
})

describe('documents and cleanup', () => {
  test('input checks: type, empty, size, duplicate, binary', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'k' })
    const code = async (p: Promise<unknown>) => { try { await p } catch (e) { return (e as KbError).code } return null }
    expect(await code(kb.addDocument(base.id, { name: 'a.pdf', bytes: enc('x') }))).toBe('unsupported-type')
    expect(await code(kb.addDocument(base.id, { name: 'noext', bytes: enc('x') }))).toBe('unsupported-type')
    expect(await code(kb.addDocument(base.id, { name: 'a.txt', bytes: new Uint8Array(0) }))).toBe('empty-file')
    expect(await code(kb.addDocument(base.id, { name: 'a.txt', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) }))).toBe('too-large')
    expect(await code(kb.addDocument(base.id, { name: 'a.txt', bytes: new Uint8Array([0x89, 0, 1, 2]) }))).toBe('not-text')
    expect(await code(kb.addDocument(base.id, { name: 'a.txt', bytes: enc('   \n\n ') }))).toBe('no-text')
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc('内容一') })
    expect(await code(kb.addDocument(base.id, { name: 'copy.txt', bytes: enc('内容一') }))).toBe('duplicate')
    expect(await code(kb.addDocument('kb-nothere', { name: 'a.txt', bytes: enc('x') }))).toBe('not-found')
    expect(await code(kb.addDocument('../etc', { name: 'a.txt', bytes: enc('x') }))).toBe('not-found')
    // a path in the name is reduced to the file name
    const d = await kb.addDocument(base.id, { name: 'X:\\notes\\b.md', bytes: enc('# t\n\n正文') })
    expect(d.name).toBe('b.md')
    await kb.idle()
  })

  test('GB18030 and UTF-16 files are searchable', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'k' })
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xb5, 0xb5]) // 中文文档
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('向量引擎').flatMap(ch => [ch.charCodeAt(0) & 255, ch.charCodeAt(0) >> 8])])
    await kb.addDocument(base.id, { name: 'gbk.txt', bytes: gbk })
    await kb.addDocument(base.id, { name: 'u16.txt', bytes: utf16 })
    await kb.idle()
    expect((await kb.search([base.id], '文档')).hits[0]!.docName).toBe('gbk.txt')
    expect((await kb.search([base.id], '引擎')).hits[0]!.docName).toBe('u16.txt')
  })

  test('deleting a document removes its chunks, vectors and index rows in one go', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake())
    const base = await kb.create({ name: 'k', chunkSize: 100, chunkOverlap: 10 })
    const a = await kb.addDocument(base.id, { name: 'cats.txt', bytes: enc(CATS) })
    const b = await kb.addDocument(base.id, { name: 'space.txt', bytes: enc(SPACE) })
    await kb.idle()
    await kb.removeDocument(base.id, a.id)
    const docs = await kb.listDocuments(base.id)
    expect(docs.map(d => d.name)).toEqual(['space.txt'])
    expect((await kb.search([base.id], '猫 老鼠 宠物')).hits.every(h => h.docName === 'space.txt')).toBe(true)
    await kb.close()
    const db = await KbDb.open(join(dir, 'kb', `${base.id}.sqlite`))
    try {
      expect(db.countChunks()).toBe(b.chunkCount)
      expect(db.countVectors()).toBe(b.chunkCount)
      expect(db.keywordSearch('"猫"', 10)).toEqual([])
      expect(db.keywordSearch('"火星"', 10).length).toBe(1)
    } finally {
      db.close()
    }
    await expect(kb.removeDocument(base.id, 999)).rejects.toMatchObject({ code: 'doc-not-found' })
  })

  test('deleting a knowledge base removes its files, even while a job runs', async () => {
    const dir = tmp()
    const emb = fake()
    let open!: () => void
    emb.gate = new Promise<void>((r) => { open = r })
    const { kb, store } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.addDocument(base.id, { name: 'b.txt', bytes: enc(SPACE) })
    const other = await kb.create({ name: 'other' })
    expect(existsSync(join(dir, 'kb', `${base.id}.sqlite`))).toBe(true)
    await kb.remove(base.id)
    open()
    await kb.idle()
    expect(readdirSync(join(dir, 'kb')).filter(f => f.startsWith(base.id))).toEqual([])
    expect(store.get().bases.map(b => b.id)).toEqual([other.id])
    expect(kb.liveView().jobs).toEqual([])
    await expect(kb.get(base.id)).rejects.toMatchObject({ code: 'not-found' })
  })

  test('a document cannot be deleted while its knowledge base is re-indexed', async () => {
    const dir = tmp()
    const emb = fake()
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'k' })
    const d = await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    let open!: () => void
    emb.gate = new Promise<void>((r) => { open = r })
    await kb.reindex(base.id)
    await kb.reindex(base.id) // a second request joins the first
    expect(kb.liveView().jobs.filter(j => j.kind === 'reindex')).toHaveLength(1)
    await expect(kb.removeDocument(base.id, d.id)).rejects.toMatchObject({ code: 'busy' })
    open()
    await kb.idle()
    await kb.removeDocument(base.id, d.id)
  })

  test('chunk settings apply to documents added afterwards', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'k' })
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段的内容用来测试分块大小的变化。`).join('\n\n')
    const big = await kb.addDocument(base.id, { name: 'big.txt', bytes: enc(text) })
    await kb.update(base.id, { chunkSize: 100, chunkOverlap: 10 })
    const small = await kb.addDocument(base.id, { name: 'small.txt', bytes: enc(text + '。') })
    expect(small.chunkCount).toBeGreaterThan(big.chunkCount)
    await kb.update(base.id, { name: '新名字' })
    expect((await kb.get(base.id)).name).toBe('新名字')
    await kb.idle()
  })
})

describe('restart safety', () => {
  test('a document interrupted while indexing becomes keyword-only and can be re-indexed', async () => {
    const dir = tmp()
    const emb = fake()
    emb.gate = new Promise<void>(() => { /* never opens: the process "dies" in the middle */ })
    const first = make(dir, emb)
    const base = await first.kb.create({ name: 'k' })
    await first.kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await new Promise(r => setTimeout(r, 20))
    expect(emb.calls).toBeGreaterThan(0)
    await first.kb.close() // aborts the job and leaves the document `indexing`

    const emb2 = fake()
    const second = make(dir, emb2)
    expect((await second.kb.listDocuments(base.id))[0]!.status).toBe('indexing')
    await second.kb.recover()
    const [d] = await second.kb.listDocuments(base.id)
    expect(d).toMatchObject({ status: 'keyword-only', errorCode: 'interrupted', vectorCount: 0 })
    expect((await second.kb.get(base.id)).reindexNeeded).toBe(true)
    expect((await second.kb.search([base.id], '老鼠')).hits.length).toBeGreaterThan(0)
    await second.kb.reindex(base.id)
    await second.kb.idle()
    expect((await second.kb.listDocuments(base.id))[0]!.status).toBe('ready')
  })

  test('an unreadable knowledge.json keeps hand edits safe (store rejects it)', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'knowledge.json'), '{ not json')
    const store = new JsonStore<KnowledgeDoc>({ dataDir: dir, name: 'knowledge.json', version: KNOWLEDGE_VERSION, defaults: defaultKnowledge, validate: normalizeKnowledge })
    expect(() => store.load()).toThrow()
  })
})

// ---------------------------------------------------------------------------------------
// Tags and the similarity floor (decision 65 ⑭)

/** Paragraphs of ~57 characters: with chunkSize 100 each one is its own chunk. */
const aPara = (i: number) => `alpha beta gamma alpha beta gamma alpha beta gamma pad${String(i).padStart(3, '0')}`
const bPara = (i: number) => `alpha delta epsilon zeta eta theta iota kappa lambda mu nu xi${i}`
const TAGGED = `[tag:A]\n${Array.from({ length: 60 }, (_, i) => aPara(i)).join('\n\n')}\n\n[tag:B]\n${bPara(1)}\n\n${bPara(2)}`

describe('tags: filter before ranking', () => {
  test('vector path: 60 close chunks of tag A cannot crowd out the 2 farther chunks of tag B', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake())
    const base = await kb.create({ name: 'tagged', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(base.id, { name: 'pools.txt', bytes: enc(TAGGED) })
    await kb.idle()
    expect((await kb.get(base.id)).tags).toEqual([{ tag: 'A', count: 60 }, { tag: 'B', count: 2 }])

    const all = await kb.search([base.id], 'alpha beta gamma')
    expect(all.mode).toBe('hybrid')
    expect(all.hits.every(h => h.text.startsWith('alpha beta gamma'))).toBe(true) // B is nowhere near the top 5

    const b = await kb.search([base.id], 'alpha beta gamma', { tags: ['B'] })
    expect(b.mode).toBe('hybrid')
    expect(b.hits.map(h => h.text).sort()).toEqual([bPara(1), bPara(2)])
    expect(b.hits.every(h => h.similarity !== null)).toBe(true)

    const a = await kb.search([base.id], 'alpha beta gamma', { tags: ['A'], topK: 20 })
    expect(a.hits).toHaveLength(20)
    expect(a.hits.every(h => h.text.startsWith('alpha beta gamma'))).toBe(true)
    // Any of the tags; a tag nobody has gives nothing, and is not a reason to fail.
    expect((await kb.search([base.id], 'alpha', { tags: ['B', 'nope'] })).hits).toHaveLength(2)
    expect((await kb.search([base.id], 'alpha beta gamma', { tags: ['nope'] })).hits).toEqual([])
    expect((await kb.search([base.id], 'alpha beta gamma', { tags: [] })).hits).toHaveLength(5)
  })

  test('keyword path: 60 strong keyword matches of tag A cannot crowd out the weak ones of tag B', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'kw', chunkSize: 100, chunkOverlap: 10 })
    const strong = Array.from({ length: 60 }, (_, i) => `${'zeta '.repeat(10)}pad${String(i).padStart(3, '0')}`).join('\n\n')
    const text = `[tag:A]\n${strong}\n\n[tag:B]\nzeta once among many other words here xxxxxxxxxx yyyyyyyyyy\n\nzeta again with some other words around it and more padding`
    await kb.addDocument(base.id, { name: 'kw.txt', bytes: enc(text) })
    await kb.idle()
    const plain = await kb.search([base.id], 'zeta')
    expect(plain.mode).toBe('keyword')
    expect(plain.hits.every(h => h.text.startsWith('zeta zeta'))).toBe(true)
    const b = await kb.search([base.id], 'zeta', { tags: ['B'] })
    expect(b.hits).toHaveLength(2)
    expect(b.hits.every(h => h.docName === 'kw.txt' && !h.text.startsWith('zeta zeta'))).toBe(true)
    expect(b.hits.every(h => h.bm25 !== null && h.similarity === null)).toBe(true)
  })

  test('tags are applied per knowledge base; one without a matching chunk gives nothing', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake())
    const one = await kb.create({ name: 'one', chunkSize: 100, chunkOverlap: 10 })
    const two = await kb.create({ name: 'two', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(one.id, { name: 'a.txt', bytes: enc('[tag:X]\nthe cat sat on the mat today') })
    await kb.addDocument(two.id, { name: 'b.txt', bytes: enc('[tag:Y]\nthe cat sat on the mat tonight') })
    await kb.idle()
    expect(await kb.tags(null)).toEqual([{ tag: 'X', count: 1 }, { tag: 'Y', count: 1 }])
    expect(await kb.tags([one.id])).toEqual([{ tag: 'X', count: 1 }])
    expect((await kb.search(null, 'cat', { tags: ['Y'] })).hits.map(h => h.kbName)).toEqual(['two'])
    expect((await kb.search(null, 'cat', { tags: ['X', 'Y'] })).hits.map(h => h.kbName).sort()).toEqual(['one', 'two'])
    await expect(kb.tags(['kb-missing0'])).rejects.toMatchObject({ code: 'not-found' })
  })

  test('tags in the request are cleaned: strings only, duplicates dropped, at most 50', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'c', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc('[tag:A]\nsome words about cats') })
    await kb.idle()
    const many = Array.from({ length: 60 }, (_, i) => `t${i}`)
    expect((await kb.search([base.id], 'cats', { tags: [...many, 'A'] })).hits).toEqual([]) // A is the 61st: cut
    expect((await kb.search([base.id], 'cats', { tags: ['A', 'A', 3 as unknown as string] })).hits).toHaveLength(1)
  })
})

describe('minSimilarity', () => {
  async function tagged(emb = fake()) {
    const dir = tmp()
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'sim', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(base.id, { name: 'pools.txt', bytes: enc(TAGGED) })
    await kb.idle()
    return { kb, base }
  }

  test('candidates below the floor are dropped before fusion, keyword hits too; null / absent / junk mean off', async () => {
    const { kb, base } = await tagged()
    const q = 'alpha delta epsilon zeta'
    const open = await kb.search([base.id], q, { topK: 20 })
    const sims = open.hits.map(h => h.similarity).filter((x): x is number => x !== null).sort((x, y) => x - y)
    expect(sims.length).toBeGreaterThan(2)
    const floor = (sims[0]! + sims[sims.length - 1]!) / 2
    const cut = await kb.search([base.id], q, { topK: 20, minSimilarity: floor })
    expect(cut.hits.length).toBeGreaterThan(0)
    expect(cut.hits.length).toBeLessThan(open.hits.length)
    // Every hit is a vector candidate at or above the floor, whichever search found it.
    expect(cut.hits.every(h => h.similarity !== null && h.similarity >= floor)).toBe(true)

    expect((await kb.search([base.id], q, { minSimilarity: 1.01 })).hits).toEqual([]) // clamped to 1
    for (const off of [null, undefined, Number.NaN, 'x' as unknown as number]) {
      expect((await kb.search([base.id], q, { topK: 20, minSimilarity: off })).hits).toHaveLength(open.hits.length)
    }
  })

  test('works together with tags', async () => {
    const { kb, base } = await tagged()
    const q = 'alpha delta epsilon zeta'
    expect((await kb.search([base.id], q, { tags: ['B'], minSimilarity: 0.99 })).hits).toEqual([])
    const ok = await kb.search([base.id], q, { tags: ['B'], minSimilarity: 0.5 })
    expect(ok.hits.length).toBeGreaterThan(0)
    expect(ok.hits.every(h => h.similarity! >= 0.5 && h.text.startsWith('alpha delta'))).toBe(true)
  })

  test('a knowledge base searched by keyword only is not affected', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'kwonly', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(base.id, { name: 'a.txt', bytes: enc(CATS) })
    await kb.idle()
    const r = await kb.search([base.id], '猫喜欢吃鱼', { minSimilarity: 0.99 })
    expect(r.mode).toBe('keyword')
    expect(r.hits.length).toBeGreaterThan(0)
  })

  test('next to a knowledge base without vectors, only the vector one is filtered', async () => {
    const dir = tmp()
    const emb = fake()
    const { kb } = make(dir, emb)
    const withVec = await kb.create({ name: 'withvec', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(withVec.id, { name: 'a.txt', bytes: enc(SPACE) })
    await kb.idle()
    emb.model = null
    const noVec = await kb.create({ name: 'novec', chunkSize: 100, chunkOverlap: 10 })
    await kb.addDocument(noVec.id, { name: 'b.txt', bytes: enc('火星是红色的行星') })
    await kb.idle()
    emb.model = 'embed-a'
    const r = await kb.search(null, '火星', { minSimilarity: 0.999 })
    expect(r.hits.some(h => h.kbName === 'novec')).toBe(true)
    expect(r.hits.every(h => h.kbName !== 'withvec')).toBe(true)
  })
})

describe('raw text, re-chunking and re-index', () => {
  test('documents keep their decoded text and report tags and hasRaw', async () => {
    const dir = tmp()
    const { kb } = make(dir, fake(null))
    const base = await kb.create({ name: 'raw', chunkSize: 100, chunkOverlap: 10 })
    const doc = await kb.addDocument(base.id, { name: 'a.txt', bytes: enc('[tag:数学,物理]\n一段内容。') })
    await kb.idle()
    expect(doc).toMatchObject({ hasRaw: true, tags: ['数学', '物理'] })
    const [listed] = await kb.listDocuments(base.id)
    expect(listed).toMatchObject({ hasRaw: true, tags: ['数学', '物理'], chunkCount: 1 })
  })

  test('re-index re-chunks documents that have text with the current settings; older documents only get vectors again', async () => {
    const dir = tmp()
    const emb = fake()
    const first = make(dir, emb)
    const base = await first.kb.create({ name: 'rechunk', chunkSize: 100, chunkOverlap: 10 })
    const long = (c: string) => `${c.repeat(55)}。`
    const old = await first.kb.addDocument(base.id, { name: 'old.txt', bytes: enc(`${long('旧')}\n\n${long('甲')}`) })
    const fresh = await first.kb.addDocument(base.id, { name: 'new.txt', bytes: enc(`[tag:A]\n${long('一')}\n\n${long('二')}\n\n[tag:B]\n${long('三')}`) })
    await first.kb.idle()
    // Each paragraph is its own chunk at 100 characters.
    expect(old.chunkCount).toBe(2)
    expect(fresh.chunkCount).toBe(3)
    await first.kb.close()

    // Make `old.txt` a document without text (as if it came from a schema 1 file).
    const raw = await openDatabase(join(dir, 'kb', `${base.id}.sqlite`))
    raw.exec("UPDATE documents SET raw = NULL WHERE name = 'old.txt'")
    raw.close()

    const second = make(dir, emb)
    await second.kb.update(base.id, { chunkSize: 4000, chunkOverlap: 10 })
    const before = await second.kb.listDocuments(base.id)
    expect(before.find(d => d.name === 'old.txt')).toMatchObject({ hasRaw: false, tags: [] })
    await second.kb.reindex(base.id)
    await second.kb.idle()

    const after = await second.kb.listDocuments(base.id)
    // No text: the old chunks stay, only the vectors are rebuilt.
    expect(after.find(d => d.name === 'old.txt')).toMatchObject({ chunkCount: 2, hasRaw: false, status: 'ready', vectorCount: 2 })
    // With text: re-chunked at 4000 characters, so the two A paragraphs merge, and the tag line still splits A from B.
    expect(after.find(d => d.name === 'new.txt')).toMatchObject({ chunkCount: 2, hasRaw: true, tags: ['A', 'B'], status: 'ready', vectorCount: 2 })
    expect((await second.kb.get(base.id)).tags).toEqual([{ tag: 'A', count: 1 }, { tag: 'B', count: 1 }])
    expect((await second.kb.search([base.id], '三三三', { tags: ['B'] })).hits).toHaveLength(1)
    expect((await second.kb.get(base.id)).embedding).toEqual({ model: 'embed-a', dims: DIMS })
    expect(second.kb.liveView().jobs).toEqual([])
  })

  test('re-index still needs the engine, and a document cannot be deleted during it', async () => {
    const dir = tmp()
    const emb = fake()
    const { kb } = make(dir, emb)
    const base = await kb.create({ name: 'eng', chunkSize: 100, chunkOverlap: 10 })
    const doc = await kb.addDocument(base.id, { name: 'a.txt', bytes: enc('[tag:A]\n内容。') })
    await kb.idle()
    emb.model = null
    await expect(kb.reindex(base.id)).rejects.toMatchObject({ code: 'engine-off' })
    emb.model = 'embed-a'
    emb.gate = new Promise<void>(() => {})
    await kb.reindex(base.id)
    for (let i = 0; i < 100 && emb.calls < 2; i++) await new Promise(r => setTimeout(r, 10))
    await expect(kb.removeDocument(base.id, doc.id)).rejects.toMatchObject({ code: 'busy' })
    await kb.close()
  })
})
