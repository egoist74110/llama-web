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
