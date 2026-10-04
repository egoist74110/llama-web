import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModels, defaultSettings, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_VERSION, type ModelsDoc, type Settings } from '../../server/core/config'
import { saveFirstSetup, type FirstSetupStore } from '../../server/core/first-setup'
import { planLaunch, previewLaunch } from '../../server/core/launch'
import { applyFirstSetup, planEnable, sanitizeForm, saveProfile, type FirstSetup } from '../../server/core/models-admin'
import { applyDefaults } from '../../server/core/settings-admin'
import { JsonStore } from '../../server/core/store'
import type { ScanEntry } from '../../server/core/scanner'

const host = { os: 'win32' as const }
const entry: ScanEntry = {
  kind: 'model', ref: { dirId: 'main', rel: 'fixture.gguf' }, fileName: 'fixture.gguf', size: 1,
  shards: null, complete: true, meta: null, error: null, candidates: { mmproj: [], draft: [] },
}
const answers = (over: Partial<FirstSetup> = {}): FirstSetup => ({ ctxSize: 4096, thinking: true, mmproj: null, mtp: false, draft: null, mtpN: 3, ...over })
const fresh = (): ModelsDoc => {
  const doc = defaultModels()
  const m = planEnable(entry, doc)
  m.profiles.other = { overrides: { ctxSize: 8192 }, extraArgs: '--props' }
  doc.models.push(m)
  return doc
}

let dir: string
let settings: JsonStore<Settings>
let models: JsonStore<ModelsDoc>
let store: FirstSetupStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-setup-context-'))
  settings = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: () => {
    const s = defaultSettings()
    s.modelDirs = [{ id: 'main', path: join(dir, 'models'), enabled: true, maxDepth: 0 }]
    s.llamacpp.current = 'b1'
    s.llamacpp.currentCpu = 'b2'
    return s
  }, validate: normalizeSettings })
  models = new JsonStore({ dataDir: dir, name: 'models.json', version: MODELS_VERSION, defaults: fresh, validate: normalizeModels })
  settings.load(); models.load()
  store = { getModels: () => models.get(), updateModels: fn => models.update(fn), updateSettings: fn => settings.update(fn) }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const model = () => models.get().models[0]!
const id = () => model().id
const current = () => model().profiles[model().activeProfile]!
const persisted = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const args = (acceleration: 'cuda' | 'cpu' = 'cuda') => planLaunch({ modelId: id(), profile: model().activeProfile }, {
  dataDir: dir, models: models.get(), settings: settings.get(), host: '127.0.0.1',
  target: { os: 'win32', arch: 'x64', acceleration }, exists: () => true,
}).args(7100)

describe('first-start context save and merge', () => {
  test('local choice persists only on the active profile and reaches both launch channels', () => {
    const before = settings.get()
    saveFirstSetup(store, id(), answers(), [entry], host)
    expect(persisted<Settings>('settings.json')).toEqual(before)
    expect(persisted<ModelsDoc>('models.json').models[0]).toMatchObject({ confirmed: true, profiles: { '默认': { overrides: { ctxSize: 4096 } }, other: { overrides: { ctxSize: 8192 }, extraArgs: '--props' } } })
    for (const channel of ['cuda', 'cpu'] as const) {
      const a = args(channel)
      expect(a[a.indexOf('--ctx-size') + 1]).toBe('4096')
    }
  })

  test('global choice updates GPU and CPU defaults, keeps other fields and profile overrides', () => {
    const before = structuredClone(settings.get())
    saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], host)
    expect(persisted<Settings>('settings.json')).toEqual({ ...before,
      defaults: { ...before.defaults, ctxSize: 4096 }, defaultsCpu: { ...before.defaultsCpu, ctxSize: 4096 } })
    expect(current().overrides.ctxSize).toBe(4096)
    expect(model().profiles.other!.overrides.ctxSize).toBe(8192)
  })

  test('a non-default active profile receives the choice without changing the built-in profile', () => {
    models.update(d => { d.models[0]!.activeProfile = 'other' })
    saveFirstSetup(store, id(), answers(), [entry], host)
    expect(current().overrides.ctxSize).toBe(4096)
    expect(current().extraArgs).toBe('--props')
    expect(model().profiles['默认']!.overrides.ctxSize).toBeUndefined()
    expect(args()[args().indexOf('--ctx-size') + 1]).toBe('4096')
  })

  test('Mac updates its one global defaults set, keeping the unused CPU defaults', () => {
    const before = structuredClone(settings.get().defaultsCpu)
    saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], { os: 'darwin' })
    expect(settings.get().defaults.ctxSize).toBe(4096)
    expect(settings.get().defaultsCpu).toEqual(before)
  })

  test('zero is persisted and passed literally; empty / null omits the flag', () => {
    saveFirstSetup(store, id(), answers({ ctxSize: 0, setGlobalContext: true }), [entry], host)
    expect(settings.get().defaults.ctxSize).toBe(0)
    expect(settings.get().defaultsCpu.ctxSize).toBe(0)
    const a = args()
    expect(a[a.indexOf('--ctx-size') + 1]).toBe('0')
    saveFirstSetup(store, id(), answers({ ctxSize: null, setGlobalContext: true }), [entry], host)
    expect(settings.get().defaults.ctxSize).toBeNull()
    expect(current().overrides.ctxSize).toBeNull()
    expect(args()).not.toContain('--ctx-size')
  })

  test('an older client without context keeps the saved value', () => {
    models.update(d => { d.models[0]!.profiles[d.models[0]!.activeProfile]!.overrides.ctxSize = 2048 })
    saveFirstSetup(store, id(), answers({ ctxSize: undefined }), [entry], host)
    expect(current().overrides.ctxSize).toBe(2048)
  })

  test('later edits can customize or inherit, and later global edits do not change custom profiles', () => {
    saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], host)
    settings.update(s => applyDefaults(s, { ctxSize: 16384 }))
    expect(args()[args().indexOf('--ctx-size') + 1]).toBe('4096')
    models.update(d => { saveProfile(d, id(), model().activeProfile, sanitizeForm({ overrides: { ctxSize: 6144 } }), []) })
    expect(args()[args().indexOf('--ctx-size') + 1]).toBe('6144')
    models.update(d => { saveProfile(d, id(), model().activeProfile, sanitizeForm({ overrides: {} }), []) })
    expect(args()[args().indexOf('--ctx-size') + 1]).toBe('16384')
    expect(args('cpu')[args('cpu').indexOf('--ctx-size') + 1]).toBe('4096')
  })

  test('extra context arguments still win, with the existing warning', () => {
    settings.update(s => { s.defaults.extraArgs += ' --ctx-size=2048' })
    models.update(d => { d.models[0]!.profiles[d.models[0]!.activeProfile]!.extraArgs = '-c 1024' })
    saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], host)
    const a = args()
    expect(a).not.toContain('--ctx-size=2048')
    expect(a).not.toContain('--ctx-size')
    expect(a[a.indexOf('-c') + 1]).toBe('1024')
    const p = previewLaunch({ dataDir: dir, settings: settings.get(), model: model(), form: { ...current(), chatTemplate: null }, host: '127.0.0.1', exists: () => true })
    expect(p.effective.ctxSize).toBe(4096)
    expect(p.warnings.some(w => w.code === 'extra-overrides-form' && w.flag === '--ctx-size')).toBe(true)
  })

  test('initial form context uses the final runtime channel and then the saved profile value, without a runtime installed', () => {
    for (const acceleration of ['cuda', 'cpu'] as const) {
      const p = previewLaunch({ dataDir: dir, settings: settings.get(), model: model(), form: { ...current(), chatTemplate: null },
        host: '127.0.0.1', target: { os: 'win32', arch: 'x64', acceleration }, exists: () => false })
      expect(p.effective.ctxSize).toBe(acceleration === 'cpu' ? 32768 : 262144)
      expect(p.missing).toContain('runtime')
    }
    saveFirstSetup(store, id(), answers(), [entry], host)
    expect(previewLaunch({ dataDir: dir, settings: settings.get(), model: model(), form: { ...current(), chatTemplate: null }, host: '127.0.0.1', exists: () => false }).effective.ctxSize).toBe(4096)
  })
})

describe('first-start context failure consistency', () => {
  test.each([NaN, Infinity, -Infinity, '4096', '--ctx-size=1', {}, true])('refuses malformed context %p without changing either document', (bad) => {
    const before = [persisted('settings.json'), persisted('models.json')]
    expect(() => saveFirstSetup(store, id(), answers({ ctxSize: bad as number, setGlobalContext: true }), [entry], host)).toThrow('bad-context')
    expect([persisted('settings.json'), persisted('models.json')]).toEqual(before)
  })

  test('matches existing finite numeric form rules; no new launch validation policy', () => {
    for (const ctxSize of [-1, 1.5]) {
      const d = fresh()
      applyFirstSetup(d, d.models[0]!.id, answers({ ctxSize }), [entry])
      expect(d.models[0]!.profiles[d.models[0]!.activeProfile]!.overrides.ctxSize).toBe(ctxSize)
    }
  })

  test('global option requires a context and an actual boolean', () => {
    expect(() => saveFirstSetup(store, id(), answers({ ctxSize: undefined, setGlobalContext: true }), [entry], host)).toThrow('bad-context')
    expect(() => saveFirstSetup(store, id(), answers({ setGlobalContext: 'false' as unknown as boolean }), [entry], host)).toThrow('bad-context')
    expect(model().confirmed).toBe(false)
  })

  test('invalid file and MTP answers are rejected before global writes', () => {
    const before = persisted('settings.json')
    expect(() => saveFirstSetup(store, id(), answers({ setGlobalContext: true, mmproj: entry.ref }), [entry], host)).toThrow('wrong-kind')
    expect(() => saveFirstSetup(store, id(), answers({ setGlobalContext: true, mtpN: 0 }), [entry], host)).toThrow('bad-setup')
    expect(persisted('settings.json')).toEqual(before)
  })

  test('failed global save never confirms the model', () => {
    writeFileSync(settings.file, '{ invalid JSON')
    expect(() => saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], host)).toThrow()
    expect(persisted<ModelsDoc>('models.json').models[0]!.confirmed).toBe(false)
  })

  test('failed model save restores both global contexts, with unrelated fields intact', () => {
    const before = persisted('settings.json')
    writeFileSync(models.file, '{ invalid JSON')
    expect(() => saveFirstSetup(store, id(), answers({ setGlobalContext: true }), [entry], host)).toThrow()
    expect(persisted('settings.json')).toEqual(before)
    expect(model().confirmed).toBe(false)
  })

  test('rollback failure reports both errors and never reports success', () => {
    let settingsWrites = 0
    const failing: FirstSetupStore = { ...store,
      updateModels: () => { throw new Error('model write failed') },
      updateSettings: fn => { if (++settingsWrites > 1) throw new Error('rollback failed'); return store.updateSettings(fn) },
    }
    expect(() => saveFirstSetup(failing, id(), answers({ setGlobalContext: true }), [entry], host)).toThrow(AggregateError)
    expect(model().confirmed).toBe(false)
  })
})
