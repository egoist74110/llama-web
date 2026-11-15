import { expect, test } from 'bun:test'
import { actorLabel, addTagsFromInput, conflictOf, checkKbFile, diffTags, jobsKey, mergeTags, parseSimilarity, sameTags, KB_ACCEPT, KB_MAX_ENTRY_BODY, KB_MAX_ENTRY_TAGS, KB_MAX_ENTRY_TITLE, KB_MAX_GUIDE, KB_MAX_TAG_LEN, KB_DEFAULT_CHUNK_OVERLAP, KB_DEFAULT_CHUNK_SIZE, KB_EXTENSIONS, KB_MAX_UPLOAD_BYTES, KB_SOFT_CHUNK_LIMIT } from '../../app/utils/kb'
import { MAX_ENTRY_BODY, MAX_ENTRY_TAGS, MAX_ENTRY_TITLE, MAX_UPLOAD_BYTES } from '../../server/core/kb/manager'
import { MAX_TAG_LEN } from '../../server/core/kb/tags'
import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, SOFT_CHUNK_LIMIT } from '../../server/core/kb/registry'

test('the page limits mirror the server ones', () => {
  expect(KB_MAX_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES)
  expect(KB_DEFAULT_CHUNK_SIZE).toBe(DEFAULT_CHUNK_SIZE)
  expect(KB_DEFAULT_CHUNK_OVERLAP).toBe(DEFAULT_CHUNK_OVERLAP)
  expect(KB_SOFT_CHUNK_LIMIT).toBe(SOFT_CHUNK_LIMIT)
  expect(KB_ACCEPT).toBe(KB_EXTENSIONS.join(','))
})

test('checkKbFile accepts .txt / .md / .markdown up to the limit and says why not otherwise', () => {
  expect(checkKbFile('a.txt', 10)).toBeNull()
  expect(checkKbFile('笔记.MD', 10)).toBeNull()
  expect(checkKbFile('x.markdown', 1)).toBeNull()
  expect(checkKbFile('a.txt', KB_MAX_UPLOAD_BYTES)).toBeNull()
  expect(checkKbFile('a.txt', KB_MAX_UPLOAD_BYTES + 1)).toBe('too-large')
  expect(checkKbFile('a.pdf', 10)).toBe('unsupported')
  expect(checkKbFile('noext', 10)).toBe('unsupported')
  expect(checkKbFile('dir.txt/file', 10)).toBe('unsupported')
})

test('jobsKey ignores progress and changes when a job starts, moves on or ends', () => {
  const a = { kind: 'import', kbId: 'kb-1', docId: 3, state: 'running', done: 1, total: 9 }
  expect(jobsKey([a])).toBe(jobsKey([{ ...a, done: 5 }]))
  expect(jobsKey([a])).not.toBe(jobsKey([{ ...a, state: 'queued' }]))
  expect(jobsKey([a])).not.toBe(jobsKey([]))
  expect(jobsKey([{ ...a, kind: 'reindex', docId: null }])).not.toBe(jobsKey([a]))
})

test('parseSimilarity: empty is off, 0 to 1 is valid, anything else is not', () => {
  expect(parseSimilarity('')).toEqual({ ok: true, value: null })
  expect(parseSimilarity('  ')).toEqual({ ok: true, value: null })
  expect(parseSimilarity(null)).toEqual({ ok: true, value: null })
  expect(parseSimilarity('0')).toEqual({ ok: true, value: 0 })
  expect(parseSimilarity('0.35')).toEqual({ ok: true, value: 0.35 })
  expect(parseSimilarity(1)).toEqual({ ok: true, value: 1 })
  for (const bad of ['1.01', '-0.1', 'abc', '2']) expect(parseSimilarity(bad).ok).toBe(false)
})

test('mergeTags adds counts across knowledge bases, sorts by tag and lists kept tags with 0', () => {
  expect(mergeTags([[{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }], [{ tag: 'b', count: 3 }]])).toEqual([{ tag: 'a', count: 1 }, { tag: 'b', count: 5 }])
  expect(mergeTags([[{ tag: 'a', count: 1 }]], ['a', 'gone'])).toEqual([{ tag: 'a', count: 1 }, { tag: 'gone', count: 0 }])
  expect(mergeTags([])).toEqual([])
})

test('the entry limits mirror the server ones', () => {
  expect(KB_MAX_ENTRY_TITLE).toBe(MAX_ENTRY_TITLE)
  expect(KB_MAX_ENTRY_BODY).toBe(MAX_ENTRY_BODY)
  expect(KB_MAX_ENTRY_TAGS).toBe(MAX_ENTRY_TAGS)
  expect(KB_MAX_TAG_LEN).toBe(MAX_TAG_LEN)
  expect(KB_MAX_GUIDE).toBe(20_000)
})

test('actorLabel reads admin / local / key:<name> as words and leaves the rest', () => {
  const labels = { admin: 'Admin page', local: 'Local / LAN', key: 'API key: {name}' }
  expect(actorLabel('admin', labels)).toBe('Admin page')
  expect(actorLabel('local', labels)).toBe('Local / LAN')
  expect(actorLabel('key:phone', labels)).toBe('API key: phone')
  expect(actorLabel('key:a:b', labels)).toBe('API key: a:b')
  expect(actorLabel('unknown', labels)).toBe('unknown')
  expect(actorLabel('', labels)).toBe('')
})

test('addTagsFromInput splits at commas and line breaks, drops duplicates and keeps within the limit', () => {
  expect(addTagsFromInput(['a'], ' b, a，c\n,d ')).toEqual({ tags: ['a', 'b', 'c', 'd'], full: false })
  expect(addTagsFromInput([], '   ')).toEqual({ tags: [], full: false })
  expect(addTagsFromInput([], 'x'.repeat(100)).tags[0]).toHaveLength(KB_MAX_TAG_LEN)
  expect(addTagsFromInput(['a', 'b'], 'c,d', 3)).toEqual({ tags: ['a', 'b', 'c'], full: true })
})

test('diffTags and sameTags', () => {
  expect(diffTags(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] })
  expect(sameTags(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(sameTags(['a', 'b'], ['b', 'a'])).toBe(false)
})

test('conflictOf finds the current entry of a version conflict in a fetch error', () => {
  const current = { id: 1, version: 4 }
  expect(conflictOf({ data: { statusCode: 409, data: { code: 'version_conflict', current } } })).toBe(current)
  expect(conflictOf({ data: { code: 'version_conflict', current } })).toBe(current)
  expect(conflictOf({ data: { statusCode: 409, message: 'x' } })).toBeNull()
  expect(conflictOf(new Error('boom'))).toBeNull()
  expect(conflictOf(null)).toBeNull()
})
