import { expect, test } from 'bun:test'
import { defaultSettings, defaultsFor, type ModelConfig } from '../../server/core/config'
import { bestCudaRunnable, cudaRunnable, SHIPPED_CUDA_MAJORS } from '../../server/core/cuda'
import { planLaunch, previewLaunch } from '../../server/core/launch'
import { finalParams } from '../../server/core/model-check'
import { detectPlatform, gpuChannelFor, parseStartupNvidia, platformInfo, selectRuntime, type RuntimeTarget } from '../../server/core/platform'
import { describeAcceleration } from '../../server/core/settings-admin'
import { detectSystem, systemWarnings } from '../../server/core/system'
import type { RuntimeEntry } from '../../server/core/runtimes'

test('shipped CUDA builds, runnability table and best-card selection', () => {
  expect(SHIPPED_CUDA_MAJORS).toEqual([12, 13])
  for (const computeCap of [3.5, 5.0, 7.0, 7.5, null]) {
    for (const driver of [470, 525, 580, null]) {
      expect(cudaRunnable({ computeCap, driver })).toBe(computeCap === null || driver === null ? null : computeCap >= 5 && driver >= 525)
    }
  }
  expect(cudaRunnable({ computeCap: 5, driver: '525.60.13' })).toBe(true)
  expect(cudaRunnable({ computeCap: NaN, driver: 580 })).toBeNull()
  expect(cudaRunnable({ computeCap: 3.5, driver: '[N/A]' })).toBeNull()
  expect(bestCudaRunnable([{ computeCap: 3.5, driver: 580 }, { computeCap: 5, driver: 525 }])).toBe(true)
  expect(bestCudaRunnable([{ computeCap: 3.5, driver: 580 }, { computeCap: null, driver: 580 }])).toBeNull()
  expect(bestCudaRunnable([{ computeCap: 3.5, driver: 580 }, { computeCap: 7.5, driver: 470 }])).toBe(false)
})

test('startup parses names with commas, missing compute_cap and multiple GPUs', () => {
  expect(parseStartupNvidia('NVIDIA RTX, A6000, 8.6, 580.88\n')).toEqual([{ name: 'NVIDIA RTX, A6000', computeCap: 8.6, driver: '580.88' }])
  expect(parseStartupNvidia('NVIDIA Example, 470.99\n', false)).toEqual([{ name: 'NVIDIA Example', computeCap: null, driver: '470.99' }])
  expect(parseStartupNvidia('NVIDIA Example, [N/A], 580.88')).toEqual([{ name: 'NVIDIA Example', computeCap: null, driver: '580.88' }])
  const old = detectPlatform('win32', 'x64', () => 'NVIDIA Example, 3.5, 580.88')
  expect(old).toMatchObject({ nvidiaProbe: 'found', acceleration: 'unknown', cudaRunnable: false })
  expect(gpuChannelFor(old, 'auto')).toBe('vulkan')
  expect(describeAcceleration('auto', old, selectRuntime(old, 'auto'))).toMatchObject({ choiceNeeded: true, reason: 'cuda-unusable', gpuChannel: 'vulkan' })
  expect(selectRuntime(old, 'cuda')).toMatchObject({ target: { acceleration: 'cuda', gpuChannel: 'cuda' } })
  expect(selectRuntime(old, 'cuda').selectionError).toBeUndefined()
  expect(detectPlatform('win32', 'x64', () => 'NVIDIA Old, 3.5, 580.88\nNVIDIA New, 7.5, 580.88')).toMatchObject({ acceleration: 'cuda', cudaRunnable: true })
  expect(detectPlatform('win32', 'x64', () => 'NVIDIA Old, 3.5, 580.88\nNVIDIA Unknown, [N/A], 580.88')).toMatchObject({ acceleration: 'cuda', cudaRunnable: null })
  const calls: boolean[] = []
  const legacy = detectPlatform('win32', 'x64', (withCc = true) => {
    calls.push(withCc)
    if (withCc) throw new Error('Field compute_cap is not supported')
    return 'NVIDIA Example, 470.99'
  })
  expect(calls).toEqual([true, false])
  expect(legacy).toMatchObject({ acceleration: 'cuda', nvidiaProbe: 'found', cudaRunnable: null })
})

test('startup selection, system recommendation and fatal warnings agree on shipped CUDA support', async () => {
  for (const [cc, driver] of [[3.5, '580.88'], [5, '470.99'], [7, '525.60'], [7.5, '580.88'], [null, '470.99'], [3.5, null]] as const) {
    const field = cc ?? '[N/A]'
    const drv = driver ?? '[N/A]'
    const host = detectPlatform('win32', 'x64', () => `NVIDIA Example, ${field}, ${drv}`)
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: async (cmd, args) => {
      if (cmd === 'powershell') return 'VID|AMD Radeon(TM) Graphics\nFEAT|1|1|0|1\nCPU|Example CPU|4|8'
      if (!args.length) return driver ? `CUDA Version: ${Number.parseFloat(driver) >= 580 ? '13.4' : Number.parseFloat(driver) >= 525 ? '12.4' : '11.4'}` : ''
      return `0, NVIDIA Example, ${drv}, ${field}, 4096`
    } })
    const runnable = cudaRunnable({ computeCap: cc, driver })
    expect(info.recommend?.acceleration).toBe(runnable === false ? 'cpu' : 'cuda')
    expect(host.acceleration).toBe(runnable === false ? 'unknown' : 'cuda')
    const warnings = systemWarnings(info, { cudaRuntime: '' }).map(w => w.code)
    expect(warnings.includes('compute-cap-unsupported')).toBe(runnable === false && cc !== null && cc < 5)
    expect(warnings.includes('driver-too-old')).toBe(runnable === false && driver !== null && Number.parseFloat(driver) < 525)
    if (runnable === false) {
      expect(warnings).not.toContain('driver-below-latest-cuda')
      expect(warnings).not.toContain('compute-cap-below-latest-cuda')
    }
  }
})

const target: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda', gpuChannel: 'cuda' }
const settings = () => {
  const s = defaultSettings(platformInfo('win32', 'x64', true))
  s.llamacpp.current = 'b1234'
  s.llamacpp.currentCpu = 'b1234'
  s.modelDirs = [{ id: 'd', path: 'X:\\models', enabled: true, maxDepth: 1 }]
  return s
}
const model = (runtime: string): ModelConfig => ({ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'model.gguf' }, mmproj: null, draft: null, activeProfile: 'p', runtime, profiles: { p: { overrides: {}, extraArgs: '' } } })
const entries: RuntimeEntry[] = (['vulkan', 'sycl', 'rocm'] as const).map(accel => ({ id: accel, label: accel, accel, tag: 'b1234', os: 'win32', arch: 'x64', addedAt: '', source: { kind: 'dir', from: 'X:\\build' } }))

function launch(accel: string, s = settings(), overrides = {}) {
  const m = model(accel === 'cuda' || accel === 'cpu' ? `${accel}:b1234` : `custom:${accel}`)
  m.profiles.p!.overrides = overrides
  const input = { dataDir: '/X', settings: s, target, runtimeEnv: { dataDir: '/X', target, entries, installed: () => ['b1234'], exists: () => true }, exists: () => true, host: '127.0.0.1' }
  const plan = planLaunch({ modelId: 'm', profile: 'p' }, { ...input, models: { version: 1, models: [m] } })
  const preview = previewLaunch({ ...input, model: m, form: { overrides, extraArgs: '', chatTemplate: null, runtime: null } })
  return { args: plan.args(s.scheduler.portRange[0]), preview: preview.args }
}

test('experimental builds omit inherited CUDA-only defaults in both launches and previews', () => {
  const s = settings()
  const before = structuredClone(s.defaults)
  for (const accel of ['vulkan', 'sycl', 'rocm']) {
    const effective = defaultsFor(s, target, accel)
    expect(effective).not.toBe(s.defaults)
    expect(effective).toEqual({ ...before, flashAttn: null, cacheTypeK: null, cacheTypeV: null })
    const { args, preview } = launch(accel, s)
    expect(preview).toEqual(args)
    for (const flag of ['--flash-attn', '--cache-type-k', '--cache-type-v']) expect(args).not.toContain(flag)
    expect(finalParams(args)).toMatchObject({ flashAttn: null, cacheTypeK: null, cacheTypeV: null })
  }
  expect(s.defaults).toEqual(before)
  expect(defaultsFor(s, target, 'cuda')).toBe(s.defaults)
  expect(defaultsFor(s, target, 'cpu')).toBe(s.defaultsCpu)
  expect(launch('cuda', s).args).toContain('--flash-attn')
  expect(launch('cuda', s).args).toContain('q4_0')
  expect(launch('cpu', s).args).not.toContain('--flash-attn')
})

test('changed global defaults and explicit profile overrides still win for non-CUDA backends', () => {
  const s = settings()
  s.defaults.flashAttn = 'off'
  s.defaults.cacheTypeK = 'q8_0'
  s.defaults.cacheTypeV = 'q8_0'
  for (const accel of ['vulkan', 'sycl', 'rocm']) {
    expect(finalParams(launch(accel, s).args)).toMatchObject({ flashAttn: 'off', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' })
    const overridden = launch(accel, settings(), { flashAttn: 'on', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' })
    expect(overridden.preview).toEqual(overridden.args)
    expect(finalParams(overridden.args)).toMatchObject({ flashAttn: 'on', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' })
  }
})
