import { describe, expect, test } from 'bun:test'
import type { ModelConfig, ModelsDoc } from '../../server/core/config'
import { hasImages, listModelNames, resolveTarget } from '../../server/core/routing'
import type { ModelSnapshot } from '../../server/core/scheduler'

const model = (id: string, name: string, profiles: string[], active = profiles[0]!): ModelConfig => ({
  id, name, backend: 'llama-server', file: { dirId: 'd', rel: `${id}.gguf` }, mmproj: null, draft: null,
  activeProfile: active, profiles: Object.fromEntries(profiles.map(p => [p, { overrides: {}, extraArgs: '' }])),
})

const doc: ModelsDoc = {
  version: 1,
  models: [
    model('qwen', 'Qwen3-27B', ['默认', 'RP'], 'RP'),
    model('colon', 'llama3:8b', ['main', 'long']),
    model('llama3', 'llama3', ['8b', 'other']),
  ],
}

const snap = (modelId: string, profile: string, state: ModelSnapshot['state']): ModelSnapshot =>
  ({ modelId, profile, state, port: 7100, inflight: 0, lastUsedAt: null, error: null })

describe('resolveTarget', () => {
  test('base name uses the active profile', () => {
    const r = resolveTarget(doc, 'Qwen3-27B')
    expect(r.ok && r.target).toEqual({ modelId: 'qwen', profile: 'RP' })
  })

  test('name:profile selects that profile (non-ASCII profile names too)', () => {
    const r = resolveTarget(doc, 'Qwen3-27B:默认')
    expect(r.ok && r.target).toEqual({ modelId: 'qwen', profile: '默认' })
  })

  test('a whole-name match wins over a split, names containing ":" work', () => {
    const r = resolveTarget(doc, 'llama3:8b')
    expect(r.ok && r.target).toEqual({ modelId: 'colon', profile: 'main' })
    const r2 = resolveTarget(doc, 'llama3:8b:long')
    expect(r2.ok && r2.target).toEqual({ modelId: 'colon', profile: 'long' })
    const r3 = resolveTarget(doc, 'llama3:other')
    expect(r3.ok && r3.target).toEqual({ modelId: 'llama3', profile: 'other' })
  })

  test('falls back to the model id and to case-insensitive names', () => {
    expect(resolveTarget(doc, 'qwen').ok).toBe(true)
    const r = resolveTarget(doc, 'QWEN3-27b:RP')
    expect(r.ok && r.target).toEqual({ modelId: 'qwen', profile: 'RP' })
  })

  test('unknown model / profile', () => {
    expect(resolveTarget(doc, 'nope')).toMatchObject({ ok: false, code: 'model-not-found', name: 'nope' })
    expect(resolveTarget(doc, 'Qwen3-27B:nope')).toMatchObject({ ok: false, code: 'profile-not-found', model: 'Qwen3-27B', profile: 'nope' })
    expect(resolveTarget(doc, 'Qwen3-27B:')).toMatchObject({ ok: false, code: 'model-not-found' })
  })

  test('missing model field → the running model, ready before loading', () => {
    expect(resolveTarget(doc, undefined)).toMatchObject({ ok: false, code: 'no-model' })
    expect(resolveTarget(doc, '', [snap('qwen', '默认', 'failed')])).toMatchObject({ ok: false, code: 'no-model' })
    const r = resolveTarget(doc, undefined, [snap('colon', 'long', 'loading'), snap('qwen', '默认', 'ready')])
    expect(r.ok && r.target).toEqual({ modelId: 'qwen', profile: '默认' })
    const r2 = resolveTarget(doc, null, [snap('colon', 'long', 'loading')])
    expect(r2.ok && r2.target).toEqual({ modelId: 'colon', profile: 'long' })
  })
})

test('listModelNames: base names first, then custom profiles', () => {
  expect(listModelNames(doc)).toEqual([
    'Qwen3-27B', 'llama3:8b', 'llama3',
    'Qwen3-27B:RP', 'llama3:8b:main', 'llama3:8b:long', 'llama3:other',
  ])
})

test('listModelNames: three models with only the built-in profile yield three names', () => {
  const defaults: ModelsDoc = { version: 1, models: [
    model('a', 'Alpha', ['默认']),
    model('b', 'Beta', ['默认']),
    model('c', 'Gamma', ['默认']),
  ] }
  expect(listModelNames(defaults)).toEqual(['Alpha', 'Beta', 'Gamma'])
})

test('listModelNames: custom profiles remain visible when active and when default is removed', () => {
  const custom: ModelsDoc = { version: 1, models: [
    model('a', 'Alpha', ['默认', '创作'], '创作'),
    model('b', 'Beta', ['default']),
    model('c', 'Gamma:默认', ['默认']),
  ] }
  expect(listModelNames(custom)).toEqual(['Alpha', 'Beta', 'Gamma:默认', 'Alpha:创作', 'Beta:default'])
  expect(resolveTarget(custom, 'Alpha')).toMatchObject({ ok: true, target: { modelId: 'a', profile: '创作' } })
  expect(resolveTarget(custom, 'Alpha:默认')).toMatchObject({ ok: true, target: { modelId: 'a', profile: '默认' } })
})

test('hasImages', () => {
  expect(hasImages({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false)
  expect(hasImages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })).toBe(false)
  expect(hasImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }] })).toBe(true)
  expect(hasImages({ prompt: 'x' })).toBe(false)
  expect(hasImages(null)).toBe(false)
})

describe('no model field with several models online (decision 41)', () => {
  const at = (modelId: string, profile: string, state: ModelSnapshot['state'], lastUsedAt: number | null): ModelSnapshot =>
    ({ ...snap(modelId, profile, state), lastUsedAt })

  test('the most recently used ready model is the default one', () => {
    const r = resolveTarget(doc, undefined, [at('qwen', 'RP', 'ready', 100), at('colon', 'long', 'ready', 200), at('llama3', '8b', 'ready', 150)])
    expect(r.ok && r.target).toEqual({ modelId: 'colon', profile: 'long' })
  })

  test('a model that was never used counts as the oldest; a tie goes to the later one; ready beats loading', () => {
    expect(resolveTarget(doc, '', [at('qwen', 'RP', 'ready', null), at('colon', 'main', 'ready', 5)])).toMatchObject({ target: { modelId: 'colon' } })
    expect(resolveTarget(doc, '', [at('qwen', 'RP', 'ready', null), at('colon', 'main', 'ready', null)])).toMatchObject({ target: { modelId: 'colon' } })
    expect(resolveTarget(doc, '', [at('qwen', 'RP', 'loading', null), at('colon', 'main', 'ready', 1)])).toMatchObject({ target: { modelId: 'colon' } })
  })

  test('the same millisecond: the scheduler use counter decides, not the list order (CR-017)', () => {
    const seq = (m: ModelSnapshot, useSeq: number): ModelSnapshot => ({ ...m, useSeq })
    const list = [seq(at('qwen', 'RP', 'ready', 123), 9), seq(at('colon', 'main', 'ready', 123), 8)]
    expect(resolveTarget(doc, '', list)).toMatchObject({ target: { modelId: 'qwen' } })
    expect(resolveTarget(doc, '', [...list].reverse())).toMatchObject({ target: { modelId: 'qwen' } })
  })

  test('one online model behaves as before', () => {
    expect(resolveTarget(doc, undefined, [at('qwen', 'RP', 'ready', 1), at('colon', 'main', 'stopped', 9)])).toMatchObject({ target: { modelId: 'qwen' } })
  })
})
