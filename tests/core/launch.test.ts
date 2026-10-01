import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { defaultSettings, normalizeModels, normalizeSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { splitArgs } from '../../server/core/args'
import { LaunchConfigError, llamaServerExe, planLaunch, previewLaunch } from '../../server/core/launch'

// Host-absolute placeholder root, so path resolution behaves the same on every platform.
const root = resolve('/X')
const dataDir = join(root, 'data')
const settings = (): Settings => ({
  ...defaultSettings(),
  modelDirs: [{ id: 'main', path: join(root, 'models'), enabled: true, maxDepth: 4 }],
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
    expect(args.slice(0, 4)).toEqual(['--model', join(root, 'models', 'q', 'm.gguf'), '--mmproj', join(root, 'models', 'q', 'mm.gguf')])
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

  test('scheduler.maxLoaded is a placeholder pinned to 1 (decision 9)', () => {
    for (const v of [2, 'abc', 0, 1.5, 1]) {
      expect(normalizeSettings({ version: 1, scheduler: { maxLoaded: v } } as any).scheduler.maxLoaded).toBe(1)
    }
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

describe('previewLaunch', () => {
  const base = () => ({ dataDir, settings: settings(), host: '127.0.0.1', exists: all, platform: 'win32' as const })
  const form = (over: Record<string, unknown> = {}) => ({ overrides: {}, extraArgs: '', chatTemplate: null, ...over }) as Parameters<typeof previewLaunch>[0]['form']

  test('shows the same arguments planLaunch would start with (saved profile)', () => {
    const m = models()
    const profile = m.models[0]!.profiles.default!
    const plan = planLaunch({ modelId: 'm', profile: 'default' }, { ...base(), models: m })
    const p = previewLaunch({ ...base(), model: m.models[0]!, form: { overrides: profile.overrides, extraArgs: profile.extraArgs, chatTemplate: null } })
    const [exe, ...args] = splitArgs(p.command)
    expect(exe).toBe(plan.exe)
    expect(args).toEqual(plan.args(p.port))
    expect(p.ok).toBe(true)
    expect(p.missing).toEqual([])
  })

  test('reflects unsaved form values and chat template', () => {
    const p = previewLaunch({ ...base(), model: models().models[0]!, form: form({ overrides: { ctxSize: 8192, cacheTypeK: null }, chatTemplate: 'x.jinja', extraArgs: '--foo 1' }) })
    const args = splitArgs(p.command).slice(1)
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('8192')
    expect(args).not.toContain('--cache-type-k')
    expect(args[args.indexOf('--chat-template-file') + 1]).toBe(join(dataDir, 'templates', 'x.jinja'))
    expect(args).toContain('--foo')
  })

  test('never throws for missing files or runtime; reports them and keeps the command', () => {
    const p = previewLaunch({ ...base(), exists: () => false, model: models().models[0]!, form: form({ chatTemplate: 'x.jinja' }) })
    expect([...p.missing].sort()).toEqual(['chatTemplate', 'mmproj', 'model', 'runtime'])
    expect(p.command).toContain('--model')
  })

  test('without a runtime version the program name is a placeholder', () => {
    const s = settings()
    s.llamacpp.current = ''
    const p = previewLaunch({ ...base(), settings: s, model: models().models[0]!, form: form() })
    expect(p.command.startsWith('llama-server.exe ')).toBe(true)
    expect(p.missing).toContain('runtime')
  })

  test('warns when cmd.exe could expand the program path (spaces plus a %NAME% pair)', () => {
    const odd = previewLaunch({ ...base(), dataDir: join(root, 'a b %LLW_X%', 'data'), model: models().models[0]!, form: form() })
    expect(odd.warnings.map(w => w.code)).toContain('preview-program-percent')
    expect(odd.ok).toBe(true)
    const plain = previewLaunch({ ...base(), model: models().models[0]!, form: form() })
    expect(plain.warnings.map(w => w.code)).not.toContain('preview-program-percent')
  })

  test('argument problems are reported, not thrown', () => {
    const p = previewLaunch({ ...base(), model: models().models[0]!, form: form({ extraArgs: '"oops' }) })
    expect(p.ok).toBe(false)
    expect(p.warnings.some(w => w.code === 'extra-syntax-error')).toBe(true)
    const q = previewLaunch({ ...base(), model: models().models[0]!, form: form({ extraArgs: '-c 100 --port 1' }) })
    expect(q.warnings.map(w => w.code).sort()).toEqual(['extra-overrides-form', 'reserved-flag-removed'])
  })
})
