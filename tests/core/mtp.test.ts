import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModels, defaultSettings, normalizeModels, type ModelsDoc } from '../../server/core/config'
import { saveFirstSetup } from '../../server/core/first-setup'
import { planLaunch, previewLaunch } from '../../server/core/launch'
import { applyFirstSetup, planEnable, sanitizeForm, saveProfile, type FirstSetup } from '../../server/core/models-admin'
import { mtpExtraArgs, readMtp, stripMtpArgs, type MtpInput } from '../../server/core/mtp'
import { JsonStore } from '../../server/core/store'
import type { ScanEntry } from '../../server/core/scanner'

const ref = (rel: string) => ({ dirId: 'main', rel })
const entry = (rel: string, kind: ScanEntry['kind'], complete = true): ScanEntry => ({
  kind, ref: ref(rel), fileName: rel.split('/').pop()!, size: 1, shards: null, complete, meta: null, error: null,
  candidates: { draft: [], mmproj: [] },
})
const entries = [entry('q/model.gguf', 'model'), entry('q/draft space.gguf', 'draft'), entry('else/draft.gguf', 'draft'),
  entry('q/broken-draft.gguf', 'draft', false), entry('q/mmproj.gguf', 'mmproj')]
const mtp = (over: Partial<MtpInput> = {}): MtpInput => ({ enabled: true, mode: 'builtin', n: 4, draft: null, ...over })
const file = () => mtp({ mode: 'file', n: 3, draft: entries[1]!.ref })
const answers = (m: MtpInput): FirstSetup => ({ ctxSize: 4096, thinking: true, mmproj: null, mtp: m.enabled, mtpMode: m.mode, mtpN: m.n, draft: m.draft })
function fresh() {
  const doc = defaultModels()
  const m = planEnable(entries[0], doc)
  m.profiles.other = { overrides: { ctxSize: 8192 }, extraArgs: '--props --spec-type draft-mtp --spec-draft-n-max 2' }
  doc.models.push(m)
  return doc
}
let dir: string, models: JsonStore<ModelsDoc>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-mtp-'))
  models = new JsonStore({ dataDir: dir, name: 'models.json', version: 1, defaults: fresh, validate: normalizeModels })
  models.load()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const model = () => models.get().models[0]!
const profile = () => model().profiles[model().activeProfile]!
function launch(name = model().activeProfile, globalExtra = '--jinja') {
  const settings = defaultSettings()
  settings.modelDirs = [{ id: 'main', path: join(dir, 'models'), enabled: true, maxDepth: 2 }]
  settings.llamacpp.current = 'b1'
  settings.defaults.extraArgs = globalExtra
  const input = { dataDir: dir, settings, models: models.get(), host: '127.0.0.1', exists: () => true }
  return { args: planLaunch({ modelId: model().id, profile: name }, input).args(7100),
    preview: previewLaunch({ ...input, model: model(), form: { ...model().profiles[name]!, chatTemplate: null } }) }
}
function first(input: MtpInput) {
  return saveFirstSetup({ getModels: () => models.get(), updateModels: fn => models.update(fn), updateSettings: () => { throw Error('unexpected global write') } },
    model().id, answers(input), entries, { os: 'win32' })
}
function edit(input?: MtpInput, extraArgs = profile().extraArgs) {
  models.update(doc => { saveProfile(doc, model().id, model().activeProfile, sanitizeForm({ overrides: profile().overrides, extraArgs, chatTemplate: null,
    ...(input ? { mtp: input } : {}) }), [], undefined, undefined, entries) })
}
const count = (args: string[], flag: string) => args.filter(a => a === flag).length
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('explicit MTP save, launch and subsequent editing', () => {
  test('builtin persists N=4, launches without a draft even when neighbours exist, and survives reload', () => {
    first(mtp())
    expect(model().draft).toBeNull()
    expect(profile().extraArgs).toBe('--spec-type draft-mtp --spec-draft-n-max 4')
    expect(profile().overrides).toMatchObject({ ctxSize: 4096, reasoning: 'on', reasoningBudget: -1 })
    models.load()
    const { args, preview } = launch()
    expect(value(args, '--spec-type')).toBe('draft-mtp')
    expect(value(args, '--spec-draft-n-max')).toBe('4')
    expect(args).not.toContain('--model-draft')
    expect(preview.command).not.toContain('--model-draft')
    expect(readMtp(profile().extraArgs, model().draft)).toEqual(mtp())
  })
  test('file mode persists the same-directory ref and N=3; paths with spaces stay one launch argument', () => {
    first(file())
    models.load()
    expect(model().draft).toEqual(entries[1]!.ref)
    const { args, preview } = launch()
    expect(value(args, '--model-draft')).toBe(join(dir, 'models', 'q/draft space.gguf'))
    expect(count(args, '--model-draft')).toBe(1)
    expect(value(args, '--spec-draft-n-max')).toBe('3')
    expect(preview.command).toContain('--model-draft "')
    expect(readMtp(profile().extraArgs, model().draft)).toEqual(file())
  })
  test('subsequent editing switches file → builtin → file → off without duplicated or stale flags', () => {
    first(file())
    edit(mtp({ n: 6 }), '--props --model-draft="X:\\old path\\draft.gguf" --spec-type=draft-mtp --spec-draft-n-max=3')
    expect(model().draft).toBeNull()
    expect(launch().args).not.toContain('--model-draft')
    expect(profile().extraArgs).toBe('--props --spec-type draft-mtp --spec-draft-n-max 6')
    edit(file())
    expect(count(launch().args, '--spec-type')).toBe(1)
    expect(count(launch().args, '--model-draft')).toBe(1)
    edit(mtp({ enabled: false, mode: null }), `${profile().extraArgs} -md "X:\\old path\\draft.gguf"`)
    expect(profile().extraArgs).toBe('--props')
    expect(model().draft).toBeNull()
    expect(launch().args).not.toContain('--spec-type')
    expect(model().confirmed).toBe(true)
  })
  test('only the selected profile args change; the draft remains model-wide and is used by other profiles', () => {
    models.update(doc => { doc.models[0]!.activeProfile = 'other' })
    first(file())
    expect(model().profiles['默认']!.extraArgs).toBe('')
    expect(value(launch('默认').args, '--model-draft')).toBe(join(dir, 'models', 'q/draft space.gguf'))
    edit(mtp())
    expect(launch('默认').args).not.toContain('--model-draft')
    expect(model().profiles['默认']!.overrides).toEqual({})
  })
  test('untouched controls preserve legacy raw arguments and the shared file on an unrelated edit', () => {
    first(file())
    const raw = '--spec-type eagle --spec-draft-n-max 7 -md "X:\\legacy\\draft.gguf" --props'
    edit(undefined, raw)
    expect(profile().extraArgs).toBe(raw)
    expect(model().draft).toEqual(file().draft)
  })
  test('global manual parameters retain precedence behavior without being rewritten', () => {
    first(mtp())
    const raw = '--spec-type eagle --spec-draft-n-max 9 --model-draft "X:\\manual\\draft.gguf"'
    expect(value(launch(undefined, raw).args, '--spec-type')).toBe('draft-mtp')
    edit(mtp({ enabled: false, mode: null }))
    expect(value(launch(undefined, raw).args, '--spec-type')).toBe('eagle')
    expect(value(launch(undefined, raw).args, '--model-draft')).toBe('X:\\manual\\draft.gguf')
  })
})

describe('MTP rejection leaves configuration unchanged', () => {
  const bad: Array<[string, MtpInput]> = [
    ['missing mode', mtp({ mode: null })], ['unknown mode', mtp({ mode: 'auto' as any })],
    ['zero N', mtp({ n: 0 })], ['fraction N', mtp({ n: 2.5 })], ['N too large', mtp({ n: 17 })], ['NaN', mtp({ n: NaN })],
    ['file required', mtp({ mode: 'file' })], ['builtin with file', fileWithBuiltin()],
    ['wrong directory', mtp({ mode: 'file', draft: entries[2]!.ref })],
    ['incomplete file', mtp({ mode: 'file', draft: entries[3]!.ref })],
    ['wrong kind', mtp({ mode: 'file', draft: entries[4]!.ref })],
    ['missing file', mtp({ mode: 'file', draft: ref('q/nope.gguf') })],
    ['traversal', mtp({ mode: 'file', draft: ref('../draft.gguf') })],
  ]
  for (const [name, input] of bad) test(name, () => {
    const before = readFileSync(join(dir, 'models.json'), 'utf8')
    expect(() => first(input)).toThrow()
    expect(() => edit(input)).toThrow()
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before)
    expect(model().confirmed).toBe(false)
  })
  test('pure applyFirstSetup also rejects before touching vision or profile values', () => {
    const doc = fresh(), before = structuredClone(doc)
    expect(() => applyFirstSetup(doc, model().id, { ...answers(file()), mmproj: entries[4]!.ref, draft: entries[2]!.ref }, entries)).toThrow()
    expect(doc).toEqual(before)
  })
  test('a saved but now missing draft is rechecked on a dedicated MTP edit', () => {
    first(file())
    const doc = models.get(), before = structuredClone(doc)
    expect(() => saveProfile(doc, model().id, model().activeProfile, sanitizeForm({ overrides: {}, extraArgs: '', mtp: file() }), [], undefined, undefined, [])).toThrow('file-not-found')
    expect(doc).toEqual(before)
  })
})
function fileWithBuiltin() { return mtp({ draft: entries[1]!.ref }) }

describe('legacy MTP parsing and argument cleanup', () => {
  test('no MTP args stays off, while builtin / file modes are restored from saved configuration', () => {
    expect(readMtp('--props', null)).toMatchObject({ enabled: false, mode: null, n: 3 })
    expect(readMtp('--spec-type=draft-mtp --spec-draft-n-max=4', null)).toEqual(mtp())
    expect(readMtp('--spec-type draft-mtp -md "X:\\draft.gguf"', null)).toMatchObject({ enabled: true, mode: 'file' })
    expect(readMtp('--spec-type draft-mtp --spec-draft-n-max 2 --spec-draft-n-max 5', null).n).toBe(5)
    expect(readMtp('"unterminated', null).enabled).toBe(false)
  })
  test('cleanup preserves unrelated quoted values and strips only MTP flags including draft aliases', () => {
    const raw = '--props --model-draft="X:\\a b\\draft.gguf" -md "X:\\other.gguf" --spec-type=draft-mtp --spec-draft-n-max 4 --chat-template-file "X:\\a b\\t.jinja"'
    expect(stripMtpArgs(raw)).toBe('--props --chat-template-file "X:\\a b\\t.jinja"')
    expect(mtpExtraArgs(mtpExtraArgs(raw, mtp()), mtp())).toBe('--props --chat-template-file "X:\\a b\\t.jinja" --spec-type draft-mtp --spec-draft-n-max 4')
  })
})
