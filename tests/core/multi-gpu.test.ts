// GPU groups and split modes (decision 45, package 8-7): choice rules, argument assembly, layer resolution,
// automatic pick, build capability parsing, the confirmed / failed memory and failure diagnosis. A fake
// device list stands in for a second GPU: this machine has one card, so nothing here ran on real multi-GPU.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildLaunchArgs, DEFAULT_LAUNCH_DEFAULTS, deviceArgs, type BuildInput } from '../../server/core/args'
import { defaultSettings, normalizeModels, normalizeSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { DeviceProbe, describeDevices, parseSplitModes, type DeviceList } from '../../server/core/devices'
import { classify, diagnose } from '../../server/core/errors'
import { applyGpuChoice, autoPick, cleanStoredChoice, comboKey, resolveGpuSelection, sanitizeGpuChoice } from '../../server/core/gpu-group'
import { LaunchConfigError, planLaunch, previewLaunch } from '../../server/core/launch'
import { ProfileError, sanitizeForm, saveProfile, setModelGpu } from '../../server/core/models-admin'
import { applyDefaults, SettingsError } from '../../server/core/settings-admin'
import { blamesSplitMode, comboWarnings, SplitModeLoadError, SplitStats } from '../../server/core/split-stats'
import { LoadError } from '../../server/core/runner'

const gpu = (i: number, totalMiB: number, freeMiB = totalMiB) => ({ id: `CUDA${i}`, name: `Fake ${i}`, totalMiB, freeMiB })
const list = (...g: ReturnType<typeof gpu>[]): DeviceList => ({ source: 'list-devices', gpus: g })
const two = list(gpu(0, 24000), gpu(1, 32000))
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('sanitizeGpuChoice', () => {
  test('nothing / single values keep the old behaviour', () => {
    expect(sanitizeGpuChoice(undefined)).toEqual({ device: '', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' })
    expect(sanitizeGpuChoice({ device: 'CUDA0' })!.device).toBe('CUDA0')
    expect(sanitizeGpuChoice({ device: 'CPU' })!.device).toBe('cpu')
    expect(sanitizeGpuChoice({ device: 'CUDA0,CUDA1' })).toBeNull()
  })
  test('two or more devices are a group; one device is the single choice and drops the group fields', () => {
    const g = sanitizeGpuChoice({ devices: ['CUDA1', 'CUDA0'], splitMode: 'Tensor', tensorSplit: '3, 1', mainGpu: '1' })!
    expect(g).toEqual({ device: '', devices: ['CUDA1', 'CUDA0'], splitMode: 'tensor', tensorSplit: '3,1', mainGpu: '1' })
    const one = sanitizeGpuChoice({ devices: ['CUDA1'], splitMode: 'row', tensorSplit: '1', mainGpu: '0' })!
    expect(one).toEqual({ device: 'CUDA1', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' })
  })
  test('a group replaces the single device; the split fields mean nothing without a group', () => {
    expect(sanitizeGpuChoice({ device: 'CUDA9', devices: ['CUDA0', 'CUDA1'] })!.device).toBe('')
    expect(sanitizeGpuChoice({ device: 'CUDA0', splitMode: 'row', tensorSplit: '1,1' })).toEqual({ device: 'CUDA0', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' })
  })
  test('refuses what cannot work', () => {
    const bad: unknown[] = [
      { devices: ['CUDA0', 'CUDA0'] }, { devices: ['CUDA0', 'auto'] }, { devices: ['CUDA0', 'cpu'] }, { devices: ['CUDA0', 'none'] },
      { devices: ['CUDA0', 5] }, { devices: 'CUDA0,CUDA1' }, { devices: Array.from({ length: 17 }, (_, i) => `CUDA${i}`) },
      { devices: ['CUDA0', 'CUDA1'], splitMode: 'none' }, { devices: ['CUDA0', 'CUDA1'], splitMode: 'bogus' },
      { devices: ['CUDA0', 'CUDA1'], tensorSplit: '3' }, { devices: ['CUDA0', 'CUDA1'], tensorSplit: '3,1,1' },
      { devices: ['CUDA0', 'CUDA1'], tensorSplit: 'a,b' }, { devices: ['CUDA0', 'CUDA1'], tensorSplit: '0,0' }, { devices: ['CUDA0', 'CUDA1'], tensorSplit: '-1,2' },
      { devices: ['CUDA0', 'CUDA1'], mainGpu: '2' }, { devices: ['CUDA0', 'CUDA1'], mainGpu: 'x' }, 'text', [],
    ]
    for (const b of bad) expect(sanitizeGpuChoice(b)).toBeNull()
  })
})

describe('layers and the automatic pick', () => {
  test('the first layer with a choice wins as a whole, with its own split fields', () => {
    const profile = { device: 'CUDA0' }
    const model = { devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '2,1' }
    const global = { devices: ['CUDA1', 'CUDA0'], splitMode: 'row' }
    expect(resolveGpuSelection(profile, model, global)).toEqual({ device: 'CUDA0', group: null })
    const sel = resolveGpuSelection({}, model, global)
    expect(sel.device).toBe('CUDA0,CUDA1')
    expect(sel.group).toEqual({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '2,1', mainGpu: null })
    expect(resolveGpuSelection({}, {}, global).group?.splitMode).toBe('row')
    expect(resolveGpuSelection({}, {}, {})).toEqual({ device: 'auto', group: null })
  })
  test('a group without a mode uses layer; an explicit auto / cpu beats a lower group', () => {
    expect(resolveGpuSelection({ devices: ['CUDA0', 'CUDA1'] }).group?.splitMode).toBe('layer')
    expect(resolveGpuSelection({ device: 'auto' }, { devices: ['CUDA0', 'CUDA1'] })).toEqual({ device: 'auto', group: null })
    expect(resolveGpuSelection({ device: 'cpu' }, { devices: ['CUDA0', 'CUDA1'] }).device).toBe('cpu')
  })
  test('autoPick: the most memory among several GPUs, otherwise leave auto alone', () => {
    expect(autoPick(two)?.id).toBe('CUDA1')
    expect(autoPick(list(gpu(0, 100), gpu(1, 100)))?.id).toBe('CUDA0')
    expect(autoPick(list(gpu(0, 100)))).toBeNull()
    expect(autoPick({ source: 'nvidia-smi', gpus: two.gpus })).toBeNull()
    expect(autoPick({ source: 'unavailable', gpus: [] })).toBeNull()
  })
  test('stored fields: applyGpuChoice sets and clears, cleanStoredChoice drops a choice that is not valid as a whole', () => {
    const o: Record<string, unknown> = { device: 'CUDA0' }
    applyGpuChoice(o, sanitizeGpuChoice({ devices: ['CUDA0', 'CUDA1'], splitMode: 'layer', tensorSplit: '1,1' })!)
    expect(o).toEqual({ devices: ['CUDA0', 'CUDA1'], splitMode: 'layer', tensorSplit: '1,1' })
    applyGpuChoice(o, sanitizeGpuChoice({})!)
    expect(o).toEqual({})
    const broken: Record<string, unknown> = { devices: ['CUDA0', 'CUDA1'], tensorSplit: '1,2,3', splitMode: 'row' }
    cleanStoredChoice(broken)
    expect(broken).toEqual({})
  })
  test('loading settings / models cleans hand-edited groups; valid ones and old single devices survive', () => {
    const s = defaultSettings()
    s.defaults.devices = ['CUDA0', 'CUDA1']; s.defaults.splitMode = 'tensor'
    s.defaultsCpu.devices = ['CUDA0', 'CUDA0']
    const n = normalizeSettings(s)
    expect(n.defaults.devices).toEqual(['CUDA0', 'CUDA1'])
    expect(n.defaults.splitMode).toBe('tensor')
    expect(n.defaultsCpu.devices).toBeUndefined()
    const doc: ModelsDoc = {
      version: 1,
      models: [{ id: 'm', name: 'm', backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'a', device: 'CUDA0',
        profiles: { a: { overrides: {}, extraArgs: '', devices: ['CUDA0', 'CUDA1'], splitMode: 'row' }, b: { overrides: {}, extraArgs: '', devices: ['x y', 'CUDA1'] }, c: { overrides: {}, extraArgs: '', device: 'CUDA1' } } }],
    }
    const m = normalizeModels(doc).models[0]!
    expect(m.device).toBe('CUDA0')
    expect(m.profiles.a!.devices).toEqual(['CUDA0', 'CUDA1'])
    expect(m.profiles.b!.devices).toBeUndefined()
    expect(m.profiles.c!.device).toBe('CUDA1')
  })
})

describe('argument assembly', () => {
  const build = (over: Partial<BuildInput> = {}) => buildLaunchArgs({ paths: { model: 'X:\\m.gguf' }, defaults: { ...DEFAULT_LAUNCH_DEFAULTS, extraArgs: '' }, host: '127.0.0.1', port: 7100, ...over })
  const group = (over = {}) => ({ devices: ['CUDA0', 'CUDA1'], splitMode: 'layer' as const, tensorSplit: null, mainGpu: null, ...over })
  test('a group passes --device a,b and --split-mode, nothing else by default', () => {
    const r = build({ device: 'CUDA0,CUDA1', group: group() })
    expect(after(r.args, '--device')).toBe('CUDA0,CUDA1')
    expect(after(r.args, '--split-mode')).toBe('layer')
    expect(r.args).not.toContain('--tensor-split')
    expect(r.args).not.toContain('--main-gpu')
    expect(r.warnings).toEqual([])
  })
  test('ratio and main GPU are passed only when set', () => {
    const r = build({ device: 'CUDA0,CUDA1', group: group({ splitMode: 'row', tensorSplit: '3,1', mainGpu: '1' }) })
    expect(after(r.args, '--split-mode')).toBe('row')
    expect(after(r.args, '--tensor-split')).toBe('3,1')
    expect(after(r.args, '--main-gpu')).toBe('1')
    expect(deviceArgs('x', group({ tensorSplit: '1,1' }))).toContainEqual(['--tensor-split', '1,1'])
  })
  test('extra args replace the group flags and are reported; hand-written split flags warn', () => {
    const r = build({ device: 'CUDA0,CUDA1', group: group({ tensorSplit: '1,1' }), profile: { extraArgs: '--tensor-split 2,1 --split-mode=row' } })
    expect(r.args.filter(a => a === '--tensor-split')).toHaveLength(1)
    expect(after(r.args, '--tensor-split')).toBe('2,1')
    expect(r.warnings.filter(w => w.code === 'extra-overrides-device').map(w => w.flag).sort()).toEqual(['--split-mode', '--tensor-split'])
    expect(r.warnings.some(w => w.code === 'extra-multi-device' && w.flag === '--tensor-split')).toBe(true)
    // `--split-mode none` is a single-device pin, not a spread
    const none = build({ profile: { extraArgs: '--split-mode none' } })
    expect(none.warnings.some(w => w.code === 'extra-multi-device')).toBe(false)
    expect(build({ profile: { extraArgs: '--main-gpu 1' } }).warnings.some(w => w.code === 'extra-multi-device')).toBe(true)
  })
})

describe('planLaunch with groups', () => {
  const root = resolve('/X')
  const settings = (): Settings => ({
    ...defaultSettings(),
    modelDirs: [{ id: 'main', path: join(root, 'models'), enabled: true, maxDepth: 4 }],
    llamacpp: { ...defaultSettings().llamacpp, current: 'b1234', currentCpu: 'b1234' },
  })
  const models = (profile: Record<string, unknown> = {}, model: Record<string, unknown> = {}): ModelsDoc => ({
    version: 1,
    models: [{ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'main', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'a', ...model, profiles: { a: { overrides: {}, extraArgs: '', ...profile } } }],
  })
  const target = (os: NodeJS.Platform) => ({ os, arch: os === 'darwin' ? 'arm64' : 'x64', acceleration: os === 'darwin' ? 'metal' : 'cuda' }) as never
  const plan = (m: ModelsDoc, s = settings(), os: NodeJS.Platform = 'win32') =>
    planLaunch({ modelId: 'm', profile: 'a' }, { dataDir: join(root, 'data'), settings: s, models: m, host: '127.0.0.1', exists: () => true, platform: os, target: target(os) })
  const info = (devices: DeviceList, splitModes: string[] | null = ['layer', 'row', 'tensor']) => ({ devices, splitModes })

  test('a profile group reaches the arguments and needs both devices on the list', () => {
    const p = plan(models({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '3,1' }))
    expect(p.devices).toEqual(['CUDA0', 'CUDA1'])
    expect(p.device).toBe('CUDA0,CUDA1')
    const r = p.resolve(info(two))
    const a = r.args(7100)
    expect(after(a, '--device')).toBe('CUDA0,CUDA1')
    expect(after(a, '--split-mode')).toBe('tensor')
    expect(after(a, '--tensor-split')).toBe('3,1')
    expect(r.combo).toBe(comboKey('cuda:b1234', ['CUDA0', 'CUDA1'], 'tensor'))
  })
  test('a missing device in a group throws device-missing; a list that could not be read blocks nothing', () => {
    const p = plan(models({ devices: ['CUDA0', 'CUDA7'] }))
    expect(() => p.resolve(info(two))).toThrow(LaunchConfigError)
    try { p.resolve(info(two)) } catch (e) { expect((e as LaunchConfigError).code).toBe('device-missing') }
    expect(() => p.resolve(info({ source: 'unavailable', gpus: [] }))).not.toThrow()
    expect(() => p.resolve(info({ source: 'nvidia-smi', gpus: two.gpus }))).not.toThrow()
  })
  test('a split mode the build does not list is refused; an unreadable help blocks nothing', () => {
    const p = plan(models({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor' }))
    try { p.resolve(info(two, ['layer', 'row'])); throw new Error('should throw') } catch (e) {
      expect((e as LaunchConfigError).code).toBe('split-mode-unsupported')
      expect(diagnose(e)?.kind).toBe('split-mode-unsupported')
    }
    expect(() => p.resolve(info(two, null))).not.toThrow()
    expect(() => p.resolve(info(two, ['layer', 'row', 'tensor']))).not.toThrow()
  })
  test('row / tensor warn until confirmed and after a failure; layer never does', () => {
    const tensor = plan(models({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor' }))
    expect(tensor.resolve(info(two)).warnings.map(w => w.code)).toEqual(['split-mode-unconfirmed'])
    expect(tensor.resolve(info(two), { confirmedAt: 1 }).warnings).toEqual([])
    expect(tensor.resolve(info(two), { confirmedAt: 1, failed: { at: 2, kind: 'crashed' } }).warnings.map(w => w.code)).toEqual(['split-mode-failed-before'])
    expect(plan(models({ devices: ['CUDA0', 'CUDA1'] })).resolve(info(two)).warnings).toEqual([])
  })
  test('automatic: several GPUs pick the largest, one GPU leaves the command as it was; cpu and a Mac are never probed', () => {
    const auto = plan(models())
    expect(auto.resolve(info(two)).autoPicked).toBe('CUDA1')
    const picked = auto.resolve(info(two))
    expect(after(picked.args(7100), '--device')).toBe('CUDA1')
    expect(after(picked.args(7100), '--split-mode')).toBe('none')
    expect(picked.devices).toEqual(['CUDA1'])
    const single = auto.resolve(info(list(gpu(0, 24000))))
    expect(single.autoPicked).toBeNull()
    expect(single.args(7100)).not.toContain('--device')
    // an explicit single choice is not replaced
    expect(plan(models({ device: 'CUDA0' })).resolve(info(two)).autoPicked).toBeNull()
    // extra args with their own --device keep the pick away
    expect(plan(models({ extraArgs: '--device CUDA0' })).resolve(info(two)).autoPicked).toBeNull()
    const mac = plan(models({ devices: ['CUDA0', 'CUDA1'] }), settings(), 'darwin')
    expect(mac.group).toBeNull()
    expect(mac.args(7100)).not.toContain('--device')
  })
  test('the model layer and global defaults carry groups too', () => {
    const s = settings(); s.defaults.devices = ['CUDA1', 'CUDA0']; s.defaults.splitMode = 'row'
    expect(plan(models(), s).group?.splitMode).toBe('row')
    expect(plan(models({}, { devices: ['CUDA0', 'CUDA1'] }), s).group?.devices).toEqual(['CUDA0', 'CUDA1'])
    expect(plan(models({ device: 'CUDA0' }), s).group).toBeNull()
  })
  test('the preview shows the group, the automatic pick and the warnings', () => {
    const input = (form: Record<string, unknown>, deviceInfo = info(two)) => ({
      dataDir: join(root, 'data'), settings: settings(), model: models().models[0]!, host: '127.0.0.1', exists: () => true, platform: 'win32' as const,
      target: target('win32'), form: { overrides: {}, extraArgs: '', chatTemplate: null, ...form }, deviceInfo,
    })
    const g = previewLaunch(input({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor' }))
    expect(g.command).toContain('--device CUDA0,CUDA1')
    expect(g.command).toContain('--split-mode tensor')
    expect(g.warnings.map(w => w.code)).toContain('split-mode-unconfirmed')
    expect(g.ok).toBe(true)
    const bad = previewLaunch(input({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor' }, info(two, ['layer'])))
    expect(bad.ok).toBe(false)
    expect(bad.warnings.some(w => w.code === 'split-mode-unsupported')).toBe(true)
    expect(previewLaunch(input({})).device).toBe('CUDA1')
    expect(previewLaunch({ ...input({}), deviceInfo: undefined }).device).toBe('auto')
  })
})

describe('saving', () => {
  const doc = (): ModelsDoc => ({
    version: 1,
    models: [{ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'main', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'a', profiles: { a: { overrides: {}, extraArgs: '' } } }],
  })
  const form = (gpu: Record<string, unknown>) => sanitizeForm({ overrides: {}, extraArgs: '', ...gpu })
  test('a group is saved whole on a profile; a later single choice clears it', () => {
    const d = doc()
    saveProfile(d, 'm', 'a', form({ device: '', devices: ['CUDA0', 'CUDA1'], splitMode: 'row', tensorSplit: '1,1', mainGpu: '0' }), [])
    expect(d.models[0]!.profiles.a).toMatchObject({ devices: ['CUDA0', 'CUDA1'], splitMode: 'row', tensorSplit: '1,1', mainGpu: '0' })
    expect(d.models[0]!.profiles.a!.device).toBeUndefined()
    saveProfile(d, 'm', 'a', form({ device: 'CUDA1', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' }), [])
    expect(d.models[0]!.profiles.a!.devices).toBeUndefined()
    expect(d.models[0]!.profiles.a!.splitMode).toBeUndefined()
    expect(d.models[0]!.profiles.a!.device).toBe('CUDA1')
    saveProfile(d, 'm', 'a', form({ device: null }), [])
    expect(d.models[0]!.profiles.a!.device).toBeUndefined()
  })
  test('a form without device fields leaves the saved choice; an invalid group is refused; a host without devices refuses', () => {
    const d = doc()
    saveProfile(d, 'm', 'a', form({ devices: ['CUDA0', 'CUDA1'] }), [])
    saveProfile(d, 'm', 'a', sanitizeForm({ overrides: {}, extraArgs: 'x' }), [])
    expect(d.models[0]!.profiles.a!.devices).toEqual(['CUDA0', 'CUDA1'])
    expect(() => form({ devices: ['CUDA0', 'CUDA1'], tensorSplit: '1' })).toThrow(ProfileError)
    expect(() => saveProfile(doc(), 'm', 'a', form({ devices: ['CUDA0', 'CUDA1'] }), [], undefined, () => false)).toThrow(ProfileError)
  })
  test('the model layer', () => {
    const d = doc()
    setModelGpu(d, 'm', sanitizeGpuChoice({ devices: ['CUDA0', 'CUDA1'], splitMode: 'layer' })!)
    expect(d.models[0]!.devices).toEqual(['CUDA0', 'CUDA1'])
    setModelGpu(d, 'm', sanitizeGpuChoice({})!)
    expect(d.models[0]!.devices).toBeUndefined()
    expect(() => setModelGpu(d, 'm', sanitizeGpuChoice({ devices: ['CUDA0', 'CUDA1'] })!, () => false)).toThrow(ProfileError)
  })
  const WIN = { os: 'win32' as const } // the device fields are Windows-only: pin the host, not the machine running the test
  test('global defaults: a group is saved whole, a bad one or a Mac is refused', () => {
    const s = defaultSettings()
    applyDefaults(s, { devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '2,1' }, 'defaults', WIN)
    expect(s.defaults).toMatchObject({ devices: ['CUDA0', 'CUDA1'], splitMode: 'tensor', tensorSplit: '2,1' })
    applyDefaults(s, { device: 'CUDA0', devices: [], splitMode: '', tensorSplit: '', mainGpu: '' }, 'defaults', WIN)
    expect(s.defaults.devices).toBeUndefined()
    expect(s.defaults.device).toBe('CUDA0')
    applyDefaults(s, { threads: 4 }, 'defaults', WIN) // other fields do not touch the choice
    expect(s.defaults.device).toBe('CUDA0')
    expect(() => applyDefaults(s, { devices: ['CUDA0', 'CUDA1'], tensorSplit: '1' }, 'defaults', WIN)).toThrow(SettingsError)
    expect(() => applyDefaults(s, { devices: ['CUDA0', 'CUDA1'] }, 'defaults', { os: 'darwin' })).toThrow(SettingsError)
  })
})

describe('build capabilities', () => {
  test('parseSplitModes reads the braces of --split-mode (b11146 help text) and leaves out none', () => {
    const help = `-ngl,  --gpu-layers N  max\n-sm,   --split-mode {none,layer,row,tensor}\n                  how to split\n`
    expect(parseSplitModes(help)).toEqual(['layer', 'row', 'tensor'])
    expect(parseSplitModes('--split-mode {none,layer}')).toEqual(['layer'])
    expect(parseSplitModes('--split-mode <mode>')).toBeNull()
    expect(parseSplitModes('')).toBeNull()
  })
  test('DeviceProbe.splitModes runs --help once per build, keeps a readable answer and retries a failure', async () => {
    let calls = 0
    let fail = true
    const probe = new DeviceProbe(async (_exe, args) => {
      calls++
      expect(args).toEqual(['--help'])
      if (fail) throw new Error('nope')
      return '--split-mode {none,layer,row}'
    })
    expect(await probe.splitModes('a')).toBeNull()
    fail = false
    expect(await probe.splitModes('a')).toEqual(['layer', 'row'])
    expect(await probe.splitModes('a')).toEqual(['layer', 'row'])
    expect(calls).toBe(2)
    probe.forget('a')
    await probe.splitModes('a')
    expect(calls).toBe(3)
  })
  test('the device view carries the modes (null = unknown)', () => {
    const cpu = { logicalCores: 4, sockets: 1, numaNodes: 1 }
    expect(describeDevices(null, two, cpu, [], ['layer']).splitModes).toEqual(['layer'])
    expect(describeDevices(null, two, cpu, []).splitModes).toBeNull()
  })
})

describe('split mode memory', () => {
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lw-split-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('confirm, fail, succeed; survives a restart; only numbers and labels are stored', () => {
    let now = 1000
    const a = new SplitStats(dir, () => now)
    const key = comboKey('cuda:b1', ['CUDA0', 'CUDA1'], 'tensor')
    expect(a.get(key)).toBeUndefined()
    a.confirm(key)
    now = 2000
    a.fail(key, 'crashed')
    const b = new SplitStats(dir, () => now)
    expect(b.get(key)).toEqual({ confirmedAt: 1000, failed: { at: 2000, kind: 'crashed' } })
    b.succeed(key)
    expect(new SplitStats(dir).get(key)).toEqual({ confirmedAt: 1000 })
    const text = readFileSync(join(dir, 'split-modes.json'), 'utf8')
    expect(JSON.parse(text).version).toBe(1)
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\//)
    // a failure alone is dropped again by a later success
    const k2 = comboKey('cuda:b1', ['CUDA1', 'CUDA0'], 'row')
    b.fail(k2, 'exited')
    b.succeed(k2)
    expect(b.get(k2)).toBeUndefined()
  })
  test('a broken file means nothing known; junk records are dropped on load', () => {
    writeFileSync(join(dir, 'split-modes.json'), '{ not json')
    const s = new SplitStats(dir)
    expect(s.get('x')).toBeUndefined()
    s.confirm('x')
    expect(new SplitStats(dir).get('x')?.confirmedAt).toBeGreaterThan(0)
    writeFileSync(join(dir, 'split-modes.json'), JSON.stringify({ version: 1, combos: { ok: { confirmedAt: 5 }, junk: 3, bad: { failed: { at: 1, kind: 'Bad Kind!' } } } }))
    const t = new SplitStats(dir)
    expect(t.get('ok')).toEqual({ confirmedAt: 5 })
    expect(t.get('junk')).toBeUndefined()
    expect(t.get('bad')).toBeUndefined()
  })
  test('comboWarnings: unsupported is an error, layer is never experimental, unknown capabilities block nothing', () => {
    const g = (splitMode: 'layer' | 'row' | 'tensor') => ({ devices: ['CUDA0', 'CUDA1'], splitMode, tensorSplit: null, mainGpu: null })
    expect(comboWarnings(null, undefined, ['layer'])).toEqual([])
    expect(comboWarnings(g('layer'), undefined, ['layer'])).toEqual([])
    expect(comboWarnings(g('row'), { confirmedAt: 1 }, null)).toEqual([])
    expect(comboWarnings(g('tensor'), { confirmedAt: 1 }, ['layer']).map(w => w.severity)).toEqual(['error'])
  })
})

describe('failure diagnosis', () => {
  const exited = (tail: string[] = []) => new LoadError('exited', 'Exited with code 3', 3, tail)
  test('a row / tensor load that died with no other explanation is named after the split mode', () => {
    const d = diagnose(new SplitModeLoadError(exited(['llama_init: something odd']), 'tensor'))!
    expect(d.kind).toBe('split-mode-failed')
    expect(d.exitCode).toBe(3)
    expect(d.tail).toEqual(['llama_init: something odd'])
  })
  test('memory, missing files and bad arguments keep their own explanation', () => {
    for (const [tail, kind] of [
      [['ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 1: cudaMalloc failed: out of memory'], 'oom'],
      [['failed to open GGUF file'], 'file-missing'],
      [['error while handling argument "--tensor-split": bad'], 'unknown-arg'],
    ] as const) expect(diagnose(new SplitModeLoadError(exited([...tail]), 'row'))!.kind).toBe(kind)
    expect(classify('timeout', null, [])).toBe('timeout')
    expect(diagnose(new SplitModeLoadError(new LoadError('timeout', 'slow', null, []), 'row'))!.kind).toBe('timeout')
  })
  test('which kinds are put on the failed list', () => {
    for (const k of ['exited', 'crashed', 'cuda-error', 'unknown']) expect(blamesSplitMode(k)).toBe(true)
    for (const k of ['oom', 'timeout', 'file-missing', 'unknown-arg', 'device-missing', 'port-in-use', 'aborted']) expect(blamesSplitMode(k)).toBe(false)
  })
})
