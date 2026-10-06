// Save-time check: the parameter rules (each with a case that fires and one that does not), the three memory tiers at their
// boundaries, devices that do not exist, and the device pools a launch draws on. The facts are constructed, not read
// from a machine; the V-cache / flash-attention error was seen on a real llama-server b11146 (see model-check.ts).
import { expect, test } from 'bun:test'
import type { GgufArch, GgufLayout, GgufMeta } from '../../server/core/gguf'
import type { DeviceList } from '../../server/core/devices'
import { RISKY_FROM, systemReserveMiB, type ModelFacts } from '../../server/core/memory-estimate'
import { checkLaunch, deviceInputs, finalParams, type CheckInput } from '../../server/core/model-check'

const MiB = 1024 * 1024
const noArch: GgufArch = {
  blockCount: null, embeddingLength: null, feedForwardLength: null, headCount: null, headCountKv: null, keyLength: null,
  valueLength: null, slidingWindow: null, slidingWindowPattern: null, fullAttentionInterval: null, ssm: null, expertCount: null, vocabSize: null,
}
function facts(train = 8192): ModelFacts {
  const a: GgufArch = { ...noArch, blockCount: 30, embeddingLength: 576, feedForwardLength: 1536, headCount: 9, headCountKv: 3, vocabSize: 49152 }
  const layers = Array.from({ length: 30 }, () => 100 * MiB)
  const layout: GgufLayout = { layerBytes: layers, embedBytes: 50 * MiB, outputBytes: 0, tiedOutput: true, otherBytes: 0, tensorBytes: 3050 * MiB }
  return { meta: { version: 3, fileSize: layout.tensorBytes, architecture: 'llama', contextLength: train, arch: a } as GgufMeta, layout, totalBytes: layout.tensorBytes }
}
const sys = { totalMiB: 65536, availableMiB: 60000 }
const gpu = (id: string, totalMiB: number, freeMiB: number) => ({ id, name: `card ${id}`, totalMiB, freeMiB })
const list = (...gpus: ReturnType<typeof gpu>[]): DeviceList => ({ source: 'list-devices', gpus })

const base = (over: Partial<CheckInput> = {}): CheckInput => ({
  args: ['--ctx-size', '4096', '--flash-attn', 'on'], device: 'CUDA0', os: 'win32', model: facts(), system: sys, list: list(gpu('CUDA0', 24000, 22000)), ...over,
})
const codes = (c: ReturnType<typeof checkLaunch>) => c.issues.map(i => i.code)

// ---- reading the final arguments -----------------------------------------------------------------------------------

test('finalParams: aliases, the last occurrence wins, --flag=value, load modes, kv offload, rope scaling', () => {
  const p = finalParams(['-c', '4096', '--ctx-size=8192', '-ctk', 'q8_0', '-ctv', 'q4_0', '-fa', '-ngl', '99', '-b', '256', '-ub', '128', '-np', '2',
    '--load-mode', 'mlock', '-nkvo', '--swa-full', '--rope-scale', '4', '-ts', '3,1'])
  expect(p).toMatchObject({ ctx: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', flashAttn: 'on', gpuLayers: 99, batch: 256, ubatch: 128, parallel: 2, mlock: true, kvOnHost: true, swaFull: true, ropeScaling: true, tensorSplit: '3,1' })
  expect(finalParams(['-nkvo', '-kvo']).kvOnHost).toBe(false)
  expect(finalParams(['--load-mode', 'mmap+mlock']).mlock).toBe(true)
  expect(finalParams(['--load-mode', 'auto']).mlock).toBe(false)
  expect(finalParams(['--rope-scaling', 'none']).ropeScaling).toBe(false)
  expect(finalParams(['-ngl', 'all']).gpuLayers).toBeNull()
  expect(finalParams([])).toMatchObject({ ctx: null, flashAttn: null, mlock: false, parallel: null })
})

// ---- parameter rules: each one fires and does not fire ------------------------------------------------------------

test('v-cache-needs-fa: a quantised V cache without flash attention is an error (blocks the save); on / auto / f16 are fine', () => {
  const bad = checkLaunch(base({ args: ['-ctv', 'q8_0', '-fa', 'off'] }))
  expect(codes(bad)).toContain('v-cache-needs-fa')
  expect(bad.blocked).toBe(true)
  expect(bad.issues.find(i => i.code === 'v-cache-needs-fa')!.severity).toBe('error')
  expect(checkLaunch(base({ args: ['-ctv', 'q8_0', '-fa', '0'] })).blocked).toBe(true)
  for (const args of [['-ctv', 'q8_0', '-fa', 'on'], ['-ctv', 'q8_0', '-fa', 'auto'], ['-ctv', 'q8_0'], ['-ctv', 'f16', '-fa', 'off'], ['-ctk', 'q8_0', '-fa', 'off']]) {
    const c = checkLaunch(base({ args }))
    expect(codes(c)).not.toContain('v-cache-needs-fa')
    expect(c.blocked).toBe(false)
  }
})

test('device-missing: only the build\'s own list decides, and only for a device the launch names', () => {
  const gone = checkLaunch(base({ device: 'CUDA1' }))
  expect(codes(gone)).toContain('device-missing')
  expect(gone.blocked).toBe(true)
  expect(checkLaunch(base({ device: 'CUDA0,CUDA3' })).issues.filter(i => i.code === 'device-missing').map(i => i.detail!.device)).toEqual(['CUDA3'])
  expect(codes(checkLaunch(base({ device: 'CUDA0' })))).not.toContain('device-missing')
  expect(codes(checkLaunch(base({ device: 'auto' })))).not.toContain('device-missing')
  expect(codes(checkLaunch(base({ device: 'cpu' })))).not.toContain('device-missing')
  // a list that could not be read (or came from nvidia-smi) never rejects
  expect(codes(checkLaunch(base({ device: 'CUDA1', list: { source: 'unavailable', gpus: [] } })))).not.toContain('device-missing')
  expect(codes(checkLaunch(base({ device: 'CUDA1', list: null })))).not.toContain('device-missing')
})

test('split-mode-unsupported comes from the launch warnings and blocks; a plain warning does not', () => {
  const bad = checkLaunch(base({ warnings: [{ code: 'split-mode-unsupported', severity: 'error', detail: 'tensor' }] }))
  expect(bad.blocked).toBe(true)
  expect(bad.issues[0]).toMatchObject({ code: 'split-mode-unsupported', detail: { mode: 'tensor' } })
  expect(checkLaunch(base({ warnings: [{ code: 'split-mode-unconfirmed', severity: 'warning' }] })).blocked).toBe(false)
})

test('ctx-over-train: above the training length without rope scaling; at the limit, with scaling, or "model\'s own" does not', () => {
  const over = checkLaunch(base({ args: ['-c', '16384'] }))
  expect(over.issues.find(i => i.code === 'ctx-over-train')).toMatchObject({ severity: 'warning', detail: { ctx: 16384, train: 8192 } })
  expect(over.blocked).toBe(false) // it starts (llama-server caps the slot context): never an error
  expect(codes(checkLaunch(base({ args: ['-c', '8192'] })))).not.toContain('ctx-over-train')
  expect(codes(checkLaunch(base({ args: ['-c', '16384', '--rope-scale', '2'] })))).not.toContain('ctx-over-train')
  expect(codes(checkLaunch(base({ args: ['-c', '16384', '--rope-scaling', 'yarn', '--yarn-orig-ctx', '8192'] })))).not.toContain('ctx-over-train')
  expect(codes(checkLaunch(base({ args: ['-c', '0'] })))).not.toContain('ctx-over-train')
  expect(codes(checkLaunch(base({ args: [] })))).not.toContain('ctx-over-train')
})

test('ubatch-over-batch', () => {
  expect(checkLaunch(base({ args: ['-b', '256', '-ub', '512'] })).issues.find(i => i.code === 'ubatch-over-batch')).toMatchObject({ severity: 'warning', detail: { ubatch: 512, batch: 256 } })
  expect(codes(checkLaunch(base({ args: ['-b', '512', '-ub', '512'] })))).not.toContain('ubatch-over-batch')
  expect(codes(checkLaunch(base({ args: ['-ub', '1024'] })))).not.toContain('ubatch-over-batch')
})

test('cpu-gpu-layers: a CPU device with layers asked for; zero layers, a GPU device and an extra-args override do not', () => {
  const cpuArgs = ['-ngl', '0'] // what the builder passes for a CPU device
  expect(checkLaunch(base({ device: 'cpu', args: cpuArgs, requestedGpuLayers: 999 })).issues.find(i => i.code === 'cpu-gpu-layers')).toMatchObject({ detail: { layers: 999 } })
  expect(codes(checkLaunch(base({ device: 'cpu', args: cpuArgs, requestedGpuLayers: 0 })))).not.toContain('cpu-gpu-layers')
  expect(codes(checkLaunch(base({ device: 'CUDA0', args: ['-ngl', '999'], requestedGpuLayers: 999 })))).not.toContain('cpu-gpu-layers')
  // the extra arguments set -ngl themselves: that value is the one that is passed
  const extra = [{ code: 'extra-overrides-form' as const, severity: 'warning' as const, flag: '--n-gpu-layers' }]
  expect(codes(checkLaunch(base({ device: 'cpu', args: ['-ngl', '0'], requestedGpuLayers: 999, warnings: extra })))).not.toContain('cpu-gpu-layers')
  expect(codes(checkLaunch(base({ device: 'cpu', args: ['-ngl', '20'], requestedGpuLayers: 999, warnings: extra })))).toContain('cpu-gpu-layers')
  // a CPU-only build counts like a CPU device
  expect(codes(checkLaunch(base({ device: 'auto', cpuBuild: true, args: ['-ngl', '0'], requestedGpuLayers: 99 })))).toContain('cpu-gpu-layers')
})

test('mmproj-on-cpu: a vision projector with a CPU device; without mmproj or on a GPU it does not fire', () => {
  expect(codes(checkLaunch(base({ device: 'cpu', hasMmproj: true })))).toContain('mmproj-on-cpu')
  expect(codes(checkLaunch(base({ device: 'cpu', hasMmproj: false })))).not.toContain('mmproj-on-cpu')
  expect(codes(checkLaunch(base({ device: 'CUDA0', hasMmproj: true })))).not.toContain('mmproj-on-cpu')
})

test('mlock-exceeds-memory: the locked weights against the memory that is available now', () => {
  const args = ['-c', '4096', '--load-mode', 'mlock', '-ngl', '0']
  const tight = checkLaunch(base({ device: 'cpu', args, system: { totalMiB: 65536, availableMiB: 2000 } }))
  expect(tight.issues.find(i => i.code === 'mlock-exceeds-memory')).toMatchObject({ severity: 'warning', detail: { availableMiB: 2000 } })
  expect(tight.estimate!.mlockMiB).toBeGreaterThan(2000)
  expect(codes(checkLaunch(base({ device: 'cpu', args, system: sys })))).not.toContain('mlock-exceeds-memory')
  expect(codes(checkLaunch(base({ device: 'cpu', args: ['-c', '4096', '-ngl', '0'], system: { totalMiB: 65536, availableMiB: 2000 } })))).not.toContain('mlock-exceeds-memory')
  // unknown available memory: no claim either way
  expect(codes(checkLaunch(base({ device: 'cpu', args, system: { totalMiB: 65536, availableMiB: null } })))).not.toContain('mlock-exceeds-memory')
})

test('slot-ctx-small: an explicit slot count that leaves under 1024 tokens per slot; one slot, automatic and roomy slots do not', () => {
  expect(checkLaunch(base({ args: ['-c', '4096', '-np', '8'] })).issues.find(i => i.code === 'slot-ctx-small')).toMatchObject({ detail: { parallel: 8, perSlot: 512 } })
  expect(codes(checkLaunch(base({ args: ['-c', '4096', '-np', '4'] })))).not.toContain('slot-ctx-small')
  expect(codes(checkLaunch(base({ args: ['-c', '512', '-np', '1'] })))).not.toContain('slot-ctx-small')
  expect(codes(checkLaunch(base({ args: ['-c', '4096'] })))).not.toContain('slot-ctx-small')
  // the model's own context counts when none is given
  expect(codes(checkLaunch(base({ args: ['-np', '16'] })))).toContain('slot-ctx-small')
})

test('file-missing and no-estimate are warnings; an unreadable model gives no estimate and an unknown tier', () => {
  const c = checkLaunch(base({ model: null, missing: ['model'] }))
  expect(codes(c)).toEqual(['file-missing', 'no-estimate'])
  expect(c.estimate).toBeNull()
  expect(c.tier).toBe('unknown')
  expect(c.blocked).toBe(false)
})

test('a configuration that triggers no rule has no issues (an old config without device / runtime fields included)', () => {
  const c = checkLaunch(base({ device: 'auto', list: null, args: [] }))
  expect(c.issues).toEqual([])
  expect(c.blocked).toBe(false)
})

// ---- memory tiers ------------------------------------------------------------------------------------------------

test('tier boundaries: up to 85% of the free memory is ok, up to 100% risky, above that nofit', () => {
  const args = ['-c', '4096', '-fa', 'on', '-np', '1']
  const big = checkLaunch(base({ args, list: list(gpu('CUDA0', 24000, 1_000_000)) }))
  const pool = big.estimate!.pools.find(p => p.kind === 'separate')!
  const T = pool.totalMiB
  expect(RISKY_FROM).toBe(0.85)
  const tierAt = (free: number) => checkLaunch(base({ args, list: list(gpu('CUDA0', 24000, free)) })).tier
  expect(big.tier).toBe('ok')
  expect(tierAt(Math.ceil(T / 0.85))).toBe('ok')
  expect(tierAt(Math.floor(T / 0.85) - 1)).toBe('risky')
  expect(tierAt(Math.ceil(T))).toBe('risky')
  expect(tierAt(Math.floor(T) - 1)).toBe('nofit')
  // a full card is nofit, never an error: the save is not refused for memory
  const full = checkLaunch(base({ args, list: list(gpu('CUDA0', 24000, 100)) }))
  expect(full.tier).toBe('nofit')
  expect(full.blocked).toBe(false)
})

test('the system memory is a pool of its own: a CPU launch is judged against what the system can still give (minus the reserve)', () => {
  const args = ['-c', '4096', '-ngl', '0']
  const cpu = (availableMiB: number | null) => checkLaunch(base({ device: 'cpu', args, system: { totalMiB: 16384, availableMiB } }))
  expect(cpu(12000).tier).toBe('ok')
  expect(cpu(3500).tier).toBe('nofit') // 3500 - reserve of 2458 leaves 1042 MiB, the weights alone are 3 GiB
  expect(cpu(null).tier).toBe('unknown') // cannot be read: never "fits"
  expect(cpu(12000).estimate!.pools.map(p => p.kind)).toEqual(['host'])
})

// ---- device pools ---------------------------------------------------------------------------------------------------

test('a Mac is one shared pool with no device wording; its budget is the working-set cap and the free system memory', () => {
  const mac = list(gpu('MTL0', 12124, 12123))
  const c = checkLaunch(base({ os: 'darwin', device: 'auto', list: mac, system: { totalMiB: 16384, availableMiB: 9000 }, args: ['-c', '4096'] }))
  expect(c.estimate!.pools.map(p => p.kind)).toEqual(['shared'])
  expect(c.estimate!.pools[0]!.budgetMiB).toBeCloseTo(9000 - systemReserveMiB(16384), 5)
  expect(JSON.stringify(c.estimate).toLowerCase()).not.toMatch(/gpu|vram|cuda/)
  // no runtime installed yet: the pool still exists, its budget comes from the system memory
  expect(checkLaunch(base({ os: 'darwin', device: 'auto', list: null, args: ['-c', '4096'] })).estimate!.pools[0]!.kind).toBe('shared')
})

test('deviceInputs: auto settles on the biggest card, a group shares by --tensor-split or by free memory, cpu has no card', () => {
  const l = list(gpu('CUDA0', 8000, 7000), gpu('CUDA1', 24000, 21000))
  expect(deviceInputs({ os: 'win32', device: 'auto', list: l }).map(d => d.id)).toEqual(['CUDA1'])
  expect(deviceInputs({ os: 'win32', device: 'cpu', list: l })).toEqual([])
  expect(deviceInputs({ os: 'win32', device: 'CUDA0', cpuBuild: true, list: l })).toEqual([])
  const group = deviceInputs({ os: 'win32', device: 'CUDA0,CUDA1', list: l })
  expect(group.map(d => d.share)).toEqual([7000, 21000]) // raw: the estimate repeats llama.cpp's float32 accumulation
  expect(deviceInputs({ os: 'win32', device: 'CUDA0,CUDA1', list: l, tensorSplit: '1,1' }).map(d => d.share)).toEqual([1, 1])
  expect(deviceInputs({ os: 'win32', device: 'CUDA0,CUDA1', list: l, tensorSplit: '1,2,3' }).map(d => d.share)).toEqual([7000, 21000]) // wrong count: ignored
  // no list at all: one card of unknown memory (never a CPU run), or the nvidia-smi cards
  expect(deviceInputs({ os: 'win32', device: 'auto', list: null })).toEqual([expect.objectContaining({ id: 'auto', freeMiB: null, share: 1 })])
  expect(deviceInputs({ os: 'win32', device: 'auto', list: null, fallbackGpus: [gpu('CUDA0', 8000, 6000)] })[0]).toMatchObject({ id: 'CUDA0', freeMiB: 6000 })
})

test('several cards: the layers split over the cards by their share and every card is its own pool', () => {
  const l = list(gpu('CUDA0', 24000, 22000), gpu('CUDA1', 24000, 22000))
  const c = checkLaunch(base({ device: 'CUDA0,CUDA1', list: l, args: ['-c', '4096', '-ts', '1,1'] }))
  expect(c.estimate!.pools.filter(p => p.kind === 'separate').map(p => p.id)).toEqual(['CUDA0', 'CUDA1'])
  expect(c.estimate!.notes).toContain('unverified-multi-device')
})

test('two profiles of one model are calculated separately: a bigger context is a bigger estimate', () => {
  const a = checkLaunch(base({ args: ['-c', '4096', '-fa', 'on'] }))
  const b = checkLaunch(base({ args: ['-c', '8192', '-ctk', 'q8_0', '-fa', 'on'] }))
  expect(a.estimate!.total.kvMiB).not.toBe(b.estimate!.total.kvMiB)
  expect(a.estimate!.total.weightsMiB).toBe(b.estimate!.total.weightsMiB)
})

test('the draft model follows the main model\'s context unless told otherwise', () => {
  const without = checkLaunch(base({ args: ['-c', '4096'] }))
  const withDraft = checkLaunch(base({ args: ['-c', '4096'], draft: { facts: facts() } }))
  expect(withDraft.estimate!.total.draftMiB).toBeGreaterThan(0)
  expect(withDraft.estimate!.total.totalMiB).toBeGreaterThan(without.estimate!.total.totalMiB)
})

test('--no-mmproj-offload reaches the estimate: the projector counts on the host, the last of the two flags wins (CR-011)', async () => {
  const { finalParams, toEstimateParams } = await import('../../server/core/model-check')
  expect(finalParams(['--no-mmproj-offload']).mmprojOnHost).toBe(true)
  expect(finalParams(['--no-mmproj-offload', '--mmproj-offload']).mmprojOnHost).toBe(false)
  expect(finalParams([]).mmprojOnHost).toBe(false)
  expect(toEstimateParams(finalParams(['--no-mmproj-offload'])).mmprojOnHost).toBe(true)
})

test('row / tensor split over several cards is not judged: the cards are unknown (or nofit by the layer formula), layer is judged', () => {
  const l = list(gpu('CUDA0', 24000, 22000), gpu('CUDA1', 24000, 22000))
  const run = (mode: string) => checkLaunch(base({ device: 'CUDA0,CUDA1', list: l, args: ['-c', '4096', '-ts', '1,1', '-sm', mode] }))
  expect(run('layer').estimate!.pools.find(p => p.id === 'CUDA0')!.tier).toBe('ok')
  for (const mode of ['row', 'tensor']) {
    const c = run(mode)
    expect(c.estimate!.pools.filter(p => p.kind === 'separate').map(p => p.tier)).toEqual(['unknown', 'unknown'])
    expect(c.estimate!.notes).toContain('split-mode-unmodelled')
    expect(c.tier).toBe('unknown')
  }
})
