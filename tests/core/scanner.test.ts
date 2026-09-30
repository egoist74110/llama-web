import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFile, resolveFileRef, scanModelDirs } from '../../server/core/scanner'
import type { ModelDir } from '../../server/core/types'
import { modelSpec, mmprojSpec, writeGguf } from '../fixtures/gguf-builder'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lw-scan-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const dir = (over: Partial<ModelDir> = {}): ModelDir => ({ id: 'main', path: root, enabled: true, maxDepth: 4, ...over })

test('finds models recursively with metadata; ignores non-gguf files', async () => {
  writeGguf(join(root, 'a.gguf'), modelSpec({ arch: 'llama' }))
  writeGguf(join(root, 'sub', 'deep', 'b.GGUF'), modelSpec({ arch: 'qwen3' }))
  writeFileSync(join(root, 'notes.txt'), 'hi')
  const { entries, warnings } = await scanModelDirs([dir()])
  expect(warnings).toEqual([])
  expect(entries.map(e => e.ref.rel)).toEqual(['a.gguf', 'sub/deep/b.GGUF'])
  expect(entries.every(e => e.kind === 'model' && e.error === null)).toBe(true)
  expect(entries[1]!.meta?.architecture).toBe('qwen3')
  expect(entries[0]!.shards).toBeNull()
})

test('respects maxDepth and enabled', async () => {
  writeGguf(join(root, 'a.gguf'), modelSpec())
  writeGguf(join(root, 'l1', 'b.gguf'), modelSpec())
  writeGguf(join(root, 'l1', 'l2', 'c.gguf'), modelSpec())
  expect((await scanModelDirs([dir({ maxDepth: 0 })])).entries.map(e => e.ref.rel)).toEqual(['a.gguf'])
  expect((await scanModelDirs([dir({ maxDepth: 1 })])).entries.map(e => e.ref.rel)).toEqual(['a.gguf', 'l1/b.gguf'])
  expect((await scanModelDirs([dir({ enabled: false })])).entries).toEqual([])
})

test('skips hidden and system directories', async () => {
  writeGguf(join(root, '.cache', 'x.gguf'), modelSpec())
  writeGguf(join(root, '$RECYCLE.BIN', 'y.gguf'), modelSpec())
  writeGguf(join(root, 'ok', 'z.gguf'), modelSpec())
  expect((await scanModelDirs([dir()])).entries.map(e => e.ref.rel)).toEqual(['ok/z.gguf'])
})

test('reports missing directories and keeps scanning the others', async () => {
  writeGguf(join(root, 'a.gguf'), modelSpec())
  const { entries, warnings } = await scanModelDirs([
    dir({ id: 'gone', path: join(root, 'does-not-exist') }),
    dir(),
  ])
  expect(warnings).toEqual([{ code: 'dir-missing', dirId: 'gone', rel: '' }])
  expect(entries.map(e => `${e.ref.dirId}:${e.ref.rel}`)).toEqual(['main:a.gguf'])
})

test('merges shards into one entry with summed size', async () => {
  for (let i = 1; i <= 3; i++) writeGguf(join(root, 'big', `Big-0000${i}-of-00003.gguf`), modelSpec({ params: 1000 }))
  const { entries } = await scanModelDirs([dir()])
  expect(entries.length).toBe(1)
  const e = entries[0]!
  expect(e.ref.rel).toBe('big/Big-00001-of-00003.gguf')
  expect(e.shards).toEqual([1, 2, 3].map(i => `big/Big-0000${i}-of-00003.gguf`))
  expect(e.complete).toBe(true)
  expect(e.size).toBe(e.shards!.length * e.meta!.fileSize)
})

test('flags incomplete shard sets and sums tensor-derived parameter counts', async () => {
  writeGguf(join(root, 'Part-00001-of-00003.gguf'), modelSpec({ params: null }))
  writeGguf(join(root, 'Part-00003-of-00003.gguf'), modelSpec({ params: null }))
  const { entries } = await scanModelDirs([dir()])
  expect(entries.length).toBe(1)
  expect(entries[0]!.complete).toBe(false)
  expect(entries[0]!.meta!.parameterCount).toBe(2 * (4 * 8 + 16))
})

test('same base name with different shard totals stays separate', async () => {
  writeGguf(join(root, 'M-00001-of-00002.gguf'), modelSpec())
  writeGguf(join(root, 'M-00002-of-00002.gguf'), modelSpec())
  writeGguf(join(root, 'M-00001-of-00009.gguf'), modelSpec())
  const { entries } = await scanModelDirs([dir()])
  expect(entries.map(e => [e.complete, e.shards!.length])).toEqual([[true, 2], [false, 1]])
})

test('classifies mmproj and draft files and offers them as same-directory candidates only', async () => {
  writeGguf(join(root, 'q', 'Qwen.gguf'), modelSpec({ arch: 'qwen3' }))
  writeGguf(join(root, 'q', 'mmproj-BF16.gguf'), mmprojSpec())
  writeGguf(join(root, 'q', 'Qwen-MTP.gguf'), modelSpec({ arch: 'qwen3' }))
  writeGguf(join(root, 'other', 'Llama.gguf'), modelSpec())
  writeGguf(join(root, 'other', 'stray-mmproj.gguf'), mmprojSpec())
  const { entries } = await scanModelDirs([dir()])
  const byRel = Object.fromEntries(entries.map(e => [e.ref.rel, e]))
  expect(byRel['q/mmproj-BF16.gguf']!.kind).toBe('mmproj')
  expect(byRel['q/Qwen-MTP.gguf']!.kind).toBe('draft')
  const qwen = byRel['q/Qwen.gguf']!
  expect(qwen.kind).toBe('model')
  expect(qwen.candidates.mmproj).toEqual([{ dirId: 'main', rel: 'q/mmproj-BF16.gguf' }])
  expect(qwen.candidates.draft).toEqual([{ dirId: 'main', rel: 'q/Qwen-MTP.gguf' }])
  const llama = byRel['other/Llama.gguf']!
  expect(llama.candidates.mmproj).toEqual([{ dirId: 'main', rel: 'other/stray-mmproj.gguf' }])
  expect(llama.candidates.draft).toEqual([])
  // Candidates are never selected on their own: nothing else references them.
  expect(byRel['q/mmproj-BF16.gguf']!.candidates).toEqual({ mmproj: [], draft: [] })
})

test('unparseable files become invalid entries instead of aborting the scan', async () => {
  writeFileSync(join(root, 'broken.gguf'), 'this is not a gguf file at all, sorry')
  writeGguf(join(root, 'ok.gguf'), modelSpec())
  const { entries } = await scanModelDirs([dir()])
  expect(entries.map(e => [e.ref.rel, e.kind])).toEqual([['broken.gguf', 'invalid'], ['ok.gguf', 'model']])
  expect(entries[0]!.error).toBeTruthy()
  expect(entries[0]!.meta).toBeNull()
})

test('scans several directories and keeps their ids apart', async () => {
  const other = mkdtempSync(join(tmpdir(), 'lw-scan2-'))
  try {
    writeGguf(join(root, 'a.gguf'), modelSpec())
    writeGguf(join(other, 'a.gguf'), modelSpec())
    const { entries } = await scanModelDirs([dir(), dir({ id: 'second', path: other })])
    expect(entries.map(e => e.ref.dirId)).toEqual(['main', 'second'])
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('classifyFile name heuristics', () => {
  const meta = (arch: string) => ({ architecture: arch, type: null }) as any
  expect(classifyFile('mmproj-F16.gguf', meta('llama'))).toBe('mmproj')
  expect(classifyFile('x.gguf', meta('clip'))).toBe('mmproj')
  expect(classifyFile('model-draft.gguf', meta('llama'))).toBe('draft')
  expect(classifyFile('Qwen3-mtp-Q8.gguf', meta('qwen3'))).toBe('draft')
  expect(classifyFile('Qwen3-27B.gguf', meta('qwen3'))).toBe('model')
  expect(classifyFile('anything.gguf', null)).toBe('invalid')
})

test('resolveFileRef joins dir and rel, and rejects unknown dirs and traversal', () => {
  const dirs = [dir()]
  expect(resolveFileRef(dirs, { dirId: 'main', rel: 'a/b.gguf' })).toBe(join(root, 'a', 'b.gguf'))
  expect(resolveFileRef(dirs, { dirId: 'nope', rel: 'a.gguf' })).toBeNull()
  expect(resolveFileRef(dirs, { dirId: 'main', rel: '../evil.gguf' })).toBeNull()
  expect(resolveFileRef(dirs, { dirId: 'main', rel: 'a/../../evil.gguf' })).toBeNull()
  expect(resolveFileRef(dirs, { dirId: 'main', rel: '' })).toBeNull()
})
