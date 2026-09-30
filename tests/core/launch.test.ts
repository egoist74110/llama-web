import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { defaultSettings, normalizeModels, normalizeSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { LaunchConfigError, llamaServerExe, planLaunch } from '../../server/core/launch'

const dataDir = join('X:', 'data')
const settings = (): Settings => ({
  ...defaultSettings(),
  modelDirs: [{ id: 'main', path: join('X:', 'models'), enabled: true, maxDepth: 4 }],
  llamacpp: { ...defaultSettings().llamacpp, current: 'b1234' },
})
const models = (): ModelsDoc => ({
  version: 1,
  models: [{
    id: 'm', name: 'M', backend: 'llama-server',
    file: { dirId: 'main', rel: 'q/m.gguf' }, mmproj: { dirId: 'main', rel: 'q/mm.gguf' }, draft: null,
    activeProfile: 'default',
    profiles: {
      default: { overrides: { ctxSize: 4096 }, extraArgs: '--jinja' },
      tpl: { overrides: {}, extraArgs: '', chatTemplate: 'x.jinja' },
      bad: { overrides: {}, extraArgs: '"unterminated' },
    },
  }],
})
const all = () => true

describe('planLaunch', () => {
  test('builds exe path and args with resolved files; host/port last', () => {
    const plan = planLaunch({ modelId: 'm', profile: 'default' }, { dataDir, settings: settings(), models: models(), host: '127.0.0.1', exists: all, platform: 'win32' })
    expect(plan.exe).toBe(join(dataDir, 'runtime', 'llama.cpp', 'b1234', 'llama-server.exe'))
    const args = plan.args(7123)
    expect(args.slice(0, 4)).toEqual(['--model', join('X:', 'models', 'q', 'm.gguf'), '--mmproj', join('X:', 'models', 'q', 'mm.gguf')])
    expect(args).toContain('--jinja')
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('4096')
    expect(args.slice(-4)).toEqual(['--host', '127.0.0.1', '--port', '7123'])
    expect(plan.tag).toBe('m:default')
    expect(plan.loadTimeoutMs).toBe(600_000)
  })

  test('chat template from data/templates', () => {
    const plan = planLaunch({ modelId: 'm', profile: 'tpl' }, { dataDir, settings: settings(), models: models(), host: '127.0.0.1', exists: all })
    const args = plan.args(7100)
    expect(args[args.indexOf('--chat-template-file') + 1]).toBe(join(dataDir, 'templates', 'x.jinja'))
  })

  const code = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof LaunchConfigError ? e.code : 'other' }
    return 'none'
  }

  test('configuration errors', () => {
    const base = { dataDir, settings: settings(), models: models(), host: '127.0.0.1', exists: all }
    expect(code(() => planLaunch({ modelId: 'x', profile: 'default' }, base))).toBe('model-missing')
    expect(code(() => planLaunch({ modelId: 'm', profile: 'x' }, base))).toBe('profile-missing')
    expect(code(() => planLaunch({ modelId: 'm', profile: 'bad' }, base))).toBe('bad-args')
    expect(code(() => planLaunch({ modelId: 'm', profile: 'default' }, { ...base, exists: p => !p.endsWith('mm.gguf') }))).toBe('file-missing')
    expect(code(() => planLaunch({ modelId: 'm', profile: 'default' }, { ...base, exists: p => !p.includes('llama-server') }))).toBe('no-runtime')
    const noVersion = settings()
    noVersion.llamacpp.current = ''
    expect(code(() => planLaunch({ modelId: 'm', profile: 'default' }, { ...base, settings: noVersion }))).toBe('no-runtime')
  })

  test('llamaServerExe rejects path-like versions', () => {
    const s = settings()
    s.llamacpp.current = '..\\evil'
    expect(llamaServerExe(dataDir, s)).toBeNull()
  })
})

describe('config normalisation', () => {
  test('fills missing sections and keys from defaults', () => {
    const s = normalizeSettings({ version: 1, scheduler: { heartbeatSec: 5 } } as any)
    expect(s.scheduler.heartbeatSec).toBe(5)
    expect(s.scheduler.portRange).toEqual([7100, 7199])
    expect(s.preprocess.image.maxEdge).toBe(896)
    expect(s.server.port).toBe(5001)
  })

  test('rejects wrong shapes', () => {
    expect(() => normalizeSettings({ version: 1, scheduler: [] } as any)).toThrow()
    expect(() => normalizeSettings({ version: 1, scheduler: { portRange: [9, 1] } } as any)).toThrow()
    expect(() => normalizeModels({ version: 1, models: {} } as any)).toThrow()
    expect(() => normalizeModels({ version: 1, models: [{ id: 'x' }] } as any)).toThrow()
  })

  test('models get defaults for optional fields', () => {
    const m = normalizeModels({ version: 1, models: [{ id: 'x', profiles: {} }] } as any)
    expect(m.models[0]).toMatchObject({ id: 'x', name: 'x', mmproj: null, draft: null, backend: 'llama-server' })
  })
})
