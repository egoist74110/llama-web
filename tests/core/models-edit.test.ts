import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelConfig, ModelsDoc } from '../../server/core/config'
import {
  applyFiles, createProfile, deleteProfile, FilesError, listTemplates, ProfileError, renameProfile,
  sanitizeForm, sanitizeOverrides, saveProfile, validateProfileName,
} from '../../server/core/models-admin'
import type { ScanEntry } from '../../server/core/scanner'

function entry(rel: string, over: Partial<ScanEntry> = {}): ScanEntry {
  return {
    kind: 'model', ref: { dirId: 'main', rel }, fileName: rel.split('/').pop()!, size: 1, shards: null,
    complete: true, meta: null, error: null, candidates: { mmproj: [], draft: [] }, ...over,
  }
}

function model(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1', name: 'M1', backend: 'llama-server', file: { dirId: 'main', rel: 'a/m1.gguf' }, mmproj: null, draft: null,
    activeProfile: '默认', profiles: { 默认: { overrides: {}, extraArgs: '' }, RP: { overrides: {}, extraArgs: '' } }, ...over,
  }
}

const doc = (...models: ModelConfig[]): ModelsDoc => ({ version: 1, models })

describe('applyFiles', () => {
  const scanned = [
    entry('a/m1.gguf'),
    entry('a/m2.gguf'),
    entry('a/mm.gguf', { kind: 'mmproj' }),
    entry('a/dr.gguf', { kind: 'draft' }),
    entry('a/split-00001-of-00002.gguf', { complete: false }),
  ]
  const ref = (rel: string) => ({ dirId: 'main', rel })
  const code = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof FilesError ? e.code : 'other' }
    return 'none'
  }

  test('sets and clears mmproj / draft, leaves absent keys alone', () => {
    const d = doc(model())
    applyFiles(d, 'm1', { mmproj: ref('a/mm.gguf'), draft: ref('a/dr.gguf') }, scanned)
    expect(d.models[0]!.mmproj).toEqual(ref('a/mm.gguf'))
    expect(d.models[0]!.draft).toEqual(ref('a/dr.gguf'))
    applyFiles(d, 'm1', { mmproj: null }, scanned)
    expect(d.models[0]!.mmproj).toBeNull()
    expect(d.models[0]!.draft).toEqual(ref('a/dr.gguf'))
  })

  test('changes the main file to another complete, unused model file', () => {
    const d = doc(model())
    applyFiles(d, 'm1', { file: ref('a/m2.gguf') }, scanned)
    expect(d.models[0]!.file).toEqual(ref('a/m2.gguf'))
  })

  test('refuses wrong kinds, unknown / incomplete / used files, and changes nothing', () => {
    const d = doc(model(), model({ id: 'm2', name: 'M2', file: ref('a/m2.gguf') }))
    const before = JSON.stringify(d)
    expect(code(() => applyFiles(d, 'm1', { mmproj: ref('a/m2.gguf') }, scanned))).toBe('wrong-kind')
    expect(code(() => applyFiles(d, 'm1', { file: ref('a/mm.gguf') }, scanned))).toBe('wrong-kind')
    expect(code(() => applyFiles(d, 'm1', { draft: ref('nope.gguf') }, scanned))).toBe('file-not-found')
    expect(code(() => applyFiles(d, 'm1', { file: ref('a/split-00001-of-00002.gguf') }, scanned))).toBe('file-incomplete')
    expect(code(() => applyFiles(d, 'm1', { file: ref('a/m2.gguf') }, scanned))).toBe('file-in-use')
    expect(code(() => applyFiles(d, 'm1', { file: null as never }, scanned))).toBe('file-not-found')
    expect(code(() => applyFiles(d, 'zzz', {}, scanned))).toBe('model-not-found')
    // a valid first part must not be applied when a later part is refused
    expect(code(() => applyFiles(d, 'm1', { mmproj: ref('a/mm.gguf'), draft: ref('nope.gguf') }, scanned))).toBe('file-not-found')
    expect(JSON.stringify(d)).toBe(before)
  })

  test('keeping a file that is no longer scanned is allowed (missing files stay editable)', () => {
    const d = doc(model({ mmproj: ref('gone/mm.gguf') }))
    applyFiles(d, 'm1', { mmproj: ref('gone/mm.gguf'), draft: ref('a/dr.gguf') }, scanned)
    expect(d.models[0]!.mmproj).toEqual(ref('gone/mm.gguf'))
    expect(d.models[0]!.draft).toEqual(ref('a/dr.gguf'))
  })
})

describe('profile editing', () => {
  const code = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof ProfileError ? e.code : 'other' }
    return 'none'
  }

  test('names: trimmed, no colon (model:profile splits at the last one), not reserved', () => {
    expect(validateProfileName('  RP  ')).toBe('RP')
    expect(validateProfileName('长上下文')).toBe('长上下文')
    for (const bad of ['', '   ', 'a:b', 'x'.repeat(41), '__proto__', 'a\nb', 5, null]) {
      expect(code(() => validateProfileName(bad))).toBe('name-invalid')
    }
  })

  test('create / duplicate (deep copy) / exists', () => {
    const d = doc(model({ profiles: { 默认: { overrides: { ctxSize: 4096 }, extraArgs: '--a', chatTemplate: 't.jinja' } } }))
    expect(createProfile(d, 'm1', ' 新 ')).toBe('新')
    expect(d.models[0]!.profiles['新']).toEqual({ overrides: {}, extraArgs: '' })
    createProfile(d, 'm1', 'copy', '默认')
    expect(d.models[0]!.profiles.copy).toEqual(d.models[0]!.profiles['默认'])
    d.models[0]!.profiles.copy!.overrides.ctxSize = 1
    expect(d.models[0]!.profiles['默认']!.overrides.ctxSize).toBe(4096)
    expect(code(() => createProfile(d, 'm1', 'copy'))).toBe('profile-exists')
    expect(code(() => createProfile(d, 'm1', 'x', 'nope'))).toBe('profile-not-found')
    expect(code(() => createProfile(d, 'zzz', 'x'))).toBe('model-not-found')
  })

  test('rename keeps order and the current profile follows', () => {
    const d = doc(model({
      profiles: { a: { overrides: {}, extraArgs: '' }, b: { overrides: {}, extraArgs: '' }, c: { overrides: {}, extraArgs: '' } },
      activeProfile: 'b',
    }))
    expect(renameProfile(d, 'm1', 'b', 'B2')).toBe('B2')
    expect(Object.keys(d.models[0]!.profiles)).toEqual(['a', 'B2', 'c'])
    expect(d.models[0]!.activeProfile).toBe('B2')
    expect(code(() => renameProfile(d, 'm1', 'a', 'c'))).toBe('profile-exists')
    expect(code(() => renameProfile(d, 'm1', 'nope', 'x'))).toBe('profile-not-found')
    expect(code(() => renameProfile(d, 'm1', 'a', 'x:y'))).toBe('name-invalid')
    expect(renameProfile(d, 'm1', 'a', 'a')).toBe('a') // same name: no-op
  })

  test('delete: not the last one; deleting the current one selects another', () => {
    const d = doc(model())
    deleteProfile(d, 'm1', '默认')
    expect(Object.keys(d.models[0]!.profiles)).toEqual(['RP'])
    expect(d.models[0]!.activeProfile).toBe('RP')
    expect(code(() => deleteProfile(d, 'm1', 'RP'))).toBe('last-profile')
    expect(code(() => deleteProfile(d, 'm1', 'nope'))).toBe('profile-not-found')
  })

  test('sanitizeOverrides: known keys only, empty means omit, rejects odd values', () => {
    expect(sanitizeOverrides({ ctxSize: 8192, cacheTypeK: '', reasoning: ' off ', bogus: 1, flashAttn: null })).toEqual({
      ctxSize: 8192, cacheTypeK: null, reasoning: 'off', flashAttn: null,
    })
    expect(sanitizeOverrides(undefined)).toEqual({})
    expect(code(() => sanitizeOverrides({ ctxSize: NaN }))).toBe('bad-overrides')
    expect(code(() => sanitizeOverrides({ ctxSize: { a: 1 } }))).toBe('bad-overrides')
    expect(code(() => sanitizeOverrides({ reasoning: 'on\n--evil' }))).toBe('bad-overrides')
    expect(code(() => sanitizeOverrides([1]))).toBe('bad-overrides')
  })

  test('saveProfile writes overrides / extra args / template and keeps other fields', () => {
    const d = doc(model({ profiles: { 默认: { overrides: {}, extraArgs: '', preprocess: { image: { maxEdge: 512 } } } } }))
    const form = sanitizeForm({ overrides: { ctxSize: 1024 }, extraArgs: '--jinja', chatTemplate: 't.jinja' })
    saveProfile(d, 'm1', '默认', form, ['t.jinja'])
    expect(d.models[0]!.profiles['默认']).toEqual({
      overrides: { ctxSize: 1024 }, extraArgs: '--jinja', chatTemplate: 't.jinja', preprocess: { image: { maxEdge: 512 } },
    })
  })

  test('saveProfile refuses bad extra args, unknown template, unknown profile and changes nothing', () => {
    const d = doc(model())
    const before = JSON.stringify(d)
    expect(code(() => saveProfile(d, 'm1', '默认', sanitizeForm({ extraArgs: '"oops' }), []))).toBe('bad-extra-args')
    expect(code(() => saveProfile(d, 'm1', '默认', sanitizeForm({ chatTemplate: 'x.jinja' }), ['t.jinja']))).toBe('template-not-found')
    expect(code(() => saveProfile(d, 'm1', 'nope', sanitizeForm({}), []))).toBe('profile-not-found')
    expect(JSON.stringify(d)).toBe(before)
  })

  test('sanitizeForm shape checks', () => {
    expect(sanitizeForm({})).toEqual({ overrides: {}, extraArgs: '', chatTemplate: null })
    expect(sanitizeForm({ chatTemplate: '' }).chatTemplate).toBeNull()
    expect(code(() => sanitizeForm(null))).toBe('bad-overrides')
    expect(code(() => sanitizeForm({ extraArgs: 5 }))).toBe('bad-extra-args')
    expect(code(() => sanitizeForm({ chatTemplate: 5 }))).toBe('template-not-found')
  })
})

describe('listTemplates', () => {
  test('lists files of data/templates, sorted; missing directory gives an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-tpl-'))
    try {
      expect(listTemplates(dir)).toEqual([])
      mkdirSync(join(dir, 'templates', 'sub'), { recursive: true })
      writeFileSync(join(dir, 'templates', 'b.jinja'), 'x')
      writeFileSync(join(dir, 'templates', 'a.jinja'), 'x')
      expect(listTemplates(dir)).toEqual(['a.jinja', 'b.jinja'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
