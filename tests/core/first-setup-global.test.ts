import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModels, defaultSettings, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_VERSION, type ModelsDoc, type Settings } from '../../server/core/config'
import { saveFirstSetup, type FirstSetupStore } from '../../server/core/first-setup'
import { planEnable, type FirstSetup } from '../../server/core/models-admin'
import type { ScanEntry } from '../../server/core/scanner'
import { JsonStore } from '../../server/core/store'

const win = { os: 'win32' as const }
const entry: ScanEntry = {
  kind: 'model', ref: { dirId: 'main', rel: 'fixture.gguf' }, fileName: 'fixture.gguf', size: 1,
  shards: null, complete: true, meta: null, error: null, candidates: { mmproj: [], draft: [] },
}
const answers = (over: Partial<FirstSetup> = {}): FirstSetup => ({ ctxSize: 4096, thinking: true, mmproj: null, mtp: false, draft: null, mtpN: 3, ...over })

let dir: string
let settings: JsonStore<Settings>
let models: JsonStore<ModelsDoc>
let store: FirstSetupStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-setup-global-'))
  settings = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: () => {
    const s = defaultSettings()
    s.modelDirs = [{ id: 'main', path: join(dir, 'models'), enabled: true, maxDepth: 0 }]
    return s
  }, validate: normalizeSettings })
  models = new JsonStore({ dataDir: dir, name: 'models.json', version: MODELS_VERSION, defaults: () => {
    const doc = defaultModels(); doc.models.push(planEnable(entry, doc)); return doc
  }, validate: normalizeModels })
  settings.load(); models.load()
  store = { getModels: () => models.get(), updateModels: fn => models.update(fn), updateSettings: fn => settings.update(fn) }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const id = () => models.get().models[0]!.id
const profile = () => models.get().models[0]!.profiles[models.get().models[0]!.activeProfile]!

describe('first start: thinking synced to global defaults', () => {
  test('thinking switch and limit go to both global sets and the current profile; context stays untouched', () => {
    const before = structuredClone(settings.get())
    saveFirstSetup(store, id(), answers({ thinking: false, thinkingLimit: 512, setGlobalThinking: true, setGlobalThinkingLimit: true }), [entry], win)
    for (const d of [settings.get().defaults, settings.get().defaultsCpu]) {
      expect(d.reasoning).toBe('off')
      expect(d.reasoningBudget).toBe(512)
    }
    expect(settings.get().defaults.ctxSize).toBe(before.defaults.ctxSize)
    expect(profile().overrides).toMatchObject({ reasoning: 'off', reasoningBudget: 512, ctxSize: 4096 })
  })

  test('limit 0 (unlimited) is stored globally as -1', () => {
    saveFirstSetup(store, id(), answers({ thinkingLimit: 0, setGlobalThinkingLimit: true }), [entry], win)
    expect(settings.get().defaults.reasoningBudget).toBe(-1)
    expect(settings.get().defaults.reasoning).toBe(defaultSettings().defaults.reasoning)
  })

  test('only the ticked items change; no ticks leaves settings.json alone', () => {
    const before = structuredClone(settings.get())
    saveFirstSetup(store, id(), answers({ thinkingLimit: 256 }), [entry], win)
    expect(settings.get()).toEqual(before)
    saveFirstSetup(store, id(), answers({ thinking: false, setGlobalThinking: true }), [entry], win)
    expect(settings.get().defaults.reasoning).toBe('off')
    expect(settings.get().defaults.reasoningBudget).toBe(before.defaults.reasoningBudget)
  })

  test('works together with the context tick; Mac leaves the unused CPU set alone', () => {
    const cpu = structuredClone(settings.get().defaultsCpu)
    saveFirstSetup(store, id(), answers({ thinkingLimit: 1024, setGlobalContext: true, setGlobalThinking: true, setGlobalThinkingLimit: true }), [entry], { os: 'darwin' })
    expect(settings.get().defaults).toMatchObject({ ctxSize: 4096, reasoning: 'on', reasoningBudget: 1024 })
    expect(settings.get().defaultsCpu).toEqual(cpu)
  })

  test('invalid input writes nothing', () => {
    const before = structuredClone(settings.get())
    for (const bad of [
      answers({ setGlobalThinkingLimit: true }), // no limit given
      answers({ thinkingLimit: -1, setGlobalThinkingLimit: true }),
      answers({ setGlobalThinking: 'yes' as unknown as boolean }),
    ]) expect(() => saveFirstSetup(store, id(), bad, [entry], win)).toThrow()
    expect(settings.get()).toEqual(before)
    expect(models.get().models[0]!.confirmed).toBe(false)
  })

  test('a failed model write restores the changed global fields only', () => {
    const before = structuredClone(settings.get())
    const failing: FirstSetupStore = { ...store, updateModels: () => { throw new Error('model write failed') } }
    expect(() => saveFirstSetup(failing, id(), answers({ thinking: false, thinkingLimit: 64, setGlobalThinking: true, setGlobalThinkingLimit: true }), [entry], win)).toThrow('model write failed')
    expect(settings.get()).toEqual(before)
  })
})
