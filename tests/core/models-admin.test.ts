import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ModelConfig, ModelsDoc } from '../../server/core/config'
import { describeModels } from '../../server/core/live'
import {
  enabledIdOf, EnableError, missingFiles, planEnable, ProfileError, switchProfile,
} from '../../server/core/models-admin'
import type { ScanEntry } from '../../server/core/scanner'
import type { ModelDir } from '../../server/core/types'

const ROOT = join(process.cwd(), 'fake-models-root')
const dirs: ModelDir[] = [{ id: 'main', path: ROOT, enabled: true, maxDepth: 4 }]

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

describe('planEnable', () => {
  test('builds a default entry: name from the file, one profile, no mmproj / draft', () => {
    const m = planEnable(entry('qwen/Qwen3-27B-Q4_K_M.gguf', {
      candidates: { mmproj: [{ dirId: 'main', rel: 'qwen/mmproj-F16.gguf' }], draft: [] },
    }), doc())
    expect(m.name).toBe('Qwen3-27B')
    expect(m.id).toBe('qwen3-27b')
    expect(m.file).toEqual({ dirId: 'main', rel: 'qwen/Qwen3-27B-Q4_K_M.gguf' })
    expect(m.mmproj).toBeNull() // candidates are offered, never picked
    expect(m.draft).toBeNull()
    expect(m.activeProfile).toBe('默认')
    expect(Object.keys(m.profiles)).toEqual(['默认'])
  })

  test('names and ids stay unique (names case-insensitively, since routing falls back to that)', () => {
    const d = doc(model({ id: 'x', name: 'X-Model' }))
    const m = planEnable(entry('other/x-model-Q8_0.gguf'), d)
    expect(m.name).toBe('x-model-2')
    expect(m.id).toBe('x-model-2')
  })

  test('refuses a name that an upstream prefix would shadow (decision 56), case-insensitively', () => {
    let err: unknown
    try { planEnable(entry('a/Strata-Local-Q4_K_M.gguf'), doc(), ['strata']) } catch (e) { err = e }
    expect(err).toBeInstanceOf(EnableError)
    expect((err as EnableError).code).toBe('upstream-conflict')
    expect((err as EnableError).detail).toBe('strata')
    // The prefix alone (no dash after it) and unrelated prefixes are fine.
    expect(planEnable(entry('a/Strata-Q4_K_M.gguf'), doc(), ['strata']).name).toBe('Strata')
    expect(planEnable(entry('a/Strata-Local-Q4_K_M.gguf'), doc(), ['other']).name).toBe('Strata-Local')
  })

  test('refuses what cannot be a model', () => {
    const code = (fn: () => unknown) => {
      try { fn() } catch (e) { return e instanceof EnableError ? e.code : 'other' }
      return 'none'
    }
    expect(code(() => planEnable(undefined, doc()))).toBe('not-found')
    expect(code(() => planEnable(entry('a/mmproj-F16.gguf', { kind: 'mmproj' }), doc()))).toBe('not-model')
    expect(code(() => planEnable(entry('a/bad.gguf', { kind: 'invalid' }), doc()))).toBe('not-model')
    expect(code(() => planEnable(entry('a/m-00001-of-00002.gguf', { complete: false }), doc()))).toBe('incomplete')
    expect(code(() => planEnable(entry('a/m1.gguf'), doc(model())))).toBe('already-enabled')
  })

  test('enabledIdOf matches by directory and path', () => {
    const d = doc(model())
    expect(enabledIdOf(d, { dirId: 'main', rel: 'a/m1.gguf' })).toBe('m1')
    expect(enabledIdOf(d, { dirId: 'other', rel: 'a/m1.gguf' })).toBeNull()
  })
})

describe('missingFiles', () => {
  const present = new Set([join(ROOT, 'a', 'm1.gguf')])
  const exists = (p: string) => present.has(p)

  test('nothing missing when every configured file exists', () => {
    expect(missingFiles(model(), dirs, exists)).toEqual([])
  })

  test('reports each missing file kind', () => {
    const m = model({
      file: { dirId: 'main', rel: 'gone.gguf' },
      mmproj: { dirId: 'main', rel: 'gone-mmproj.gguf' },
      draft: { dirId: 'main', rel: 'a/m1.gguf' },
    })
    expect(missingFiles(m, dirs, exists)).toEqual(['model', 'mmproj'])
  })

  test('a directory that is no longer configured counts as missing', () => {
    expect(missingFiles(model(), [], exists)).toEqual(['model'])
  })

  test('describeModels carries file names and the missing list into the snapshot', () => {
    const [d] = describeModels(doc(model({ mmproj: { dirId: 'main', rel: 'gone.gguf' } })), { dirs, exists })
    expect(d!.files).toEqual({ model: 'main/a/m1.gguf', mmproj: 'main/gone.gguf', draft: null })
    expect(d!.missing).toEqual(['mmproj'])
    expect(d!.hasMmproj).toBe(true)
    expect(describeModels(doc(model()))[0]!.missing).toEqual([]) // no check requested
  })
})

describe('switchProfile', () => {
  test('changes the current profile and returns the previous one', () => {
    const d = doc(model())
    expect(switchProfile(d, 'm1', 'RP')).toBe('默认')
    expect(d.models[0]!.activeProfile).toBe('RP')
  })

  test('unknown model or profile is rejected without changes', () => {
    const d = doc(model())
    expect(() => switchProfile(d, 'nope', 'RP')).toThrow(ProfileError)
    expect(() => switchProfile(d, 'm1', 'toString')).toThrow(ProfileError)
    expect(d.models[0]!.activeProfile).toBe('默认')
  })
})
