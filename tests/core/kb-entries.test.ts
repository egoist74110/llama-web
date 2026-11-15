// Knowledge base entries, versions, trash, change log and guide (decision 69): schema 3, the manager API and
// the knowledge.json v2 migration. A fake embedder (bag-of-words vectors) and temp directories only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../server/core/i18n'
import { JsonStore } from '../../server/core/store'
import { KbError, type KbErrorCode } from '../../server/core/kb/errors'
import { KbManager, MAX_ENTRY_BODY, MAX_READ_LENGTH } from '../../server/core/kb/manager'
import { KbDb, KB_SCHEMA_VERSION } from '../../server/core/kb/kb-db'
import { openDatabase } from '../../server/core/kb/sqlite'
import { normalizeVector, type Embedder } from '../../server/core/kb/embed'
import { tokenize } from '../../server/core/kb/tokenize'
import {
  defaultKnowledge, guideRev, KNOWLEDGE_MIGRATIONS, KNOWLEDGE_VERSION, normalizeKnowledge, type KnowledgeDoc,
} from '../../server/core/kb/registry'

const dirs: string[] = []
const managers: KbManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'llama-web-kb-entries-'))
  dirs.push(d)
  return d
}

const DIMS = 16
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const textVector = (text: string) => {
  const v = new Array<number>(DIMS).fill(0)
  for (const tok of tokenize(text)) v[hash(tok) % DIMS]! += 1
  return normalizeVector(v)
}

interface Fake extends Embedder {
  model: string | null
  gate: Promise<void> | null
}
function fake(model: string | null = 'embed-a'): Fake {
  const f: Fake = {
    model, gate: null,
    name: () => f.model,
    async embed(texts, signal) {
      if (f.gate) {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          f.gate!.then(resolve)
        })
      }
      return texts.map(textVector)
    },
  }
  return f
}

const newStore = (dataDir: string) => new JsonStore<KnowledgeDoc>({
  dataDir, name: 'knowledge.json', version: KNOWLEDGE_VERSION, defaults: defaultKnowledge, validate: normalizeKnowledge, migrations: KNOWLEDGE_MIGRATIONS,
})

// The data directory of a manager made by `make` (the files are under `kb/`).
const dirOfManager = new WeakMap<KbManager, string>()
const kbDir = (kb: KbManager) => join(dirOfManager.get(kb) ?? '', 'kb')

function make(dataDir: string, embedder: Embedder) {
  const store = newStore(dataDir)
  store.load()
  const kb = new KbManager({ dataDir, store, embedder })
  dirOfManager.set(kb, dataDir)
  managers.push(kb)
  return { kb, store }
}

async function setup(embedder: Embedder = fake('embed-a')) {
  const dir = tmp()
  const { kb, store } = make(dir, embedder)
  const base = await kb.create({ name: 'Notes' })
  return { dir, kb, store, id: base.id, file: join(dir, 'kb', `${base.id}.sqlite`) }
}

const enc = (s: string) => new TextEncoder().encode(s)
const codeOf = async (p: Promise<unknown>): Promise<KbError> => {
  try { await p } catch (e) { if (e instanceof KbError) return e; throw e }
  throw new Error('expected a KbError')
}
const expectCode = async (p: Promise<unknown>, code: KbErrorCode) => expect((await codeOf(p)).code).toBe(code)
// Hybrid search also returns weak vector matches: a hit counts when its text has the word.
const hitsOf = async (kb: KbManager, id: string, q: string, tags?: string[]) =>
  (await kb.search([id], q, { tags })).hits.filter(h => h.text.toLowerCase().includes(q.toLowerCase()))

describe('schema 3', () => {
  test('a schema 2 file is migrated: rows become live sources, still searchable, new tables exist', async () => {
    const { dir, kb, id, file } = await setup()
    await kb.close()
    managers.length = 0
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
    mkdirSync(join(dir, 'kb'), { recursive: true })
    const raw = await openDatabase(file)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, source TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        mtime INTEGER NOT NULL, added_at INTEGER NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error_code TEXT, error_detail TEXT, raw TEXT
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
        start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, start_line INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX chunks_doc ON chunks (doc_id, ord);
      CREATE TABLE vectors (chunk_id INTEGER PRIMARY KEY, blob BLOB NOT NULL);
      CREATE VIRTUAL TABLE fts USING fts5(tokens, tokenize = 'unicode61 remove_diacritics 0');
      CREATE TABLE chunk_tags (chunk_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (chunk_id, tag)) WITHOUT ROWID;
      INSERT INTO meta (key, value) VALUES ('schema', '2');
      INSERT INTO documents (name, source, size, sha256, mtime, added_at, chunk_count, status, raw) VALUES ('old.txt', 'old.txt', 9, 'abc', 1, 1, 1, 'ready', 'hello old');
      INSERT INTO chunks (doc_id, ord, text, start_char, end_char, start_line) VALUES (1, 0, 'hello old', 0, 9, 1);
      INSERT INTO fts (rowid, tokens) VALUES (1, 'hello old');
    `)
    raw.close()

    const again = make(dir, fake(null)).kb
    const docs = await again.listDocuments(id)
    expect(docs).toEqual([expect.objectContaining({ name: 'old.txt', kind: 'source', version: 1, deletedAt: null, entryTags: null })])
    const hits = await hitsOf(again, id, 'hello')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'source', entryVersion: null })
    const view = await again.get(id)
    expect(view).toMatchObject({ docCount: 1, entryCount: 0, trashCount: 0 })
    const e = await again.addEntry(id, { title: 'T', body: 'new entry text' }, 'admin')
    expect(e.version).toBe(1)
    expect(await again.changes(id)).toHaveLength(1)
    const check = await openDatabase(file)
    try {
      const names = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>().map(r => r.name)
      expect(names).toEqual(expect.arrayContaining(['entry_versions', 'changes']))
      expect(check.prepare("SELECT value FROM meta WHERE key = 'schema'").get<{ value: string }>()?.value).toBe(String(KB_SCHEMA_VERSION))
    } finally {
      check.close()
    }
  })

  test('a new file is created at schema 3 and can be reopened', async () => {
    const dir = tmp()
    const file = join(dir, 'x.sqlite')
    const db = await KbDb.open(file)
    expect(db.listEntries({ offset: 0, limit: 10 })).toEqual({ total: 0, rows: [] })
    expect(db.countTrash()).toBe(0)
    db.close()
    ;(await KbDb.open(file)).close()
    expect(KB_SCHEMA_VERSION).toBe(3)
  })
})

describe('knowledge.json v2', () => {
  test('a version 1 file is migrated by the store: every base gets guide ""', () => {
    const dir = tmp()
    const base = { id: 'kb-1234abcd', name: 'Old', description: '', createdAt: 1, chunkSize: 500, chunkOverlap: 80, embedding: { model: null, dims: null } }
    writeFileSync(join(dir, 'knowledge.json'), JSON.stringify({ version: 1, bases: [base] }))
    const store = newStore(dir)
    store.load()
    expect(store.get().version).toBe(2)
    expect(store.get().bases[0]).toMatchObject({ id: 'kb-1234abcd', guide: '' })
    store.close()
  })

  test('normalisation fills a missing or invalid guide', () => {
    const base = { id: 'kb-1234abcd', name: 'a', chunkSize: 500, chunkOverlap: 80, embedding: {} }
    expect(normalizeKnowledge({ version: 2, bases: [base] } as unknown as KnowledgeDoc).bases[0]!.guide).toBe('')
    expect(normalizeKnowledge({ version: 2, bases: [{ ...base, guide: 5 }] } as unknown as KnowledgeDoc).bases[0]!.guide).toBe('')
    expect(normalizeKnowledge({ version: 2, bases: [{ ...base, guide: 'g' }] } as unknown as KnowledgeDoc).bases[0]!.guide).toBe('g')
  })
})

describe('entries', () => {
  test('addEntry is searchable; hits carry kind, version and title; entry tags and body tag lines are merged', async () => {
    const { kb, id } = await setup()
    const e = await kb.addEntry(id, {
      title: ' Road rules ', body: 'Alpha rule about the zebra crossing.\n\n[tag:body]\n\nBeta rule about the quokka.', tags: ['entry', 'entry', ' traffic '],
    }, 'admin')
    await kb.idle()
    expect(e).toMatchObject({ title: 'Road rules', version: 1, tags: ['entry', 'traffic'] })
    const hits = await hitsOf(kb, id, 'zebra')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'entry', entryVersion: 1, docName: 'Road rules', docId: e.id })
    // Entry tags are on every chunk.
    expect(await hitsOf(kb, id, 'zebra', ['entry'])).toHaveLength(1)
    expect(await hitsOf(kb, id, 'quokka', ['entry'])).toHaveLength(1)
    expect(await hitsOf(kb, id, 'quokka', ['traffic'])).toHaveLength(1)
    // The tag line of the body is added to the entry tags for the chunks after it.
    expect(await hitsOf(kb, id, 'quokka', ['body'])).toHaveLength(1)
    expect(await hitsOf(kb, id, 'zebra', ['body'])).toHaveLength(0)
    expect(await kb.getEntry(id, e.id)).toMatchObject({ status: 'ready', version: 1 })
    expect(await kb.get(id)).toMatchObject({ docCount: 0, entryCount: 1, trashCount: 0 })
  })

  test('the entry title is found by keyword search and leads the heading path; a renamed title follows', async () => {
    const { kb, id } = await setup(fake(null))
    const e = await kb.addEntry(id, { title: 'Pelican guidelines', body: '# Part\n\nNothing about birds here.' }, 'admin')
    await kb.idle()
    // Keyword only (no engine): the title is not in the chunk text, so hitsOf (which filters on the text) is not used.
    const hits = (await kb.search([id], 'pelican')).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ docId: e.id, headingPath: 'Pelican guidelines > Part' })
    await kb.updateEntry(id, e.id, { baseVersion: 1, title: 'Heron guidelines' }, 'admin')
    await kb.idle()
    expect((await kb.search([id], 'pelican')).hits).toHaveLength(0)
    expect((await kb.search([id], 'heron')).hits).toHaveLength(1)
  })

  test('listEntries returns entry tags with counts, not counting the trash or narrowed by the filter', async () => {
    const { kb, id } = await setup()
    await kb.addEntry(id, { title: 'First', body: 'one', tags: ['a'] }, 'admin')
    await kb.addEntry(id, { title: 'Second', body: 'two', tags: ['b', 'a'] }, 'admin')
    const gone = await kb.addEntry(id, { title: 'Third', body: 'three', tags: ['c', 'a'] }, 'admin')
    await kb.idle()
    expect((await kb.listEntries(id)).tags).toEqual([{ tag: 'a', count: 3 }, { tag: 'b', count: 1 }, { tag: 'c', count: 1 }])
    await kb.deleteEntry(id, gone.id, { baseVersion: 1 }, 'admin')
    expect((await kb.listEntries(id)).tags).toEqual([{ tag: 'a', count: 2 }, { tag: 'b', count: 1 }])
    expect((await kb.listEntries(id, { tag: 'b' })).tags).toEqual([{ tag: 'a', count: 2 }, { tag: 'b', count: 1 }])
  })

  test('listEntries filters by tag and substring (wildcards are literal), pages and previews', async () => {
    const { kb, id } = await setup()
    await kb.addEntry(id, { title: 'First', body: 'about 100% cats', tags: ['a'] }, 'admin')
    await kb.addEntry(id, { title: 'Second', body: 'about under_score dogs', tags: ['b'] }, 'admin')
    await kb.addEntry(id, { title: 'Third', body: 'x'.repeat(300), tags: ['a', 'b'] }, 'admin')
    await kb.idle()
    expect((await kb.listEntries(id)).total).toBe(3)
    expect((await kb.listEntries(id, { tag: 'a' })).items.map(i => i.title).sort()).toEqual(['First', 'Third'])
    expect((await kb.listEntries(id, { query: '100%' })).items.map(i => i.title)).toEqual(['First'])
    expect((await kb.listEntries(id, { query: 'UNDER_SCORE' })).items.map(i => i.title)).toEqual(['Second'])
    expect((await kb.listEntries(id, { query: '%' })).total).toBe(1)
    expect((await kb.listEntries(id, { query: 'second' })).total).toBe(1)
    const page = await kb.listEntries(id, { limit: 1, offset: 1 })
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(1)
    const third = (await kb.listEntries(id, { query: 'xxx' })).items[0]!
    expect(third.preview).toHaveLength(200)
    expect(third).toMatchObject({ version: 1, status: 'ready', tags: ['a', 'b'] })
    expect((await kb.listEntries(id, { limit: 9999 })).items).toHaveLength(3)
  })

  test('updateEntry bumps the version, keeps the history, swaps the searchable text; a stale baseVersion conflicts', async () => {
    const { kb, id } = await setup()
    const e = await kb.addEntry(id, { title: 'Pets', body: 'The hamster likes wheels.' }, 'admin')
    await kb.idle()
    const u = await kb.updateEntry(id, e.id, { baseVersion: 1, body: 'The gerbil likes tunnels.', tags: ['pets'] }, 'alice')
    await kb.idle()
    expect(u).toMatchObject({ version: 2, title: 'Pets', body: 'The gerbil likes tunnels.', tags: ['pets'] })
    expect(await hitsOf(kb, id, 'hamster')).toHaveLength(0)
    expect((await hitsOf(kb, id, 'gerbil'))[0]).toMatchObject({ entryVersion: 2, kind: 'entry' })
    expect(await hitsOf(kb, id, 'gerbil', ['pets'])).toHaveLength(1)
    const history = await kb.entryHistory(id, e.id)
    expect(history.map(h => [h.version, h.op, h.actor])).toEqual([[2, 'update', 'alice'], [1, 'create', 'admin']])
    expect(history[1]).toMatchObject({ title: 'Pets', bodyLength: 'The hamster likes wheels.'.length })
    expect((await kb.entryVersion(id, e.id, 1)).body).toBe('The hamster likes wheels.')

    const err = await codeOf(kb.updateEntry(id, e.id, { baseVersion: 1, title: 'Late' }, 'bob'))
    expect(err.code).toBe('version-conflict')
    expect(err.data).toMatchObject({ code: 'version_conflict', current: { id: e.id, version: 2, body: 'The gerbil likes tunnels.' } })
    expect((await kb.getEntry(id, e.id)).title).toBe('Pets')
    await expectCode(kb.entryVersion(id, e.id, 9), 'version-not-found')
  })

  test('an update while the entry is still being embedded cancels that job and ends up ready', async () => {
    const f = fake('embed-a')
    const { kb, id } = await setup(f)
    let release!: () => void
    f.gate = new Promise<void>((r) => { release = r })
    const e = await kb.addEntry(id, { title: 'Slow', body: 'First text about walruses.' }, 'admin')
    await new Promise(r => setTimeout(r, 20))
    const u = await kb.updateEntry(id, e.id, { baseVersion: 1, body: 'Second text about narwhals.' }, 'admin')
    release()
    await kb.idle()
    expect(u.version).toBe(2)
    expect(await kb.getEntry(id, e.id)).toMatchObject({ status: 'ready' })
    expect(await hitsOf(kb, id, 'walruses')).toHaveLength(0)
    expect(await hitsOf(kb, id, 'narwhals')).toHaveLength(1)
    expect((await kb.search([id], 'narwhals')).mode).toBe('hybrid')
  })

  test('deleteEntry moves it to the trash; restore brings it back; purge only works from the trash and removes the history', async () => {
    const { kb, id } = await setup()
    const e = await kb.addEntry(id, { title: 'Birds', body: 'The heron stands still.', tags: ['birds'] }, 'admin')
    await kb.idle()
    await expectCode(kb.purge(id, e.id, 'admin'), 'not-in-trash')
    await expectCode(kb.restore(id, e.id, 'admin'), 'not-in-trash')
    await expectCode(kb.deleteEntry(id, e.id, { baseVersion: 3 }, 'admin'), 'version-conflict')
    await kb.deleteEntry(id, e.id, { baseVersion: 1 }, 'bob')

    expect(await hitsOf(kb, id, 'heron')).toHaveLength(0)
    expect((await kb.listEntries(id)).total).toBe(0)
    await expectCode(kb.getEntry(id, e.id), 'entry-not-found')
    await expectCode(kb.updateEntry(id, e.id, { baseVersion: 2, title: 'x' }, 'admin'), 'entry-not-found')
    const trash = await kb.listTrash(id)
    expect(trash).toEqual([expect.objectContaining({ id: e.id, kind: 'entry', name: 'Birds', version: 2 })])
    expect(await kb.get(id)).toMatchObject({ entryCount: 0, trashCount: 1, chunkCount: 0 })
    expect((await kb.entryHistory(id, e.id)).map(h => h.op)).toEqual(['delete', 'create'])

    await kb.restore(id, e.id, 'carol')
    await kb.idle()
    expect(await hitsOf(kb, id, 'heron', ['birds'])).toHaveLength(1)
    expect(await kb.getEntry(id, e.id)).toMatchObject({ version: 3, status: 'ready', body: 'The heron stands still.' })
    expect((await kb.entryHistory(id, e.id)).map(h => h.op)).toEqual(['restore', 'delete', 'create'])
    expect(await kb.listTrash(id)).toEqual([])

    await kb.deleteEntry(id, e.id, { baseVersion: 3 }, 'admin')
    await kb.purge(id, e.id, 'dave')
    expect(await kb.listTrash(id)).toEqual([])
    await expectCode(kb.entryHistory(id, e.id), 'entry-not-found')
    await expectCode(kb.purge(id, e.id, 'admin'), 'doc-not-found')
    const log = await kb.changes(id)
    expect(log[0]).toMatchObject({ op: 'purge', kind: 'entry', docId: e.id, name: 'Birds', actor: 'dave' })
    const check = await openDatabase(join(kbDir(kb), `${id}.sqlite`))
    try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM entry_versions').get<{ n: number }>()?.n).toBe(0)
    } finally {
      check.close()
    }
  })

  test('revertEntry makes a new version with the old content and keeps the history', async () => {
    const { kb, id } = await setup()
    const e = await kb.addEntry(id, { title: 'One', body: 'Original text about otters.', tags: ['x'] }, 'admin')
    await kb.updateEntry(id, e.id, { baseVersion: 1, title: 'Two', body: 'Changed text about badgers.', tags: ['y'] }, 'admin')
    await kb.idle()
    const r = await kb.revertEntry(id, e.id, { baseVersion: 2, toVersion: 1 }, 'erin')
    await kb.idle()
    expect(r).toMatchObject({ version: 3, title: 'One', body: 'Original text about otters.', tags: ['x'] })
    expect(await hitsOf(kb, id, 'badgers')).toHaveLength(0)
    expect(await hitsOf(kb, id, 'otters', ['x'])).toHaveLength(1)
    expect((await kb.entryHistory(id, e.id)).map(h => [h.version, h.op])).toEqual([[3, 'revert'], [2, 'update'], [1, 'create']])
    await expectCode(kb.revertEntry(id, e.id, { baseVersion: 3, toVersion: 7 }, 'erin'), 'version-not-found')
    await expectCode(kb.revertEntry(id, e.id, { baseVersion: 2, toVersion: 1 }, 'erin'), 'version-conflict')
  })

  test('validation: title, body and tag limits, missing baseVersion, empty update', async () => {
    const { kb, id } = await setup()
    await expectCode(kb.addEntry(id, { title: '', body: 'x' }, 'a'), 'bad-title')
    await expectCode(kb.addEntry(id, { title: '   ', body: 'x' }, 'a'), 'bad-title')
    await expectCode(kb.addEntry(id, { title: 'x'.repeat(201), body: 'x' }, 'a'), 'bad-title')
    await expectCode(kb.addEntry(id, { title: 't', body: '  \n ' }, 'a'), 'bad-entry-body')
    await expectCode(kb.addEntry(id, { title: 't', body: 'x'.repeat(MAX_ENTRY_BODY + 1) }, 'a'), 'bad-entry-body')
    await expectCode(kb.addEntry(id, { title: 't', body: 'x', tags: 'a' }, 'a'), 'bad-tags')
    await expectCode(kb.addEntry(id, { title: 't', body: 'x', tags: [1] }, 'a'), 'bad-tags')
    await expectCode(kb.addEntry(id, { title: 't', body: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'a'), 'bad-tags')
    const ok = await kb.addEntry(id, { title: 'x'.repeat(200), body: 'y'.repeat(MAX_ENTRY_BODY), tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }, 'a'.repeat(200))
    expect(ok.tags).toHaveLength(20)
    expect((await kb.changes(id))[0]!.actor).toHaveLength(80)
    // 25 values that collapse to 20 distinct tags are fine.
    await kb.addEntry(id, { title: 'dups', body: 'z', tags: [...Array.from({ length: 20 }, (_, i) => `t${i}`), 't0', 't1'] }, 'a')

    await expectCode(kb.updateEntry(id, ok.id, { title: 'n' } as never, 'a'), 'bad-base-version')
    await expectCode(kb.updateEntry(id, ok.id, { baseVersion: '1', title: 'n' }, 'a'), 'bad-base-version')
    await expectCode(kb.updateEntry(id, ok.id, { baseVersion: 1.5, title: 'n' }, 'a'), 'bad-base-version')
    await expectCode(kb.updateEntry(id, ok.id, { baseVersion: 1 }, 'a'), 'bad-body')
    await expectCode(kb.updateEntry(id, ok.id, { baseVersion: 1, title: '' }, 'a'), 'bad-title')
    await expectCode(kb.deleteEntry(id, ok.id, {}, 'a'), 'bad-base-version')
    await expectCode(kb.revertEntry(id, ok.id, { toVersion: 1 }, 'a'), 'bad-base-version')
    await expectCode(kb.getEntry(id, 999), 'entry-not-found')
  })

  test('writes are refused while a re-index runs', async () => {
    const f = fake('embed-a')
    const { kb, id } = await setup(f)
    const e = await kb.addEntry(id, { title: 'T', body: 'some text' }, 'a')
    await kb.idle()
    let release!: () => void
    f.gate = new Promise<void>((r) => { release = r })
    await kb.reindex(id)
    await expectCode(kb.addEntry(id, { title: 'U', body: 'more' }, 'a'), 'busy')
    await expectCode(kb.updateEntry(id, e.id, { baseVersion: 1, title: 'V' }, 'a'), 'busy')
    await expectCode(kb.deleteEntry(id, e.id, { baseVersion: 1 }, 'a'), 'busy')
    await expectCode(kb.addSourceText(id, { name: 'n', text: 'x' }, 'a'), 'busy')
    release()
    await kb.idle()
    expect((await kb.getEntry(id, e.id)).version).toBe(1)
  })
})

describe('sources, trash and duplicates', () => {
  test('a source with stored text goes to the trash and can be restored', async () => {
    const { kb, id } = await setup()
    const d = await kb.addDocument(id, { name: 'a.txt', bytes: enc('Notes about the capybara.') })
    await kb.idle()
    expect(await hitsOf(kb, id, 'capybara')).toHaveLength(1)
    expect(await kb.removeDocument(id, d.id, 'frank')).toEqual({ trashed: true })
    expect(await kb.listDocuments(id)).toEqual([])
    expect(await hitsOf(kb, id, 'capybara')).toHaveLength(0)
    expect(await kb.listTrash(id)).toEqual([expect.objectContaining({ id: d.id, kind: 'source', name: 'a.txt', version: null })])
    expect(await kb.get(id)).toMatchObject({ docCount: 0, trashCount: 1 })
    await expectCode(kb.removeDocument(id, d.id, 'frank'), 'doc-not-found')
    await kb.restore(id, d.id, 'frank')
    await kb.idle()
    expect(await hitsOf(kb, id, 'capybara')).toHaveLength(1)
    expect(await kb.listDocuments(id)).toEqual([expect.objectContaining({ id: d.id, status: 'ready', chunkCount: 1 })])
    expect((await kb.changes(id)).map(c => [c.op, c.kind, c.actor])).toEqual([['restore', 'source', 'frank'], ['delete', 'source', 'frank'], ['add', 'source', 'admin']])
  })

  test('a source without stored text is deleted for good', async () => {
    const { kb, id, file } = await setup()
    const d = await kb.addDocument(id, { name: 'old.txt', bytes: enc('Legacy text about lemurs.') })
    await kb.idle()
    const raw = await openDatabase(file)
    raw.prepare('UPDATE documents SET raw = NULL WHERE id = ?').run(d.id)
    raw.close()
    expect(await kb.removeDocument(id, d.id, 'admin')).toEqual({ trashed: false })
    expect(await kb.listTrash(id)).toEqual([])
    expect(await kb.listDocuments(id)).toEqual([])
    expect(await hitsOf(kb, id, 'lemurs')).toHaveLength(0)
    expect((await kb.changes(id))[0]).toMatchObject({ op: 'purge', kind: 'source', name: 'old.txt' })
  })

  test('a copy in the trash does not block a re-upload; a live copy does', async () => {
    const { kb, id } = await setup()
    const bytes = enc('Same bytes about marmots.')
    const a = await kb.addDocument(id, { name: 'a.txt', bytes })
    await kb.removeDocument(id, a.id, 'admin')
    const b = await kb.addDocument(id, { name: 'b.txt', bytes })
    await expectCode(kb.addDocument(id, { name: 'c.txt', bytes }), 'duplicate')
    // Restoring the old copy would now make a duplicate.
    await expectCode(kb.restore(id, a.id, 'admin'), 'duplicate')
    await kb.removeDocument(id, b.id, 'admin')
    await kb.restore(id, a.id, 'admin')
    await kb.idle()
    expect(await kb.listDocuments(id)).toHaveLength(1)
    // An entry with the same text is never a duplicate.
    await kb.addEntry(id, { title: 'Same', body: 'Same bytes about marmots.' }, 'admin')
    await kb.addEntry(id, { title: 'Same again', body: 'Same bytes about marmots.' }, 'admin')
    await kb.idle()
    expect((await kb.listEntries(id)).total).toBe(2)
  })

  test('addSourceText names, tags and readSource paging', async () => {
    const { kb, id } = await setup()
    const text = 'Lorem ipsum dolor. '.repeat(2400)
    const d = await kb.addSourceText(id, { name: 'story', text, tags: ['b', 'a', 'b', 'x,y]'] }, 'gina')
    await kb.idle()
    expect(d.name).toBe('story.txt')
    expect((await kb.listDocuments(id))[0]!.tags).toEqual(['a', 'b', 'x y'])
    const md = await kb.addSourceText(id, { name: 'notes.md', text: '# Head\n\nBody about okapis.' }, 'gina')
    expect(md.name).toBe('notes.md')
    await expectCode(kb.addSourceText(id, { name: 'story2', text, tags: ['b', 'a', 'x,y]'] }, 'gina'), 'duplicate')
    await expectCode(kb.addSourceText(id, { name: '', text: 'x' }, 'gina'), 'bad-doc-name')
    await expectCode(kb.addSourceText(id, { name: 'n', text: '  ' }, 'gina'), 'empty-file')
    await expectCode(kb.addSourceText(id, { name: 'n', text: 'x', tags: 'a' }, 'gina'), 'bad-tags')
    expect((await hitsOf(kb, id, 'dolor', ['a']))).not.toHaveLength(0)

    const first = await kb.readSource(id, d.id, {})
    expect(first.text.startsWith('[tag:b,a,x y]\n')).toBe(true)
    expect(first).toMatchObject({ offset: 0, nextOffset: MAX_READ_LENGTH, name: 'story.txt' })
    expect(first.text).toHaveLength(MAX_READ_LENGTH)
    expect(first.totalChars).toBe('[tag:b,a,x y]\n'.length + text.length)
    let all = first.text
    let next = first.nextOffset
    let pages = 1
    while (next !== null) {
      const page = await kb.readSource(id, d.id, { offset: next })
      all += page.text
      next = page.nextOffset
      pages++
    }
    expect(pages).toBe(Math.ceil(first.totalChars / MAX_READ_LENGTH))
    expect(all).toHaveLength(first.totalChars)
    expect((await kb.readSource(id, d.id, { offset: 5, length: 999_999 })).text).toHaveLength(MAX_READ_LENGTH)
    expect(await kb.readSource(id, d.id, { offset: 0, length: 0 })).toMatchObject({ nextOffset: 1 })
    expect(await kb.readSource(id, d.id, { offset: 10 ** 9 })).toMatchObject({ text: '', nextOffset: null, offset: first.totalChars })
    await expectCode(kb.readSource(id, 9999, {}), 'doc-not-found')
  })

  test('readSource refuses a source without stored text', async () => {
    const { kb, id, file } = await setup()
    const d = await kb.addDocument(id, { name: 'old.txt', bytes: enc('Legacy.') })
    const raw = await openDatabase(file)
    raw.prepare('UPDATE documents SET raw = NULL WHERE id = ?').run(d.id)
    raw.close()
    await expectCode(kb.readSource(id, d.id, {}), 'no-raw')
  })
})

describe('re-index', () => {
  test('entries are re-chunked as Markdown with the current chunk size; trashed rows are skipped', async () => {
    const f = fake('embed-a')
    const { kb, id } = await setup(f)
    const sentence = 'The platypus builds a burrow near the river bank. '
    const body = `# Habitat\n\n${sentence.repeat(10)}`
    const e = await kb.addEntry(id, { title: 'Platypus', body, tags: ['animals'] }, 'admin')
    const gone = await kb.addEntry(id, { title: 'Gone', body: 'Trashed text about pangolins.' }, 'admin')
    await kb.idle()
    await kb.deleteEntry(id, gone.id, { baseVersion: 1 }, 'admin')
    const trashedDoc = await kb.addDocument(id, { name: 't.txt', bytes: enc('Trashed source about tapirs.') })
    await kb.idle()
    await kb.removeDocument(id, trashedDoc.id, 'admin')
    const before = (await kb.get(id)).chunkCount
    expect(before).toBeGreaterThanOrEqual(1)

    await kb.update(id, { chunkSize: 100, chunkOverlap: 10 })
    await kb.reindex(id)
    await kb.idle()
    const view = await kb.get(id)
    expect(view.chunkCount).toBeGreaterThan(before)
    expect(view).toMatchObject({ reindexNeeded: false, trashCount: 2, entryCount: 1 })
    const hits = await hitsOf(kb, id, 'platypus', ['animals'])
    expect(hits.length).toBeGreaterThan(1)
    expect(hits[0]).toMatchObject({ kind: 'entry', docId: e.id, headingPath: 'Platypus > Habitat' })
    expect(await hitsOf(kb, id, 'pangolins')).toHaveLength(0)
    expect(await hitsOf(kb, id, 'tapirs')).toHaveLength(0)
    // Trashed rows have no chunks and are not stuck as indexing; they restore fine afterwards.
    const check = await openDatabase(join(kbDir(kb), `${id}.sqlite`))
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_id IN (?, ?)").get<{ n: number }>(gone.id, trashedDoc.id)?.n).toBe(0)
      expect(check.prepare("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL AND status = 'indexing'").get<{ n: number }>()?.n).toBe(0)
    } finally {
      check.close()
    }
    await kb.restore(id, gone.id, 'admin')
    await kb.idle()
    expect(await hitsOf(kb, id, 'pangolins')).toHaveLength(1)
  })
})

describe('guide', () => {
  test('default vs custom, revision, reset and limit', async () => {
    const { kb, id } = await setup()
    const d = kb.guide(id)
    expect(d).toMatchObject({ guide: t.kb.defaultGuide, custom: '', isDefault: true })
    expect(d.guide.length).toBeGreaterThan(50)
    expect(d.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(d.rev).toBe(guideRev(t.kb.defaultGuide))

    await kb.update(id, { guide: 'My own rules.' })
    const c = kb.guide(id)
    expect(c).toMatchObject({ guide: 'My own rules.', custom: 'My own rules.', isDefault: false })
    expect(c.rev).not.toBe(d.rev)
    expect((await kb.get(id)).guide).toBe('My own rules.')

    await kb.update(id, { guide: 'x'.repeat(20_000) })
    expect(kb.guide(id).guide).toHaveLength(20_000)
    await expectCode(kb.update(id, { guide: 'x'.repeat(20_001) }), 'bad-guide')
    await expectCode(kb.update(id, { guide: 5 }), 'bad-guide')
    expect(kb.guide(id).guide).toHaveLength(20_000)

    await kb.update(id, { guide: '' })
    expect(kb.guide(id)).toEqual(d)
    expect(guideRev('a')).toBe(guideRev('a'))
    expect(guideRev('a')).not.toBe(guideRev('b'))
    await expectCode(Promise.resolve().then(() => kb.guide('kb-nope0000')), 'not-found')
  })
})

describe('change log', () => {
  test('newest first, limit and before, actors recorded', async () => {
    const { kb, id } = await setup()
    const e = await kb.addEntry(id, { title: 'A', body: 'one' }, 'admin')
    await kb.updateEntry(id, e.id, { baseVersion: 1, body: 'two' }, 'key:robot')
    await kb.addSourceText(id, { name: 's', text: 'three' }, 'local')
    await kb.deleteEntry(id, e.id, { baseVersion: 2 }, 'admin')
    await kb.idle()
    const all = await kb.changes(id)
    expect(all.map(c => [c.op, c.kind, c.actor])).toEqual([
      ['delete', 'entry', 'admin'], ['add', 'source', 'local'], ['update', 'entry', 'key:robot'], ['create', 'entry', 'admin'],
    ])
    expect(all[0]).toMatchObject({ docId: e.id, version: 3, name: 'A' })
    expect(all[1]).toMatchObject({ version: null, name: 's.txt' })
    expect(all[0]!.at).toBeGreaterThan(0)
    const two = await kb.changes(id, { limit: 2 })
    expect(two).toHaveLength(2)
    const older = await kb.changes(id, { before: two[1]!.id })
    expect(older.map(c => c.op)).toEqual(['update', 'create'])
    expect(older.every(c => c.id < two[1]!.id)).toBe(true)
    expect((await kb.changes(id, { limit: 0 }))).toHaveLength(1)
    expect((await kb.changes(id, { limit: 100_000 })).length).toBe(4)
  })
})
