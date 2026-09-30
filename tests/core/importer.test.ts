import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModels, defaultSettings } from '../../server/core/config'
import { aliasOf, ImportError, importSwapConfig, parseSwapConfig } from '../../server/core/importer'
import { mmprojSpec, modelSpec, writeGguf } from '../fixtures/gguf-builder'

let tmp: string
let root: string
let data: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lw-import-'))
  root = join(tmp, 'models')
  data = join(tmp, 'data')
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function writeConfig(extra: Record<string, unknown> = {}, name = 'swap-config.json') {
  const file = join(tmp, name)
  writeFileSync(file, JSON.stringify({
    _help: { x: 'comment' },
    models_root: root,
    llama_exe: 'X:\\old\\llama-server.exe',
    exclude: ['Hidden-Model'],
    public: { domain: 'example.com', tunnel_name: 't', api_keys: ['OLD-SECRET-KEY'] },
    global: { ctx_size: 8192, cache_type_k: 'q4_0', flash_attn: 'on', gpu_layers: 999, reasoning: 'on' },
    models: {},
    ...extra,
  }))
  return file
}

const run = (configPath: string, over: Partial<Parameters<typeof importSwapConfig>[0]> = {}) =>
  importSwapConfig({ dataDir: data, configPath, settings: defaultSettings(), models: defaultModels(), ...over })

test('aliasOf strips only a trailing quant tag', () => {
  expect(aliasOf('Qwen3.8-27B-UD-Q4_K_XL.gguf')).toBe('Qwen3.8-27B')
  expect(aliasOf('gemma-4-31B-it-qat-Q4_0.gguf')).toBe('gemma-4-31B-it-qat')
  expect(aliasOf('foo-q4_0-unquantized-heretic-Q8_0.gguf')).toBe('foo-q4_0-unquantized-heretic')
  expect(aliasOf('bar-BF16.gguf')).toBe('bar')
  expect(aliasOf('plain.gguf')).toBe('plain')
  expect(aliasOf('big-Q4_K_M-00001-of-00003.gguf')).toBe('big')
})

test('parseSwapConfig ignores comments, tolerates trailing commas and rejects bad input', () => {
  const cfg = parseSwapConfig('\uFEFF{"_c":1,"models_root":"X:\\\\m","exclude":["A",],"global":{"_n":"x","ctx_size":1,},"models":{"_x":{},"M":{"_note":"n","ctx_size":2}}}')
  expect(cfg).toEqual({ modelsRoot: 'X:\\m', exclude: ['A'], global: { ctx_size: 1 }, models: { M: { ctx_size: 2 } } })
  expect(() => parseSwapConfig('{')).toThrow(ImportError)
  expect(() => parseSwapConfig('{"global":{}}')).toThrow(/models_root/)
})

test('imports scanned models with old semantics: aliases, exclude, mmproj pairing, overrides', async () => {
  writeGguf(join(root, 'qwen', 'Qwen-27B-UD-Q4_K_XL.gguf'), modelSpec())
  writeGguf(join(root, 'qwen', 'mmproj-F16.gguf'), mmprojSpec())
  writeGguf(join(root, 'qwen', 'mmproj-Q8_0.gguf'), mmprojSpec())
  writeGguf(join(root, 'gemma', 'Gemma-it-Q4_0.gguf'), modelSpec())
  writeGguf(join(root, 'gemma', 'mtp-Gemma-it.gguf'), modelSpec({ arch: 'gemma-mtp' }))
  writeGguf(join(root, 'Hidden-Model-Q4_0.gguf'), modelSpec())
  const cfg = writeConfig({
    models: {
      'qwen-27b': { _note: 'x', ctx_size: 4096, ubatch_size: 2048, extra_args: '--spec-type draft-mtp', chat_template: 'gemma' },
      Ghost: { ctx_size: 1 },
    },
  })

  const { settings, models, report } = await run(cfg)
  expect(models.models.map(m => m.name)).toEqual(['Gemma-it', 'Qwen-27B'])
  expect(settings.modelDirs).toEqual([{ id: 'main', path: root, enabled: true, maxDepth: 10 }])

  const q = models.models.find(m => m.name === 'Qwen-27B')!
  expect(q.id).toBe('qwen-27b')
  expect(q.file).toEqual({ dirId: 'main', rel: 'qwen/Qwen-27B-UD-Q4_K_XL.gguf' })
  expect(q.mmproj).toEqual({ dirId: 'main', rel: 'qwen/mmproj-F16.gguf' })
  expect(q.activeProfile).toBe('默认')
  // Global defaults come from the old file; only differences become overrides.
  expect(settings.defaults.ctxSize).toBe(8192)
  expect(settings.defaults.batchSize).toBeNull() // absent in old global => flag was not passed
  expect(q.profiles['默认']!.overrides).toEqual({ ctxSize: 4096, ubatchSize: 2048 })
  expect(q.profiles['默认']!.extraArgs).toBe('--spec-type draft-mtp --chat-template gemma')

  const g = models.models.find(m => m.name === 'Gemma-it')!
  expect(g.mmproj).toBeNull()
  expect(g.profiles['默认']!.overrides).toEqual({})
  // The draft file is never selected on its own.
  expect(g.draft).toBeNull()

  expect(report.defaultsApplied).toBe(true)
  expect(report.warnings.map(w => `${w.code}:${w.subject}`)).toEqual(['override-unmatched:Ghost'])
})

test('never imports keys, domain or tunnel settings', async () => {
  writeGguf(join(root, 'a-Q4_0.gguf'), modelSpec())
  const { settings, models, report } = await run(writeConfig())
  const dump = JSON.stringify({ settings, models, report })
  expect(dump).not.toContain('OLD-SECRET-KEY')
  expect(dump).not.toContain('example.com')
  expect(settings.public).toEqual(defaultSettings().public)
})

test('-md draft path becomes a draft file ref and leaves extra args', async () => {
  writeGguf(join(root, 'g', 'Gem-Q4_0.gguf'), modelSpec())
  writeGguf(join(root, 'g', 'mtp-Gem.gguf'), modelSpec({ arch: 'gemma-mtp' }))
  const cfg = writeConfig({
    models: { Gem: { extra_args: `--spec-type draft-mtp -fit off -md "${join(root, 'g', 'mtp-Gem.gguf')}"` } },
  })
  const { models } = await run(cfg)
  const m = models.models[0]!
  expect(m.draft).toEqual({ dirId: 'main', rel: 'g/mtp-Gem.gguf' })
  expect(m.profiles['默认']!.extraArgs).toBe('--spec-type draft-mtp -fit off')
})

test('a -md path outside the model root stays in extra args with a warning', async () => {
  writeGguf(join(root, 'Gem-Q4_0.gguf'), modelSpec())
  const cfg = writeConfig({ models: { Gem: { extra_args: '-md "X:\\elsewhere\\d.gguf"' } } })
  const { models, report } = await run(cfg)
  expect(models.models[0]!.draft).toBeNull()
  expect(models.models[0]!.profiles['默认']!.extraArgs).toBe('-md X:\\elsewhere\\d.gguf')
  expect(report.warnings.map(w => w.code)).toEqual(['draft-outside-root'])
})

test('chat template files are copied into data/templates; missing ones warn', async () => {
  writeGguf(join(root, 'A-Q4_0.gguf'), modelSpec())
  writeGguf(join(root, 'B-Q4_0.gguf'), modelSpec())
  const tpl = join(tmp, 'my.jinja')
  writeFileSync(tpl, '{{ x }}')
  const cfg = writeConfig({ models: { A: { chat_template_file: tpl }, B: { chat_template_file: join(tmp, 'nope.jinja') } } })
  const { models, report } = await run(cfg)
  expect(models.models.find(m => m.name === 'A')!.profiles['默认']!.chatTemplate).toBe('my.jinja')
  expect(readFileSync(join(data, 'templates', 'my.jinja'), 'utf8')).toBe('{{ x }}')
  expect(models.models.find(m => m.name === 'B')!.profiles['默认']!.chatTemplate).toBeNull()
  expect(report.warnings.map(w => `${w.code}:${w.subject}`)).toEqual(['template-missing:B'])
})

test('a different template with the same name gets a new name; an identical one is reused', async () => {
  writeGguf(join(root, 'A-Q4_0.gguf'), modelSpec())
  const tpl = join(tmp, 'my.jinja')
  writeFileSync(tpl, 'new')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(data, 'templates'), { recursive: true })
  writeFileSync(join(data, 'templates', 'my.jinja'), 'old')
  const cfg = writeConfig({ models: { A: { chat_template_file: tpl } } })
  const first = await run(cfg)
  expect(first.models.models[0]!.profiles['默认']!.chatTemplate).toBe('my-imported.jinja')
  expect(readFileSync(join(data, 'templates', 'my.jinja'), 'utf8')).toBe('old')
  const second = await run(cfg)
  expect(second.models.models[0]!.profiles['默认']!.chatTemplate).toBe('my-imported.jinja')
})

test('dry run copies nothing', async () => {
  writeGguf(join(root, 'A-Q4_0.gguf'), modelSpec())
  const tpl = join(tmp, 'my.jinja')
  writeFileSync(tpl, 'x')
  const { report } = await run(writeConfig({ models: { A: { chat_template_file: tpl } } }), { dryRun: true })
  expect(report.imported).toHaveLength(1)
  expect(existsSync(join(data, 'templates'))).toBe(false)
})

test('second import skips existing models and keeps edited defaults', async () => {
  writeGguf(join(root, 'A-Q4_0.gguf'), modelSpec())
  writeGguf(join(root, 'B-Q4_0.gguf'), modelSpec())
  const cfg = writeConfig()
  const first = await run(cfg)
  const edited = { ...first.settings, defaults: { ...first.settings.defaults, ctxSize: 1234 } }
  writeGguf(join(root, 'C-Q4_0.gguf'), modelSpec())
  const second = await run(cfg, { settings: edited, models: first.models })
  expect(second.report.defaultsApplied).toBe(false)
  expect(second.settings.defaults.ctxSize).toBe(1234)
  expect(second.report.imported.map(m => m.name)).toEqual(['C'])
  expect(second.report.warnings.map(w => `${w.code}:${w.subject}`).sort()).toEqual(['already-exists:A', 'already-exists:B'])
  expect(second.models.models).toHaveLength(3)
  // C used the old ctx 8192 explicitly since defaults were kept at 1234.
  expect(second.models.models[2]!.profiles['默认']!.overrides.ctxSize).toBe(8192)
  expect(second.settings.modelDirs).toHaveLength(1)
})

test('unknown model root warns; unreadable and invalid files throw', async () => {
  const { report } = await run(writeConfig())
  expect(report.imported).toEqual([])
  expect(report.warnings.map(w => w.code)).toEqual(['models-root-missing'])
  await expect(run(join(tmp, 'missing.json'))).rejects.toMatchObject({ code: 'unreadable' })
  const bad = join(tmp, 'bad.json')
  writeFileSync(bad, '{nope')
  await expect(run(bad)).rejects.toMatchObject({ code: 'invalid-json' })
})
