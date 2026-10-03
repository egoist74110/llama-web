import { describe, expect, test } from 'bun:test'
import { cudaIncompatibility, maxMajorForDriver, pickCuda } from '../../server/core/cuda'
import {
  cudaLimitsOf, describeSystem, detectSystem, memoryFit, otherGraphicsVendors, parseCudaBanner, parseMac, parseNvidiaGpus, parseWinProbe,
  runCmd, systemWarnings, type RunCmd,
} from '../../server/core/system'

// The numbers come from the NVIDIA CUDA Toolkit Release Notes (minor version compatibility: 13.x >= 580,
// 12.x >= 525, 11.x >= 450; CUDA 13.0 dropped Maxwell / Pascal / Volta).
describe('CUDA compatibility table', () => {
  test('driver number -> highest CUDA major', () => {
    expect(maxMajorForDriver('617.14')).toBe(13)
    expect(maxMajorForDriver('580.00')).toBe(13)
    expect(maxMajorForDriver('579.99')).toBe(12)
    expect(maxMajorForDriver('525.60')).toBe(12)
    expect(maxMajorForDriver('524.99')).toBe(11)
    expect(maxMajorForDriver('449')).toBeNull()
    expect(maxMajorForDriver('abc')).toBeNull()
    expect(maxMajorForDriver(null)).toBeNull()
  })

  test('a runtime is refused when the driver or the compute capability is too low', () => {
    expect(cudaIncompatibility('13.3', { maxMajor: 12, maxComputeCap: 8.9 })).toBe('driver-too-old')
    expect(cudaIncompatibility('12.4', { maxMajor: 12, maxComputeCap: 8.9 })).toBeNull()
    expect(cudaIncompatibility('13.1', { maxMajor: 13, maxComputeCap: 7.0 })).toBe('compute-cap-too-low') // Volta
    expect(cudaIncompatibility('13.1', { maxMajor: 13, maxComputeCap: 7.5 })).toBeNull() // Turing
    expect(cudaIncompatibility('12.4', { maxMajor: 13, maxComputeCap: 6.1 })).toBeNull() // Pascal still runs 12.x
    expect(cudaIncompatibility('13.1', null)).toBeNull() // unknown hardware: nothing is claimed
    expect(cudaIncompatibility('13.1', { maxMajor: null, maxComputeCap: null })).toBeNull()
  })

  test('automatic choice: the newest runtime the machine can run', () => {
    const rel = ['12.4', '13.1', '13.3']
    expect(pickCuda(rel, { maxMajor: 13, maxComputeCap: 12 })).toBe('13.3')
    expect(pickCuda(rel, { maxMajor: 12, maxComputeCap: 8.9 })).toBe('12.4')
    expect(pickCuda(rel, { maxMajor: 13, maxComputeCap: 6.1 })).toBe('12.4')
    expect(pickCuda(['13.10', '13.9'], { maxMajor: 13, maxComputeCap: 9 })).toBe('13.10') // numeric, not text order
    // Unknown hardware: the most widely supported major, never a guess upwards.
    expect(pickCuda(rel, null)).toBe('12.4')
    expect(pickCuda(rel, { maxMajor: null, maxComputeCap: null })).toBe('12.4')
  })

  test('no usable runtime: an explicit error with the reasons, never a silent downgrade', () => {
    expect(() => pickCuda(['13.1'], { maxMajor: 12, maxComputeCap: 8 })).toThrow(/No CUDA build/)
    try { pickCuda(['13.1'], { maxMajor: 12, maxComputeCap: 8 }) } catch (e) {
      expect(e).toMatchObject({ code: 'no-compatible-cuda', detail: '13.1: driver-too-old' })
    }
    expect(() => pickCuda([], null)).toThrow(/no CUDA build/)
  })
})

describe('parsers', () => {
  test('nvidia-smi query with and without compute_cap, names with commas', () => {
    const a = parseNvidiaGpus('0, NVIDIA GeForce RTX 5090, 617.14, 12.0, 32607\n1, NVIDIA RTX, A6000, 617.14, 8.6, 49140\n', true)
    expect(a.driver).toBe('617.14')
    expect(a.gpus).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 5090', memoryMiB: 32607, computeCap: 12 },
      { index: 1, name: 'NVIDIA RTX, A6000', memoryMiB: 49140, computeCap: 8.6 },
    ])
    expect(parseNvidiaGpus('0, GeForce GTX 750, 470.99, 2048\n', false).gpus).toEqual([{ index: 0, name: 'GeForce GTX 750', memoryMiB: 2048, computeCap: null }])
    expect(parseNvidiaGpus('garbage\n\nNo devices were found\n', true)).toEqual({ gpus: [], driver: null })
    expect(parseNvidiaGpus('0, X, 1.0, [N/A], [N/A]', true).gpus[0]).toMatchObject({ computeCap: null, memoryMiB: null })
  })

  test('the CUDA version in the nvidia-smi banner (old and new wording)', () => {
    expect(parseCudaBanner('| NVIDIA-SMI 551.61  Driver Version: 551.61  CUDA Version: 12.4 |')).toBe('12.4')
    expect(parseCudaBanner('| NVIDIA-SMI 617.14  KMD Version: 617.14  CUDA UMD Version: 13.4 |')).toBe('13.4')
    expect(parseCudaBanner('nothing')).toBeNull()
  })

  test('Windows probe: processors, features, NUMA, video controllers', () => {
    const p = parseWinProbe('FEAT|1|1|0|2\r\nCPU|Intel(R) Xeon(R)   Gold 6248|20|40\r\nCPU|Intel(R) Xeon(R)   Gold 6248|20|40\r\nVID|Intel(R) UHD Graphics\r\nVID|Parsec Virtual Display Adapter\r\nnoise\r\n')
    expect(p.features).toEqual({ avx: true, avx2: true, avx512: false })
    expect(p.numaNodes).toBe(2)
    expect(p.processors).toEqual([{ name: 'Intel(R) Xeon(R) Gold 6248', cores: 20, logical: 40 }, { name: 'Intel(R) Xeon(R) Gold 6248', cores: 20, logical: 40 }])
    expect(p.video).toEqual(['Intel(R) UHD Graphics', 'Parsec Virtual Display Adapter'])
    expect(parseWinProbe('')).toEqual({ processors: [], features: null, numaNodes: null, video: [] })
  })

  test('AMD / Intel graphics are recognised, NVIDIA and virtual adapters are not', () => {
    expect(otherGraphicsVendors(['AMD Radeon(TM) Graphics', 'Intel(R) Arc(TM) A770', 'NVIDIA GeForce RTX 5090', 'Parsec Virtual Display Adapter', 'Honor Virtual Display Device'])).toEqual(['AMD', 'Intel'])
    expect(otherGraphicsVendors([])).toEqual([])
  })
})

const NO_CPU = { osCpu: () => ({ model: 'Test CPU', logical: 8 }), osMemory: () => ({ totalMiB: 32768, freeMiB: 20000 }) }
const BANNER = '| NVIDIA-SMI 617.14  KMD Version: 617.14  CUDA UMD Version: 13.4 |'
const PROBE = 'FEAT|1|1|1|1\nCPU|AMD Ryzen 9 9900X 12-Core Processor|12|24\nVID|NVIDIA GeForce RTX 5090\nVID|AMD Radeon(TM) Graphics\n'

/** Fake commands; `smi` answers the nvidia-smi calls, `ps` the PowerShell probe. */
function fake(o: { smi?: 'ok' | 'missing' | 'hang' | 'old-no-cc' | 'none', ps?: string, cc?: string, driver?: string } = {}): { run: RunCmd, calls: string[][] } {
  const calls: string[][] = []
  const run: RunCmd = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'nvidia-smi') {
      const smi = o.smi ?? 'ok'
      if (smi === 'missing') throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })
      if (smi === 'hang') throw new Error('timed out')
      if (smi === 'none') return ''
      if (args.length === 0) return BANNER
      const withCc = args[0]!.includes('compute_cap')
      if (smi === 'old-no-cc' && withCc) throw new Error('Field "compute_cap" is not a valid field')
      const driver = o.driver ?? '617.14'
      return withCc ? `0, NVIDIA GeForce RTX 5090, ${driver}, ${o.cc ?? '12.0'}, 32607\n` : `0, NVIDIA GeForce RTX 5090, ${driver}, 32607\n`
    }
    if (cmd === 'powershell') {
      if (o.ps === 'fail') throw new Error('powershell failed')
      return o.ps ?? PROBE
    }
    throw new Error(`unexpected ${cmd}`)
  }
  return { run, calls }
}

describe('detectSystem on Windows', () => {
  test('NVIDIA machine: driver, banner CUDA, compute capability, CPU facts; cuda recommended', async () => {
    const f = fake()
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: f.run, ...NO_CPU })
    expect(info.nvidia).toMatchObject({ state: 'ok', driver: '617.14', maxCuda: '13.4', gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5090', memoryMiB: 32607, computeCap: 12 }], otherVendors: [] })
    expect(info.cudaLimits).toEqual({ maxMajor: 13, maxComputeCap: 12 })
    expect(info.recommend).toEqual({ acceleration: 'cuda' })
    expect(info.cpu).toMatchObject({ model: 'AMD Ryzen 9 9900X 12-Core Processor', physicalCores: 12, logicalCores: 24, sockets: 1, numaNodes: 1 })
    expect(info.cpu.features).toEqual({ avx: true, avx2: true, avx512: true, fma: null, f16c: null, neon: null })
    expect(info.mac).toBeUndefined()
    // Detection is read-only: only nvidia-smi queries and the PowerShell probe, never llama-server.
    expect(new Set(f.calls.map(c => c[0]))).toEqual(new Set(['nvidia-smi', 'powershell']))
  })

  test('an old driver without compute_cap is asked again without it (compute capability unknown, not guessed)', async () => {
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: fake({ smi: 'old-no-cc', driver: '537.13' }).run, ...NO_CPU })
    expect(info.nvidia!.gpus[0]).toMatchObject({ computeCap: null, memoryMiB: 32607 })
    expect(info.cudaLimits).toEqual({ maxMajor: 13, maxComputeCap: null }) // the banner still says 13.4
  })

  test('no nvidia-smi: none, with other vendors named; no limits; cpu recommended', async () => {
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: fake({ smi: 'missing' }).run, ...NO_CPU })
    expect(info.nvidia).toMatchObject({ state: 'none', gpus: [], otherVendors: ['AMD'] })
    expect(info.cudaLimits).toBeUndefined()
    expect(info.recommend).toEqual({ acceleration: 'cpu' })
    expect(systemWarnings(info, { cudaRuntime: '' }).map(w => w.code)).toEqual(['no-nvidia', 'other-gpu-vendor'])
  })

  test('nvidia-smi present but failing / timing out: unknown, no limits, nothing thrown', async () => {
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: fake({ smi: 'hang' }).run, ...NO_CPU })
    expect(info.nvidia).toMatchObject({ state: 'unknown', gpus: [] })
    expect(info.cudaLimits).toBeUndefined()
    expect(systemWarnings(info, { cudaRuntime: '' }).map(w => w.code)).toEqual(['nvidia-unknown'])
  })

  test('nvidia-smi answering with no devices: none', async () => {
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: fake({ smi: 'none' }).run, ...NO_CPU })
    expect(info.nvidia!.state).toBe('none')
  })

  test('PowerShell failing: CPU falls back to what Node knows, features stay unknown', async () => {
    const info = await detectSystem({ os: 'win32', arch: 'x64', run: fake({ ps: 'fail' }).run, ...NO_CPU })
    expect(info.cpu).toEqual({ model: 'Test CPU', physicalCores: null, logicalCores: 8, sockets: null, numaNodes: null, features: { avx: null, avx2: null, avx512: null, fma: null, f16c: null, neon: null } })
    expect(systemWarnings(info, { cudaRuntime: '' }).some(w => w.code === 'no-avx2')).toBe(false) // unknown is not "missing"
  })

  test('commands get a timeout', async () => {
    const seen: number[] = []
    const run: RunCmd = async (_c, _a, t) => { seen.push(t); throw new Error('x') }
    await detectSystem({ os: 'win32', arch: 'x64', run, timeoutMs: 1234, ...NO_CPU })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(t => t >= 1234)).toBe(true)
  })

  test('a real timeout ends the command (runCmd)', async () => {
    const t0 = Date.now()
    await expect(runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 300)).rejects.toBeDefined()
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})

describe('warnings (decision 37)', () => {
  const base = async (over: Parameters<typeof fake>[0]) => detectSystem({ os: 'win32', arch: 'x64', run: fake(over).run, ...NO_CPU })
  const codes = (info: Awaited<ReturnType<typeof base>>, cudaRuntime = '') => systemWarnings(info, { cudaRuntime }).map(w => w.code)

  test('a healthy machine has none', async () => {
    expect(codes(await base({}))).toEqual([])
  })

  test('driver below the newest CUDA major: info, with the numbers', async () => {
    const info = await base({ driver: '551.61' })
    // The fake banner says 13.4; the driver table decides only without a banner.
    expect(cudaLimitsOf({ ...info.nvidia!, maxCuda: null })).toEqual({ maxMajor: 12, maxComputeCap: 12 })
    const w = systemWarnings({ ...info, cudaLimits: { maxMajor: 12, maxComputeCap: 8.9 } }, { cudaRuntime: '' })
    expect(w).toEqual([{ code: 'driver-below-latest-cuda', severity: 'info', params: { driver: '551.61', maxMajor: 12, latestMajor: 13, minDriver: 580 } }])
  })

  test('driver too old for any runtime, compute capability too low', async () => {
    const info = await base({ driver: '400.1', cc: '3.0' })
    const nv = { ...info.nvidia!, maxCuda: null }
    const tooOld = { ...info, nvidia: nv, cudaLimits: cudaLimitsOf(nv)! }
    expect(tooOld.cudaLimits.maxMajor).toBeNull()
    expect(codes(tooOld)).toEqual(['driver-too-old', 'compute-cap-unsupported'])
    const volta = { ...info, cudaLimits: { maxMajor: 13, maxComputeCap: 7.0 } }
    expect(codes(volta)).toEqual(['compute-cap-below-latest-cuda'])
  })

  test('a hand-set CUDA runtime that cannot run is called out; automatic and fitting ones are not', async () => {
    const info = { ...await base({}), cudaLimits: { maxMajor: 12, maxComputeCap: 8.9 } }
    expect(systemWarnings(info, { cudaRuntime: '13.3' }).find(w => w.code === 'cuda-override-unsupported')).toEqual({ code: 'cuda-override-unsupported', severity: 'warning', params: { version: '13.3', reason: 'driver-too-old' } })
    expect(codes(info, '12.4')).not.toContain('cuda-override-unsupported')
    expect(codes(info, '')).not.toContain('cuda-override-unsupported')
  })

  test('CPU: no AVX2 and more than 64 logical cores', async () => {
    const info = await base({ ps: 'FEAT|1|0|0|1\nCPU|Old CPU|4|4\nVID|NVIDIA GeForce RTX 5090\n' })
    expect(codes(info)).toEqual(['no-avx2'])
    const big = await base({ ps: 'FEAT|1|1|0|4\nCPU|Big|32|64\nCPU|Big|32|64\n' })
    expect(systemWarnings(big, { cudaRuntime: '' }).find(w => w.code === 'many-logical-cores')?.params).toEqual({ logical: 128 })
    expect(big.cpu).toMatchObject({ sockets: 2, numaNodes: 4, physicalCores: 64, logicalCores: 128 })
  })
})

describe('memory checks', () => {
  const GiB = 1024 ** 3
  test('share of memory and free memory', () => {
    expect(memoryFit({ totalMiB: 32768, freeMiB: 20000 }, 10 * GiB)).toBeNull()
    expect(memoryFit({ totalMiB: 32768, freeMiB: 30000 }, 24 * GiB, 4 * GiB)).toEqual({ code: 'memory-tight', severity: 'warning', params: { share: 88 } })
    expect(memoryFit({ totalMiB: 32768, freeMiB: 6000 }, 10 * GiB)).toEqual({ code: 'memory-below-model', severity: 'warning', params: { share: 31 } })
    expect(memoryFit({ totalMiB: 32768, freeMiB: 6000 }, 10 * GiB, 0, true)).toBeNull() // unified memory: only the share counts
    expect(memoryFit({ totalMiB: 0, freeMiB: 0 }, 10 * GiB)).toBeNull()
  })
})

describe('Mac (decision 38)', () => {
  const sysctl: Record<string, string> = {
    'machdep.cpu.brand_string': 'Apple M2 Pro', 'hw.model': 'Mac14,10', 'hw.perflevel0.physicalcpu': '8', 'hw.perflevel1.physicalcpu': '4',
    'hw.physicalcpu': '12', 'hw.logicalcpu': '12', 'hw.packages': '1', 'hw.memsize': String(32 * 1024 ** 3), 'hw.optional.neon': '1',
  }
  const macRun = (answers: Record<string, string>): RunCmd => async (cmd, args) => {
    if (cmd === 'sw_vers') return '15.3.1\n'
    if (cmd === 'sysctl' && args[0] === '-n' && args[1]! in answers) return `${answers[args[1]!]}\n`
    throw new Error('unknown oid') // sysctl exits non-zero for a key the machine does not have
  }
  const GRAPHICS = /gpu|cuda|nvidia|vram|metal|graphics|radeon/i

  test('Apple silicon: chip, P / E cores, unified memory, macOS; no graphics section anywhere', async () => {
    const info = await detectSystem({ os: 'darwin', arch: 'arm64', run: macRun(sysctl), ...NO_CPU })
    expect(info.mac).toEqual({ model: 'Mac14,10', chip: 'Apple M2 Pro', performanceCores: 8, efficiencyCores: 4, macos: '15.3.1' })
    expect(info.cpu).toMatchObject({ model: 'Apple M2 Pro', physicalCores: 12, logicalCores: 12, sockets: 1, numaNodes: null })
    expect(info.cpu.features).toEqual({ avx: null, avx2: null, avx512: null, fma: null, f16c: null, neon: true })
    expect(info.memory.totalMiB).toBe(32768)
    expect(info.nvidia).toBeUndefined()
    expect(info.cudaLimits).toBeUndefined()
    expect(info.recommend).toBeUndefined()
    const full = await describeSystem({ os: 'darwin', arch: 'arm64', run: macRun(sysctl), cudaRuntime: '12.4', ...NO_CPU })
    expect(full.warnings).toEqual([]) // an Apple chip has no AVX2 and that is not a warning
    // Nothing a Mac user sees mentions a graphics device or CUDA: not in the data, not in the warning codes.
    expect(JSON.stringify(full)).not.toMatch(GRAPHICS)
  })

  test('Intel Mac: features come from sysctl, missing keys stay unknown', async () => {
    const intel = { 'machdep.cpu.brand_string': 'Intel(R) Core(TM) i9-9980HK', 'hw.model': 'MacBookPro16,1', 'hw.physicalcpu': '8', 'hw.logicalcpu': '16', 'hw.memsize': String(16 * 1024 ** 3), 'hw.optional.avx1_0': '1', 'hw.optional.avx2_0': '1', 'hw.optional.avx512f': '0' }
    const info = await detectSystem({ os: 'darwin', arch: 'x64', run: macRun(intel), ...NO_CPU })
    expect(info.mac).toMatchObject({ chip: 'Intel(R) Core(TM) i9-9980HK', performanceCores: null, efficiencyCores: null })
    expect(info.cpu.features).toEqual({ avx: true, avx2: true, avx512: false, fma: null, f16c: null, neon: false })
    expect(JSON.stringify(info)).not.toMatch(GRAPHICS)
  })

  test('sysctl failing entirely: Node facts, everything else unknown', async () => {
    const run: RunCmd = async () => { throw new Error('nope') }
    const info = await detectSystem({ os: 'darwin', arch: 'arm64', run, ...NO_CPU })
    expect(info.mac).toEqual({ model: null, chip: null, performanceCores: null, efficiencyCores: null, macos: null })
    expect(info.cpu).toMatchObject({ model: 'Test CPU', logicalCores: 8 })
    expect(info.memory.totalMiB).toBe(32768)
  })

  test('parseMac on a constructed sysctl table', () => {
    expect(parseMac({ ...sysctl, 'hw.perflevel1.physicalcpu': undefined }, 'arm64', null).mac.efficiencyCores).toBeNull()
  })
})

test('other hosts: plain CPU and memory only', async () => {
  const info = await detectSystem({ os: 'linux', arch: 'x64', run: async () => { throw new Error('unused') }, ...NO_CPU })
  expect(info).toMatchObject({ os: 'linux', cpu: { model: 'Test CPU', logicalCores: 8 }, memory: { totalMiB: 32768 } })
  expect(info.nvidia).toBeUndefined()
  expect(info.mac).toBeUndefined()
})
