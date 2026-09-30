import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defaultModels, defaultSettings, normalizeSettings, type ModelConfig, type ModelsDoc, type Settings } from '../../server/core/config'
import {
  applyDefaults, applyImagePreprocess, applyModelDirs, applyServer, applySettingsPatch, dirStatus, isFirstRun, SettingsError,
} from '../../server/core/settings-admin'

// Absolute on the host (X:\… is not absolute on macOS / Linux); Windows-only semantics are tested separately.
const ROOT = resolve('/X')
const abs = (...p: string[]) => join(ROOT, ...p)

const dir = (id: string, path: string, over: object = {}) => ({ id, path, enabled: true, maxDepth: 3, ...over })

function settingsWith(dirs = [dir('main', abs('models'))]): Settings {
  const s = defaultSettings()
  s.modelDirs = dirs
  return s
}

function model(dirId: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1', name: 'M1', backend: 'llama-server', file: { dirId, rel: 'a.gguf' }, mmproj: null, draft: null,
    activeProfile: '默认', profiles: { 默认: { overrides: {}, extraArgs: '' } }, ...over,
  }
}

const models = (...m: ModelConfig[]): ModelsDoc => ({ ...defaultModels(), models: m })

function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) { return e instanceof SettingsError ? e.code : `other:${(e as Error).message}` }
  return 'none'
}

describe('applyModelDirs', () => {
  test('keeps ids of existing directories and assigns fresh ids to new ones', () => {
    const s = settingsWith()
    applyModelDirs(s, [
      { id: 'main', path: abs('y-moved'), enabled: false, maxDepth: 1 },
      { path: abs('more'), enabled: true, maxDepth: 0 },
      { id: 'made-up', path: abs('other'), enabled: true, maxDepth: 2 },
    ], models())
    expect(s.modelDirs.map(d => d.id)).toEqual(['main', 'dir-1', 'dir-2'])
    expect(s.modelDirs[0]).toEqual({ id: 'main', path: abs('y-moved'), enabled: false, maxDepth: 1 })
  })

  test('strips quotes and whitespace; rejects relative, empty and non-string paths', () => {
    const s = settingsWith([])
    applyModelDirs(s, [{ path: `  "${abs('models')}"  `, enabled: true, maxDepth: 1 }], models())
    expect(s.modelDirs[0]!.path).toBe(abs('models'))
    for (const bad of ['models', '', '   ', 42, null]) {
      expect(codeOf(() => applyModelDirs(settingsWith([]), [{ path: bad, enabled: true, maxDepth: 1 }], models()))).toBe('dir-path')
    }
  })

  test('rejects duplicate paths (trailing separator ignored)', () => {
    const items = [{ path: abs('models'), enabled: true, maxDepth: 1 }, { path: abs('models') + sep, enabled: true, maxDepth: 1 }]
    expect(codeOf(() => applyModelDirs(settingsWith([]), items, models()))).toBe('dir-duplicate')
  })

  test.if(process.platform === 'win32')('duplicate detection ignores case on Windows', () => {
    const items = [{ path: 'X:\\models', enabled: true, maxDepth: 1 }, { path: 'x:\\MODELS\\', enabled: true, maxDepth: 1 }]
    expect(codeOf(() => applyModelDirs(settingsWith([]), items, models()))).toBe('dir-duplicate')
  })

  test('validates depth and the enabled flag', () => {
    for (const d of [-1, 11, 1.5, '2', null]) {
      expect(codeOf(() => applyModelDirs(settingsWith([]), [{ path: abs('m'), enabled: true, maxDepth: d }], models()))).toBe('dir-depth')
    }
    expect(codeOf(() => applyModelDirs(settingsWith([]), [{ path: abs('m'), enabled: 'yes', maxDepth: 1 }], models()))).toBe('bad-request')
    expect(codeOf(() => applyModelDirs(settingsWith([]), 'nope', models()))).toBe('bad-request')
  })

  test('refuses to remove a directory that enabled models use, but allows disabling or moving it', () => {
    const used = models(model('main'))
    expect(codeOf(() => applyModelDirs(settingsWith(), [], used))).toBe('dir-in-use')
    const s = settingsWith()
    applyModelDirs(s, [{ id: 'main', path: abs('z-new'), enabled: false, maxDepth: 3 }], used)
    expect(s.modelDirs[0]).toMatchObject({ id: 'main', path: abs('z-new'), enabled: false })
    // mmproj / draft references count too.
    const viaMmproj = models(model('other', { mmproj: { dirId: 'main', rel: 'mm.gguf' } }))
    expect(codeOf(() => applyModelDirs(settingsWith(), [], viaMmproj))).toBe('dir-in-use')
    // An unused directory can go.
    const free = settingsWith()
    applyModelDirs(free, [], models())
    expect(free.modelDirs).toEqual([])
  })

  test('does not reuse the same id twice when the client repeats one', () => {
    const s = settingsWith()
    applyModelDirs(s, [
      { id: 'main', path: abs('a'), enabled: true, maxDepth: 1 },
      { id: 'main', path: abs('b'), enabled: true, maxDepth: 1 },
    ], models())
    expect(new Set(s.modelDirs.map(d => d.id)).size).toBe(2)
  })
})

describe('applyDefaults', () => {
  test('updates given keys, keeps the rest, and treats empty as "do not pass"', () => {
    const s = defaultSettings()
    applyDefaults(s, { ctxSize: 8192, cacheTypeK: '', flashAttn: ' off ', extraArgs: '--jinja -cb' })
    expect(s.defaults.ctxSize).toBe(8192)
    expect(s.defaults.cacheTypeK).toBeNull()
    expect(s.defaults.flashAttn).toBe('off')
    expect(s.defaults.gpuLayers).toBe(defaultSettings().defaults.gpuLayers)
    expect(s.defaults.extraArgs).toBe('--jinja -cb')
  })

  test('rejects bad values and unparsable extra args without changing anything', () => {
    const s = defaultSettings()
    expect(codeOf(() => applyDefaults(s, { ctxSize: {} }))).toBe('bad-param')
    expect(codeOf(() => applyDefaults(s, { flashAttn: 'a\nb' }))).toBe('bad-param')
    expect(codeOf(() => applyDefaults(s, { extraArgs: '--x "unterminated' }))).toBe('bad-extra-args')
    expect(codeOf(() => applyDefaults(s, { extraArgs: 5 }))).toBe('bad-extra-args')
    expect(codeOf(() => applyDefaults(s, null))).toBe('bad-request')
  })

  test('ignores keys that are not form fields', () => {
    const s = defaultSettings()
    applyDefaults(s, { ctxSize: 1024, host: '1.2.3.4', port: 1 })
    expect(Object.keys(s.defaults).sort()).toEqual(Object.keys(defaultSettings().defaults).sort())
  })
})

describe('applyImagePreprocess', () => {
  test('applies a full valid config', () => {
    const s = defaultSettings()
    applyImagePreprocess(s, { enabled: false, maxEdge: 1280, format: 'webp', quality: 80 })
    expect(s.preprocess.image).toEqual({ enabled: false, maxEdge: 1280, format: 'webp', quality: 80 })
  })

  test('rejects out-of-range and wrong-typed values', () => {
    const s = defaultSettings()
    for (const bad of [{ maxEdge: 10 }, { maxEdge: 100000 }, { maxEdge: 900.5 }, { quality: 0 }, { quality: 101 }, { format: 'gif' }, { enabled: 'yes' }]) {
      expect(codeOf(() => applyImagePreprocess(s, bad))).toBe('bad-image')
    }
    expect(s.preprocess.image).toEqual(defaultSettings().preprocess.image)
  })
})

describe('applyServer', () => {
  test('saves port, range and timeouts; never touches maxLoaded', () => {
    const s = defaultSettings()
    applyServer(s, { port: 5005, portRange: [7200, 7250], loadTimeoutSec: 120, drainTimeoutSec: 60, maxLoaded: 4 })
    expect(s.server.port).toBe(5005)
    expect(s.scheduler.portRange).toEqual([7200, 7250])
    expect(s.scheduler.loadTimeoutSec).toBe(120)
    expect(s.scheduler.drainTimeoutSec).toBe(60)
    expect(s.scheduler.maxLoaded).toBe(1)
  })

  test('rejects bad ports, ranges that contain the listening or public port, and bad timeouts', () => {
    const s = defaultSettings()
    expect(codeOf(() => applyServer(s, { port: 80 }))).toBe('bad-port')
    expect(codeOf(() => applyServer(s, { port: '5001' }))).toBe('bad-port')
    expect(codeOf(() => applyServer(s, { port: s.public.port }))).toBe('bad-port')
    expect(codeOf(() => applyServer(s, { portRange: [7300, 7200] }))).toBe('bad-port-range')
    expect(codeOf(() => applyServer(s, { portRange: [7100] }))).toBe('bad-port-range')
    expect(codeOf(() => applyServer(s, { portRange: [5000, 5100] }))).toBe('bad-port-range')
    expect(codeOf(() => applyServer(s, { port: 7150 }))).toBe('bad-port-range')
    expect(codeOf(() => applyServer(s, { portRange: [8000, 8100] }))).toBe('bad-port-range')
    expect(codeOf(() => applyServer(s, { loadTimeoutSec: 1 }))).toBe('bad-timeout')
    expect(codeOf(() => applyServer(s, { drainTimeoutSec: 99999 }))).toBe('bad-timeout')
    expect(s.server.port).toBe(5001)
  })
})

describe('applySettingsPatch', () => {
  test('applies several sections together and needs at least one', () => {
    const s = settingsWith([])
    applySettingsPatch(s, { modelDirs: [{ path: abs('m'), enabled: true, maxDepth: 2 }], image: { quality: 70 }, setupDone: true }, models())
    expect(s.modelDirs).toHaveLength(1)
    expect(s.preprocess.image.quality).toBe(70)
    expect(s.setup.done).toBe(true)
    for (const bad of [null, [], {}, { nothing: 1 }, 'x']) expect(codeOf(() => applySettingsPatch(settingsWith(), bad, models()))).toBe('bad-request')
    expect(codeOf(() => applySettingsPatch(settingsWith(), { setupDone: 'yes' }, models()))).toBe('bad-request')
  })

  test('a failing section throws (the store discards the draft, so nothing is written)', () => {
    expect(codeOf(() => applySettingsPatch(settingsWith(), { image: { quality: 70 }, server: { port: 1 } }, models()))).toBe('bad-port')
  })

  test('the result still passes normalizeSettings and keeps maxLoaded at 1', () => {
    const s = settingsWith()
    applySettingsPatch(s, { server: { port: 5010 }, defaults: { ctxSize: 4096 } }, models())
    expect(normalizeSettings(structuredClone(s)).scheduler.maxLoaded).toBe(1)
  })
})

describe('first run and directory status', () => {
  test('first run only while nothing is configured and the wizard is not done', () => {
    const s = defaultSettings()
    expect(isFirstRun(s, models())).toBe(true)
    expect(isFirstRun({ ...s, modelDirs: [dir('main', abs('m'))] }, models())).toBe(false)
    expect(isFirstRun(s, models(model('main')))).toBe(false)
    expect(isFirstRun({ ...s, setup: { done: true } }, models())).toBe(false)
  })

  test('old settings files without a "setup" section are filled from defaults', () => {
    const { setup: _omit, ...old } = defaultSettings()
    expect(normalizeSettings(old as unknown as Settings).setup).toEqual({ done: false })
  })

  test('dirStatus reports whether the directory exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lw-dirs-'))
    try {
      expect(dirStatus(dir('a', tmp))).toEqual({ exists: true })
      expect(dirStatus(dir('b', join(tmp, 'nope')))).toEqual({ exists: false })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
