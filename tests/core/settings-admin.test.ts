import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { cleanWizard, defaultModels, defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, type ModelConfig, type ModelsDoc, type Settings } from '../../server/core/config'
import {
  applyDefaults, applyImagePreprocess, applyModelDirs, applyPublic, applyServer, applySettingsPatch, dirStatus, expandHome, isFirstRun, SettingsError,
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

  test('a leading ~ means the home folder (macOS paste); other uses of ~ stay relative and are rejected', () => {
    const home = abs('home', 'me')
    expect(expandHome('~', home)).toBe(home)
    expect(expandHome('~/models', home)).toBe(join(home, 'models'))
    expect(expandHome('~\\models', home)).toBe(join(home, 'models'))
    expect(expandHome('~other/models', home)).toBe('~other/models')
    expect(expandHome('/Volumes/m', home)).toBe('/Volumes/m')
    const s = settingsWith([])
    expect(() => applyModelDirs(s, [{ path: '~other/models', enabled: true, maxDepth: 1 }], models())).toThrow(SettingsError)
    applyModelDirs(s, [{ path: '~/models', enabled: true, maxDepth: 1 }], models())
    expect(s.modelDirs[0]!.path).toBe(join(homedir(), 'models'))
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

describe('settings version 2 (tunnel hosted by llama-web)', () => {
  test('migration 1 -> 2 drops the tunnel name and adds the switch, keeping the rest', () => {
    const old = { version: 1, public: { enabled: true, port: 8081, domain: 'a.example.com', tunnelName: 'my-tunnel' } }
    const next = SETTINGS_MIGRATIONS[1]!(old)
    expect(next.public).toEqual({ enabled: true, port: 8081, domain: 'a.example.com', tunnelEnabled: false })
  })

  test('normalize fills the switch and removes a leftover tunnel name', () => {
    const s = normalizeSettings({ ...defaultSettings(), public: { enabled: true, port: 8080, domain: '', tunnelName: 'x' } } as never)
    expect(s.public).toEqual({ enabled: true, port: 8080, domain: '', tunnelEnabled: false, tunnelMode: 'token', tunnelProtocol: 'http2', wizard: null })
  })
})

describe('settings version 3 (public access guide progress)', () => {
  const progress = { step: 'cf-zone', mode: 'setup', path: 'api', zoneId: 'z1', subdomain: 'LLM', domain: '' }

  test('migration 2 -> 3 adds "no guide in progress", keeping the rest', () => {
    const old = { version: 2, public: { enabled: true, port: 8081, domain: 'a.example.com', tunnelEnabled: true } }
    expect(SETTINGS_MIGRATIONS[2]!(old).public).toEqual({ enabled: true, port: 8081, domain: 'a.example.com', tunnelEnabled: true, wizard: null })
    const doc = normalizeSettings(SETTINGS_MIGRATIONS[2]!(SETTINGS_MIGRATIONS[1]!({ version: 1, public: { enabled: false, port: 8080, domain: '', tunnelName: 'x' } })))
    expect(doc.public.wizard).toBeNull()
  })

  test('a valid progress survives normalize; a broken one becomes null', () => {
    const ok = normalizeSettings({ ...defaultSettings(), public: { ...defaultSettings().public, wizard: progress } } as never)
    expect(ok.public.wizard).toEqual({ ...progress, subdomain: 'llm' } as never)
    for (const wizard of ['x', 42, { ...progress, step: 'nope' }, { ...progress, mode: 'other' }, []]) {
      expect(normalizeSettings({ ...defaultSettings(), public: { ...defaultSettings().public, wizard } } as never).public.wizard).toBeNull()
    }
  })

  test('cleanWizard: unknown path is null, overlong or control-character text is dropped, extra keys are not kept', () => {
    expect(cleanWizard({ ...progress, path: 'x' })?.path).toBeNull()
    expect(cleanWizard({ ...progress, subdomain: 'a'.repeat(300) })?.subdomain).toBe('')
    expect(cleanWizard({ ...progress, domain: 'a\nb' })?.domain).toBe('')
    const w = cleanWizard({ ...progress, token: 'eyJ-secret' })
    expect(JSON.stringify(w)).not.toContain('eyJ-secret')
  })

  test('applyPublic saves, clears and validates the progress; omitting it keeps it', () => {
    const s = settingsWith()
    applyPublic(s, { wizard: progress })
    expect(s.public.wizard?.step).toBe('cf-zone')
    applyPublic(s, { enabled: true })
    expect(s.public.wizard?.step).toBe('cf-zone')
    expect(codeOf(() => applyPublic(s, { wizard: { ...progress, step: 'bad' } }))).toBe('bad-request')
    expect(codeOf(() => applyPublic(s, { wizard: 'connect' }))).toBe('bad-request')
    expect(s.public.wizard?.step).toBe('cf-zone')
    applyPublic(s, { wizard: null })
    expect(s.public.wizard).toBeNull()
  })
})

describe('settings version 5 (tunnel mode, decision 31)', () => {
  test('migration 4 -> 5: an existing installation keeps its own tunnel, everything else untouched', () => {
    const old = { version: 4, public: { enabled: true, port: 8081, domain: 'a.example.com', tunnelEnabled: true, wizard: null }, llamacpp: { acceleration: 'cuda' } }
    const next = SETTINGS_MIGRATIONS[4]!(structuredClone(old))
    expect(next.public).toEqual({ ...old.public, tunnelMode: 'token', tunnelProtocol: 'http2' })
    expect(next.llamacpp).toEqual(old.llamacpp)
    // A value already there (a newer file written back by hand) is not overwritten.
    expect(SETTINGS_MIGRATIONS[4]!({ version: 4, public: { tunnelMode: 'quick' } }).public.tunnelMode).toBe('quick')
    // No public section at all: nothing to do, normalize fills the default.
    expect(normalizeSettings(SETTINGS_MIGRATIONS[4]!({ version: 4 })).public.tunnelMode).toBe('token')
  })

  test('the whole chain from version 1 ends in token mode', () => {
    let doc: any = { version: 1, public: { enabled: true, port: 8080, domain: 'a.example.com', tunnelName: 'x' } }
    for (let v = 1; v < 5; v++) doc = SETTINGS_MIGRATIONS[v]!(doc)
    expect(normalizeSettings(doc).public).toMatchObject({ enabled: true, domain: 'a.example.com', tunnelEnabled: false, tunnelMode: 'token', tunnelProtocol: 'http2' })
  })

  test('normalize: a hand-edited unknown mode falls back to token; quick survives', () => {
    for (const tunnelMode of ['QUICK', 'trycloudflare', 1, null]) {
      expect(normalizeSettings({ ...defaultSettings(), public: { ...defaultSettings().public, tunnelMode } } as never).public.tunnelMode).toBe('token')
    }
    expect(normalizeSettings({ ...defaultSettings(), public: { ...defaultSettings().public, tunnelMode: 'quick' } }).public.tunnelMode).toBe('quick')
    expect(defaultSettings().public.tunnelMode).toBe('token')
  })

  test('applyPublic saves the mode, keeps it when omitted and refuses anything else', () => {
    const s = settingsWith()
    applyPublic(s, { tunnelMode: 'quick', tunnelEnabled: true, enabled: true })
    expect(s.public).toMatchObject({ tunnelMode: 'quick', tunnelEnabled: true, enabled: true })
    applyPublic(s, { enabled: true })
    expect(s.public.tunnelMode).toBe('quick')
    for (const tunnelMode of ['Quick', 'named', '', 1, null, true]) {
      expect(codeOf(() => applyPublic(s, { tunnelMode }))).toBe('bad-request')
    }
    expect(s.public.tunnelMode).toBe('quick')
    applyPublic(s, { tunnelMode: 'token' })
    expect(s.public.tunnelMode).toBe('token')
  })

  test('protocol: HTTP/2 by default, QUIC as the alternative, anything else refused (hand edits fall back to HTTP/2)', () => {
    expect(defaultSettings().public.tunnelProtocol).toBe('http2')
    const s = settingsWith()
    applyPublic(s, { tunnelProtocol: 'quic' })
    expect(s.public.tunnelProtocol).toBe('quic')
    applyPublic(s, { enabled: true })
    expect(s.public.tunnelProtocol).toBe('quic')
    for (const tunnelProtocol of ['auto', 'HTTP2', 'h2mux', '', null, 2]) {
      expect(codeOf(() => applyPublic(s, { tunnelProtocol }))).toBe('bad-request')
      expect(normalizeSettings({ ...defaultSettings(), public: { ...defaultSettings().public, tunnelProtocol } } as never).public.tunnelProtocol).toBe('http2')
    }
    expect(s.public.tunnelProtocol).toBe('quic')
    expect(SETTINGS_MIGRATIONS[4]!({ version: 4, public: { tunnelProtocol: 'quic' } }).public.tunnelProtocol).toBe('quic')
  })

  test('the guide accepts the quick branch', () => {
    const quick = { step: 'connect', mode: 'setup', path: 'quick', zoneId: '', subdomain: '', domain: '' }
    expect(cleanWizard(quick)).toEqual(quick as never)
    const s = settingsWith()
    applyPublic(s, { wizard: quick })
    expect(s.public.wizard?.path).toBe('quick')
  })
})

describe('applyPublic', () => {
  test('saves on/off, port, lower-cased domain and the tunnel switch', () => {
    const s = settingsWith()
    applyPublic(s, { enabled: true, port: 8081, domain: '  LLM.Example.com ', tunnelEnabled: true })
    expect(s.public).toEqual({ enabled: true, port: 8081, domain: 'llm.example.com', tunnelEnabled: true, tunnelMode: 'token', tunnelProtocol: 'http2', wizard: null })
  })

  test('missing keys are kept; an empty domain is allowed', () => {
    const s = settingsWith()
    applyPublic(s, { domain: 'a.example.com', tunnelEnabled: true })
    applyPublic(s, { enabled: true })
    expect(s.public).toEqual({ enabled: true, port: 8080, domain: 'a.example.com', tunnelEnabled: true, tunnelMode: 'token', tunnelProtocol: 'http2', wizard: null })
    applyPublic(s, { domain: '' })
    expect(s.public.domain).toBe('')
  })

  test('port must be free of the main port and the llama-server range', () => {
    for (const port of [5001, 7100, 7150, 7199, 80, 70000, 8080.5, '8080', null]) {
      expect(codeOf(() => applyPublic(settingsWith(), { port }))).toBe('bad-public-port')
    }
  })

  test('domain is a bare host name: no scheme, path, port, spaces or shell characters', () => {
    for (const domain of ['https://llm.example.com', 'llm.example.com/v1', 'llm.example.com:443', 'llm example.com', 'localhost', 'a.example.com;rm', '-a.example.com', 42]) {
      expect(codeOf(() => applyPublic(settingsWith(), { domain }))).toBe('bad-domain')
    }
  })

  test('the tunnel switch must be a boolean; the token is not part of this patch', () => {
    expect(codeOf(() => applyPublic(settingsWith(), { tunnelEnabled: 'yes' }))).toBe('bad-request')
    const s = settingsWith()
    applyPublic(s, { tunnelToken: 'eyJ-should-be-ignored' } as never)
    expect(JSON.stringify(s)).not.toContain('eyJ-should-be-ignored')
  })

  test('enabled must be a boolean; the section goes through applySettingsPatch', () => {
    expect(codeOf(() => applyPublic(settingsWith(), { enabled: 'yes' }))).toBe('bad-request')
    const s = settingsWith()
    applySettingsPatch(s, { public: { enabled: true } }, models())
    expect(s.public.enabled).toBe(true)
  })
})
