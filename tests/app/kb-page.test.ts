import { expect, test } from 'bun:test'
import { checkKbFile, jobsKey, KB_ACCEPT, KB_DEFAULT_CHUNK_OVERLAP, KB_DEFAULT_CHUNK_SIZE, KB_EXTENSIONS, KB_MAX_UPLOAD_BYTES, KB_SOFT_CHUNK_LIMIT } from '../../app/utils/kb'
import { MAX_UPLOAD_BYTES } from '../../server/core/kb/manager'
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
