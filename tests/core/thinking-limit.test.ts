import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModels, defaultSettings, normalizeModels, normalizeSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { saveFirstSetup } from '../../server/core/first-setup'
import { planLaunch, previewLaunch } from '../../server/core/launch'
import { applyFirstSetup, planEnable, sanitizeForm, saveProfile, type FirstSetup } from '../../server/core/models-admin'
import type { ScanEntry } from '../../server/core/scanner'
import { JsonStore } from '../../server/core/store'

const entry: ScanEntry = { kind: 'model', ref: { dirId: 'main', rel: 'model.gguf' }, fileName: 'model.gguf', size: 1,
  shards: null, complete: true, meta: null, error: null, candidates: { draft: [], mmproj: [] } }
const answers = (over: Partial<FirstSetup> = {}): FirstSetup => ({ thinking: true, thinkingLimit: 0, ctxSize: 4096,
  mmproj: null, mtp: false, draft: null, mtpN: 3, ...over })
function fresh() {
  const doc = defaultModels()
  doc.models.push(planEnable(entry, doc))
  doc.models[0]!.profiles.other = { overrides: { reasoning: 'on', reasoningBudget: 512 }, extraArgs: '' }
  return doc
}
let dir: string, models: JsonStore<ModelsDoc>, settings: JsonStore<Settings>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-thinking-'))
  models = new JsonStore({ dataDir: dir, name: 'models.json', version: 1, defaults: fresh, validate: normalizeModels })
  settings = new JsonStore({ dataDir: dir, name: 'settings.json', version: 6, defaults: defaultSettings, validate: normalizeSettings })
  models.load()
  settings.load()
  settings.update(s => { s.modelDirs = [{ id: 'main', path: join(dir, 'models'), enabled: true, maxDepth: 1 }]; s.llamacpp.current = 'b1' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const model = () => models.get().models[0]!
const profile = () => model().profiles[model().activeProfile]!
function first(over: Partial<FirstSetup> = {}) {
  return saveFirstSetup({ getModels: () => models.get(), updateModels: fn => models.update(fn), updateSettings: fn => settings.update(fn) },
    model().id, answers(over), [entry], { os: 'win32' })
}
function edit(overrides: object, limit?: unknown, extraArgs = '') {
  const form = sanitizeForm({ overrides, extraArgs, ...(limit === undefined ? {} : { thinkingLimit: limit }) })
  models.update(doc => { saveProfile(doc, model().id, model().activeProfile, form, []) })
}
function launch() {
  const input = { dataDir: dir, settings: settings.get(), models: models.get(), host: '127.0.0.1', exists: () => true }
  const args = planLaunch({ modelId: model().id, profile: model().activeProfile }, input).args(7100)
  const preview = previewLaunch({ ...input, model: model(), form: { ...profile(), chatTemplate: null } })
  return { args, command: preview.command, warnings: preview.warnings }
}
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('thinking shortcut persists through the existing profile and launch chain', () => {
  test('default 0 is stored and launched as unlimited -1, without changing global defaults or another profile', () => {
    const defaults = structuredClone(settings.get().defaults)
    first()
    models.load()
    expect(profile().overrides).toMatchObject({ reasoning: 'on', reasoningBudget: -1, ctxSize: 4096 })
    expect(model().confirmed).toBe(true)
    expect(model().profiles.other!.overrides.reasoningBudget).toBe(512)
    expect(settings.get().defaults).toEqual(defaults)
    expect(value(launch().args, '--reasoning-budget')).toBe('-1')
    expect(launch().command).toContain('--reasoning-budget -1')
  })
  test('custom cap, context shared save and builtin MTP coexist; all launch arguments survive reload', () => {
    first({ thinkingLimit: 2048, setGlobalContext: true, mtp: true, mtpMode: 'builtin', mtpN: 4 })
    models.load()
    expect(profile().overrides.reasoningBudget).toBe(2048)
    expect(settings.get().defaults.ctxSize).toBe(4096)
    expect(settings.get().defaultsCpu.ctxSize).toBe(4096)
    const { args, command } = launch()
    expect(value(args, '--reasoning-budget')).toBe('2048')
    expect(value(args, '--spec-type')).toBe('draft-mtp')
    expect(value(args, '--spec-draft-n-max')).toBe('4')
    expect(args).not.toContain('--model-draft')
    expect(command).toContain('--reasoning-budget 2048')
  })
  test('off saves the selected cap, and subsequent off/on edits preserve it until explicitly changed', () => {
    first({ thinking: false, thinkingLimit: 1024 })
    expect(value(launch().args, '--reasoning')).toBe('off')
    expect(profile().overrides.reasoningBudget).toBe(1024)
    edit({ ...profile().overrides, reasoning: 'on' })
    expect(value(launch().args, '--reasoning-budget')).toBe('1024')
    edit({ ...profile().overrides, reasoning: 'off' })
    models.load()
    expect(profile().overrides.reasoningBudget).toBe(1024)
    edit({ ...profile().overrides, reasoning: 'on' }, 256)
    expect(launch().command).toContain('--reasoning-budget 256')
    edit(profile().overrides, 0)
    expect(value(launch().args, '--reasoning-budget')).toBe('-1')
  })
  test('preview sanitizes the same shortcut without persisting; manual args retain their precedence', () => {
    first()
    const before = readFileSync(join(dir, 'models.json'), 'utf8')
    const form = sanitizeForm({ overrides: profile().overrides, thinkingLimit: 768, extraArgs: '--reasoning-budget 32' })
    const preview = previewLaunch({ dataDir: dir, settings: settings.get(), model: model(), form, host: '127.0.0.1', exists: () => true })
    expect(preview.command).toContain('--reasoning-budget 32')
    expect(preview.command).not.toContain('--reasoning-budget 768')
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before)
    edit(profile().overrides, 768, '--reasoning-budget 32')
    expect(profile().overrides.reasoningBudget).toBe(768)
    expect(value(launch().args, '--reasoning-budget')).toBe('32')
  })
  test('legacy raw zero, inherit and omit remain unchanged on unrelated edits; explicit shortcut zero becomes -1', () => {
    edit({ reasoning: 'on', reasoningBudget: 0, ctxSize: 8192 })
    models.load()
    expect(value(launch().args, '--reasoning-budget')).toBe('0')
    edit({ ...profile().overrides, ctxSize: 4096 })
    expect(profile().overrides.reasoningBudget).toBe(0)
    edit(profile().overrides, 0)
    expect(profile().overrides.reasoningBudget).toBe(-1)
    edit({ reasoning: 'on' })
    expect(Object.hasOwn(profile().overrides, 'reasoningBudget')).toBe(false)
    edit({ reasoning: 'on', reasoningBudget: null })
    expect(launch().args).not.toContain('--reasoning-budget')
  })
  test('shortcut changes leave global manual reasoning args intact and preserve their launch precedence', () => {
    settings.update(s => { s.defaults.extraArgs = '--reasoning-budget 64' })
    first({ thinkingLimit: 2048 })
    expect(settings.get().defaults.extraArgs).toBe('--reasoning-budget 64')
    expect(profile().overrides.reasoningBudget).toBe(2048)
    expect(value(launch().args, '--reasoning-budget')).toBe('64')
    edit(profile().overrides, 0)
    expect(settings.get().defaults.extraArgs).toBe('--reasoning-budget 64')
    expect(value(launch().args, '--reasoning-budget')).toBe('64')
  })
  test('old first-setup clients retain original on/off behavior when the new value is absent', () => {
    first({ thinkingLimit: undefined })
    expect(profile().overrides.reasoningBudget).toBe(-1)
    edit(profile().overrides, 512)
    first({ thinking: false, thinkingLimit: undefined })
    expect(profile().overrides.reasoningBudget).toBe(512)
  })
})

describe('invalid shortcut values cannot cause model or global writes', () => {
  for (const invalid of [-1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '64', '', null, false]) test(`reject ${String(invalid)}`, () => {
    const beforeModels = readFileSync(join(dir, 'models.json'), 'utf8')
    const beforeSettings = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(() => first({ thinkingLimit: invalid as number, setGlobalContext: true })).toThrow('bad-thinking-limit')
    expect(() => edit({}, invalid)).toThrow('bad-thinking-limit')
    const doc = fresh(), original = structuredClone(doc)
    expect(() => applyFirstSetup(doc, doc.models[0]!.id, answers({ thinkingLimit: invalid as number }), [entry])).toThrow('bad-thinking-limit')
    expect(doc).toEqual(original)
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(beforeModels)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(beforeSettings)
  })
})
