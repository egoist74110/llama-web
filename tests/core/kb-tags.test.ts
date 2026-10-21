// Tags and the similarity floor, the pure parts (decision 65 ⑭): tag lines, forced chunk boundaries, the schema 1 -> 2
// migration, binding fields, search request filters and tool-call arguments. Manager-level search tests are in
// kb-store.test.ts (they need its fake embedder).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale, t } from '../../server/core/i18n'
import { chunkText, type Chunk } from '../../server/core/kb/chunk'
import { normalizeBinding, parseBinding, resolveKnowledge } from '../../server/core/kb/binding'
import { toolDefinition } from '../../server/core/kb/inject'
import { KbDb, KB_SCHEMA_VERSION } from '../../server/core/kb/kb-db'
import { KbError } from '../../server/core/kb/errors'
import { parseSearchFilters } from '../../server/core/kb/search'
import { openDatabase } from '../../server/core/kb/sqlite'
import { cleanSimilarity, cleanTags, parseTagLine } from '../../server/core/kb/tags'
import { parseSearchArguments } from '../../server/core/kb/tool-loop'

setLocale('zh-CN')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'llama-web-kbtags-'))
  dirs.push(d)
  return d
}

const txt = (text: string, chunkSize = 500, overlap = 80) => chunkText(text, { kind: 'txt', chunkSize, overlap })
const md = (text: string, chunkSize = 500, overlap = 80) => chunkText(text, { kind: 'md', chunkSize, overlap })
const slices = (text: string, chunks: Chunk[]) => chunks.every(c => c.text === text.slice(c.startChar, c.endChar))

describe('parseTagLine', () => {
  test('the whole line is the tag line; case, spaces and both commas are fine', () => {
    expect(parseTagLine('[tag:a]')).toEqual(['a'])
    expect(parseTagLine('[TAG: a , b ，c ]')).toEqual(['a', 'b', 'c'])
    expect(parseTagLine('  \t[Tag:数学]  ')).toEqual(['数学'])
    expect(parseTagLine('[tag:a]\r')).toEqual(['a'])
  })

  test('empty values are dropped, duplicates removed in order; nothing left = clear', () => {
    expect(parseTagLine('[tag:]')).toEqual([])
    expect(parseTagLine('[tag: , ，]')).toEqual([])
    expect(parseTagLine('[tag:b,a,b,,a]')).toEqual(['b', 'a'])
  })

  test('a tag is cut at 64 characters, a line keeps 20 tags', () => {
    expect(parseTagLine(`[tag:${'x'.repeat(80)}]`)).toEqual(['x'.repeat(64)])
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`)
    expect(parseTagLine(`[tag:${many.join(',')}]`)).toEqual(many.slice(0, 20))
  })

  test('anything else on the line makes it ordinary text', () => {
    for (const line of ['[tag:a] more', 'x [tag:a]', '[tag:a', 'tag:a', '[tags:a]', '[tag:a]]', '']) expect(parseTagLine(line)).toBeNull()
  })
})

describe('chunking with tag lines', () => {
  const TEXT = '开头没有标签。\n\n[tag:A]\n甲一。\n\n甲二。\n\n[tag:B,C]\n乙一。\n\n[tag:]\n无标签。'

  test('tags follow the lines; tag lines are in no chunk; chunks stay exact slices', () => {
    const chunks = txt(TEXT)
    expect(chunks.map(c => [c.text, c.tags])).toEqual([
      ['开头没有标签。', []],
      ['甲一。\n\n甲二。', ['A']],
      ['乙一。', ['B', 'C']],
      ['无标签。', []],
    ])
    expect(chunks.every(c => !c.text.includes('[tag:'))).toBe(true)
    expect(slices(TEXT, chunks)).toBe(true)
    expect(chunks.map(c => c.ord)).toEqual([0, 1, 2, 3])
    for (const c of chunks) expect(c.startLine).toBe(TEXT.slice(0, c.startChar).split('\n').length)
  })

  test('two short paragraphs with different tags never merge, even without blank lines around the tag line', () => {
    const text = '[tag:A]\n一。\n[tag:B]\n二。'
    const chunks = txt(text)
    expect(chunks.map(c => [c.text, c.tags])).toEqual([['一。', ['A']], ['二。', ['B']]])
    expect(slices(text, chunks)).toBe(true)
  })

  test('the same tag line twice still starts a new chunk', () => {
    const chunks = txt('[tag:A]\n一。\n[tag:A]\n二。')
    expect(chunks.map(c => c.text)).toEqual(['一。', '二。'])
  })

  test('overlap does not cross a tag line', () => {
    const a = Array.from({ length: 20 }, (_, i) => `甲${i}段落的内容比较长一些。`).join('')
    const b = Array.from({ length: 20 }, (_, i) => `乙${i}段落的内容比较长一些。`).join('')
    const text = `[tag:A]\n${a}\n[tag:B]\n${b}`
    const chunks = txt(text, 100, 40)
    expect(chunks.length).toBeGreaterThan(4)
    for (const c of chunks) {
      expect(c.tags.length).toBe(1)
      expect(c.text.includes('甲') && c.text.includes('乙')).toBe(false)
      expect(c.tags[0] === 'A' ? c.text.includes('乙') : c.text.includes('甲')).toBe(false)
    }
    expect(chunks.some(c => c.tags[0] === 'A')).toBe(true)
    expect(chunks.some(c => c.tags[0] === 'B')).toBe(true)
    expect(slices(text, chunks)).toBe(true)
  })

  test('no tag lines: nothing changes (no tags on any chunk)', () => {
    const text = '一。\n\n二。\n\n三。'
    const chunks = txt(text)
    expect(chunks.map(c => c.text)).toEqual(['一。\n\n二。\n\n三。'])
    expect(chunks[0]!.tags).toEqual([])
  })

  test('CRLF files work too', () => {
    const text = '[tag:A]\r\n甲。\r\n\r\n[tag:B]\r\n乙。'
    const chunks = txt(text)
    expect(chunks.map(c => [c.text, c.tags])).toEqual([['甲。', ['A']], ['乙。', ['B']]])
    expect(slices(text, chunks)).toBe(true)
  })

  test('markdown: headings split as before and keep the tags; the heading path continues across a tag line', () => {
    const text = '# 一\n\n[tag:A]\n\n甲。\n\n## 二\n\n乙。\n\n[tag:B]\n\n丙。'
    const chunks = md(text)
    expect(chunks.map(c => [c.headingPath, c.text, c.tags])).toEqual([
      ['一', '# 一', []],
      ['一', '甲。', ['A']],
      ['一 > 二', '## 二\n\n乙。', ['A']],
      ['一 > 二', '丙。', ['B']],
    ])
    expect(slices(text, chunks)).toBe(true)
  })

  test('markdown: a tag line inside a code fence is text, outside it is a tag line', () => {
    const text = '```\n[tag:A]\n```\n\n[tag:B]\n\n正文。'
    const chunks = md(text)
    expect(chunks.map(c => [c.text, c.tags])).toEqual([['```\n[tag:A]\n```', []], ['正文。', ['B']]])
    const tilde = md('~~~\n[tag:A]\n~~~\n\n后面。')
    expect(tilde.every(c => c.tags.length === 0)).toBe(true)
    expect(tilde[0]!.text).toContain('[tag:A]')
  })

  test('text files have no fences: the same lines are tag lines', () => {
    const chunks = txt('```\n[tag:A]\n```\n\n正文。')
    expect(chunks.map(c => [c.text, c.tags])).toEqual([['```', []], ['```\n\n正文。', ['A']]])
  })

  test('a file of tag lines only has no chunk', () => {
    expect(txt('[tag:A]\n\n[tag:B]\n')).toEqual([])
  })
})

describe('schema 2', () => {
  test('a schema 1 file is migrated in place: raw / tags columns appear, old rows stay valid', async () => {
    const dir = tmp()
    const file = join(dir, 'old.sqlite')
    const raw = await openDatabase(file)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, source TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        mtime INTEGER NOT NULL, added_at INTEGER NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error_code TEXT, error_detail TEXT
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
        start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, start_line INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX chunks_doc ON chunks (doc_id, ord);
      CREATE TABLE vectors (chunk_id INTEGER PRIMARY KEY, blob BLOB NOT NULL);
      CREATE VIRTUAL TABLE fts USING fts5(tokens, tokenize = 'unicode61 remove_diacritics 0');
      INSERT INTO meta (key, value) VALUES ('schema', '1');
      INSERT INTO documents (name, source, size, sha256, mtime, added_at, chunk_count, status) VALUES ('old.txt', 'old.txt', 3, 'abc', 1, 1, 1, 'ready');
      INSERT INTO chunks (doc_id, ord, text, start_char, end_char, start_line) VALUES (1, 0, 'hello', 0, 5, 1);
      INSERT INTO fts (rowid, tokens) VALUES (1, 'hello');
    `)
    raw.close()

    expect(KB_SCHEMA_VERSION).toBe(2)
    const db = await KbDb.open(file)
    try {
      expect(db.listDocuments()).toEqual([expect.objectContaining({ name: 'old.txt', hasRaw: false, tags: [], chunkCount: 1 })])
      expect(db.getRaw(1)).toBeNull()
      expect(db.listTags()).toEqual([])
      expect(db.keywordSearch('"hello"', 5)).toHaveLength(1)
      const chunk: Chunk = { ord: 0, text: 'x', startChar: 0, endChar: 1, startLine: 1, headingPath: '', tags: ['A'] }
      const id = db.insertDocument({ name: 'n.txt', source: 'n.txt', size: 1, sha256: 'def', mtime: 1, addedAt: 1, raw: 'x' }, [chunk])
      expect(db.getDocument(id)).toMatchObject({ hasRaw: true, tags: ['A'] })
      expect(db.listTags()).toEqual([{ tag: 'A', count: 1 }])
    } finally {
      db.close()
    }
    // Opening again does not migrate twice.
    const again = await KbDb.open(file)
    try {
      expect(again.listTags()).toEqual([{ tag: 'A', count: 1 }])
    } finally {
      again.close()
    }
  })

  test('a new file is created at schema 2; replaceChunks and deleteDocument keep tags in step', async () => {
    const dir = tmp()
    const db = await KbDb.open(join(dir, 'new.sqlite'))
    try {
      const mk = (text: string, tags: string[], ord = 0): Chunk => ({ ord, text, startChar: 0, endChar: text.length, startLine: 1, headingPath: '', tags })
      const id = db.insertDocument({ name: 'a.txt', source: 'a.txt', size: 1, sha256: 'a', mtime: 1, addedAt: 1, raw: 'raw text' }, [mk('one', ['A', 'B']), mk('two', ['B'], 1)])
      expect(db.listTags()).toEqual([{ tag: 'A', count: 1 }, { tag: 'B', count: 2 }])
      expect(db.getDocument(id)!.tags).toEqual(['A', 'B'])
      expect(db.chunkIdsWithTags(['A']).size).toBe(1)
      expect(db.chunkIdsWithTags(['A', 'B']).size).toBe(2)
      expect(db.chunkIdsWithTags([]).size).toBe(0)
      expect(db.getRaw(id)).toBe('raw text')

      db.replaceChunks(id, [mk('three', ['C'])])
      expect(db.listTags()).toEqual([{ tag: 'C', count: 1 }])
      expect(db.countChunks()).toBe(1)
      expect(db.getDocument(id)).toMatchObject({ chunkCount: 1, tags: ['C'] })
      expect(db.keywordSearch('"one"', 5)).toEqual([])
      expect(db.keywordSearch('"three"', 5)).toHaveLength(1)

      expect(db.deleteDocument(id)).toBe(true)
      expect(db.listTags()).toEqual([])
      expect(db.countChunks()).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('binding fields', () => {
  test('normalizeBinding repairs tags and minSimilarity; missing fields take the defaults', () => {
    expect(normalizeBinding({ enabled: true })).toMatchObject({ tags: [], minSimilarity: null })
    expect(normalizeBinding({ tags: [' a ', 'a', '', 3, 'b'], minSimilarity: 0.4 })).toMatchObject({ tags: ['a', 'b'], minSimilarity: 0.4 })
    expect(normalizeBinding({ tags: 'a', minSimilarity: 'x' })).toMatchObject({ tags: [], minSimilarity: null })
    expect(normalizeBinding({ minSimilarity: 5 })).toMatchObject({ minSimilarity: 1 })
    expect(normalizeBinding({ minSimilarity: -1 })).toMatchObject({ minSimilarity: 0 })
    expect(normalizeBinding({ tags: Array.from({ length: 80 }, (_, i) => `t${i}`) }).tags).toHaveLength(50)
  })

  test('parseBinding refuses wrong types and out-of-range numbers', () => {
    expect(parseBinding({ enabled: true, tags: ['a', 'a', 'b'], minSimilarity: 0.25 })).toMatchObject({ tags: ['a', 'b'], minSimilarity: 0.25 })
    expect(parseBinding({ minSimilarity: null })).toMatchObject({ minSimilarity: null })
    expect(parseBinding({})).toMatchObject({ tags: [], minSimilarity: null })
    for (const bad of [{ tags: 'a' }, { tags: [1] }, { tags: [null] }, { minSimilarity: 'x' }, { minSimilarity: 1.5 }, { minSimilarity: -0.1 }, { minSimilarity: Number.NaN }]) {
      expect(() => parseBinding(bad)).toThrow()
    }
  })

  test('resolveKnowledge: the request replaces tags / min_similarity; absent fields keep the binding', () => {
    const bases = [{ id: 'kb-aaaa1111', name: 'Manual' }]
    const binding = { enabled: true, all: false, kbs: ['kb-aaaa1111'], mode: 'inject' as const, topK: 5, tags: ['A'], minSimilarity: 0.6 }
    const run = (raw: unknown) => resolveKnowledge({ binding, raw, bases, allowed: null })
    expect(run(undefined)).toMatchObject({ effective: { tags: ['A'], minSimilarity: 0.6 } })
    expect(run({ top_k: 3 })).toMatchObject({ effective: { tags: ['A'], minSimilarity: 0.6, topK: 3 } })
    expect(run({ tags: ['B', 'B', 'C'] })).toMatchObject({ effective: { tags: ['B', 'C'], minSimilarity: 0.6 } })
    expect(run({ tags: [] })).toMatchObject({ effective: { tags: [] } })
    expect(run({ min_similarity: null })).toMatchObject({ effective: { tags: ['A'], minSimilarity: null } })
    expect(run({ min_similarity: 0 })).toMatchObject({ effective: { minSimilarity: 0 } })
    for (const bad of [{ tags: 'A' }, { tags: [1] }, { min_similarity: '0.5' }, { min_similarity: 1.1 }, { min_similarity: -1 }]) {
      expect(run(bad)).toMatchObject({ ok: false, code: 'invalid_knowledge' })
    }
    // No binding at all: defaults.
    expect(resolveKnowledge({ binding: null, raw: { kbs: ['Manual'] }, bases, allowed: null })).toMatchObject({ effective: { tags: [], minSimilarity: null } })
  })
})

describe('search filters', () => {
  test('cleanTags / cleanSimilarity are forgiving', () => {
    expect(cleanTags(['a', ' a', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(cleanTags('a')).toEqual([])
    expect(cleanSimilarity(0.5)).toBe(0.5)
    expect(cleanSimilarity(2)).toBe(1)
    expect(cleanSimilarity('0.5')).toBeNull()
    expect(cleanSimilarity(Number.NaN)).toBeNull()
  })

  test('parseSearchFilters is strict: wrong types are KbErrors', () => {
    expect(parseSearchFilters({})).toEqual({ tags: [], minSimilarity: null })
    expect(parseSearchFilters({ tags: null, minSimilarity: null })).toEqual({ tags: [], minSimilarity: null })
    expect(parseSearchFilters({ tags: ['a', 'a', 'b'], minSimilarity: 0.3 })).toEqual({ tags: ['a', 'b'], minSimilarity: 0.3 })
    const code = (body: Record<string, unknown>) => { try { parseSearchFilters(body) } catch (e) { return (e as KbError).code } return null }
    expect(code({ tags: 'a' })).toBe('bad-tags')
    expect(code({ tags: [1] })).toBe('bad-tags')
    expect(code({ minSimilarity: '0.5' })).toBe('bad-similarity')
    expect(code({ minSimilarity: 1.5 })).toBe('bad-similarity')
    expect(code({ minSimilarity: -0.5 })).toBe('bad-similarity')
    expect((t.kb.errors as Record<string, string>)['bad-tags']).toBeTruthy()
    expect((t.kb.errors as Record<string, string>)['bad-similarity']).toBeTruthy()
  })
})

describe('tool definition and arguments', () => {
  const counts = (n: number) => Array.from({ length: n }, (_, i) => ({ tag: `t${String(i).padStart(3, '0')}`, count: i + 1 }))
  const props = (n: number) => (toolDefinition(['Manual'], counts(n)).function.parameters.properties as Record<string, any>)

  test('no tags: no tags parameter', () => {
    expect(props(0)).not.toHaveProperty('tags')
    expect(toolDefinition(['Manual']).function.parameters.properties).not.toHaveProperty('tags')
  })

  test('up to 50 tags: an enum; 51 or more: plain strings and the description names the 50 biggest', () => {
    expect(props(1).tags.items.enum).toEqual(['t000'])
    expect(props(50).tags.items.enum).toHaveLength(50)
    expect(props(50).tags.description).toBe(t.kbPrompt.toolTags)
    const many = props(51).tags
    expect(many.items).toEqual({ type: 'string' })
    expect(many.description).toContain('t050')
    expect(many.description).toContain('t001')
    expect(many.description).not.toContain('t000')
    expect(many.description).toContain('50')
  })

  test('parseSearchArguments reads tags as an array or one string and ignores anything else', () => {
    expect(parseSearchArguments('{"query":"q","tags":["a","b"]}')).toEqual({ query: 'q', tags: ['a', 'b'] })
    expect(parseSearchArguments('{"query":"q","tags":"a"}')).toEqual({ query: 'q', tags: ['a'] })
    expect(parseSearchArguments('{"query":"q","tags":[1,"a"," "]}')).toEqual({ query: 'q', tags: ['a'] })
    expect(parseSearchArguments('{"query":"q","tags":5}')).toEqual({ query: 'q' })
    expect(parseSearchArguments('{"query":"q","tags":{"a":1}}')).toEqual({ query: 'q' })
    expect(parseSearchArguments('{"query":"q","top_k":3}')).toEqual({ query: 'q', topK: 3 })
  })
})
