// Read-only detection of this machine (decisions 37 / 38): NVIDIA driver / CUDA / compute
// capability / memory and the CPU on Windows, chip / cores / memory on a Mac, plus the
// recommendations and warnings derived from them. Detection never loads a model and never uses
// the GPU; every command has a timeout, and a failure yields `unknown` / null (never a guess).
//
// A Mac result has no GPU section at all (decision 38): nothing in its structure or in its
// warnings mentions a graphics device. Pure module: commands come in through `RunCmd`.
import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { CUDA_MIN_COMPUTE_CAP, CUDA_MIN_DRIVER, cudaIncompatibility, maxMajorForDriver, parseVersion, type CudaLimits } from './cuda'

export type RunCmd = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

/** Run a program without a shell; rejects on a missing program (`code: 'ENOENT'`), a non-zero exit or a timeout. */
export const runCmd: RunCmd = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout) => {
    if (err) reject(err)
    else resolve(stdout)
  })
})

export interface CpuFeatures {
  avx: boolean | null
  avx2: boolean | null
  avx512: boolean | null
  fma: boolean | null
  f16c: boolean | null
  neon: boolean | null
}

export interface CpuInfo {
  model: string | null
  physicalCores: number | null
  logicalCores: number
  /** CPU packages (sockets); null when not reported. */
  sockets: number | null
  /** NUMA nodes; null when not reported. */
  numaNodes: number | null
  features: CpuFeatures
}

export interface MemoryInfo {
  totalMiB: number
  freeMiB: number
}

export interface NvidiaGpu {
  index: number
  name: string
  memoryMiB: number | null
  computeCap: number | null
}

export interface NvidiaSection {
  /** `ok` = nvidia-smi answered; `none` = no nvidia-smi / no NVIDIA GPU; `unknown` = it failed or timed out. */
  state: 'ok' | 'none' | 'unknown'
  driver: string | null
  /** Highest CUDA version the driver supports (`13.4`), from the nvidia-smi header. */
  maxCuda: string | null
  gpus: NvidiaGpu[]
  /** AMD / Intel graphics devices found (only looked at when there is no NVIDIA GPU). */
  otherVendors: string[]
}

/** Mac facts (decision 38). */
export interface MacSection {
  model: string | null
  chip: string | null
  performanceCores: number | null
  efficiencyCores: number | null
  macos: string | null
}

export interface SystemWarning {
  code: string
  severity: 'info' | 'warning'
  params?: Record<string, string | number>
}

export interface SystemInfo {
  os: NodeJS.Platform
  arch: string
  cpu: CpuInfo
  memory: MemoryInfo
  /** Windows only. */
  nvidia?: NvidiaSection
  /** Windows only: what the driver and GPU allow (null fields = unknown). */
  cudaLimits?: CudaLimits
  /** Windows only: which official channel suits this machine. */
  recommend?: { acceleration: 'cuda' | 'cpu' }
  /** macOS only. */
  mac?: MacSection
  warnings: SystemWarning[]
  detectedAt: string
}

const MiB = 1024 * 1024
const num = (v: string | undefined): number | null => {
  const n = Number(v?.trim())
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? n : null
}
const flag = (v: string | undefined): boolean | null => (v === undefined || v.trim() === '' ? null : v.trim() === '1')
const NO_FEATURES: CpuFeatures = { avx: null, avx2: null, avx512: null, fma: null, f16c: null, neon: null }

// ---------------------------------------------------------------------------------------------
// NVIDIA

/** `nvidia-smi --query-gpu=index,name,driver_version[,compute_cap],memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaGpus(text: string, withComputeCap: boolean): { gpus: NvidiaGpu[], driver: string | null } {
  const gpus: NvidiaGpu[] = []
  let driver: string | null = null
  const tail = withComputeCap ? 3 : 2 // driver [, cc], memory
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(',').map(s => s.trim())
    if (parts.length < 2 + tail || !Number.isInteger(Number(parts[0]))) continue
    const rest = parts.slice(1)
    const t = rest.slice(-tail)
    const name = rest.slice(0, -tail).join(', ')
    driver ??= t[0] || null
    gpus.push({ index: Number(parts[0]), name, memoryMiB: num(t[t.length - 1]), computeCap: withComputeCap ? num(t[1]) : null })
  }
  return { gpus, driver }
}

/** The "CUDA Version: 12.4" (older drivers) / "CUDA UMD Version: 13.4" (newer) field in the nvidia-smi banner. */
export function parseCudaBanner(text: string): string | null {
  const m = /CUDA(?:\s+UMD)?\s+Version:\s*(\d+\.\d+)/i.exec(text)
  return m ? m[1]! : null
}

export function cudaLimitsOf(n: NvidiaSection): CudaLimits | null {
  if (n.state !== 'ok') return null
  const banner = n.maxCuda ? parseVersion(n.maxCuda)?.major ?? null : null
  const ccs = n.gpus.map(g => g.computeCap).filter((c): c is number => c !== null)
  return { maxMajor: banner ?? maxMajorForDriver(n.driver), maxComputeCap: ccs.length ? Math.max(...ccs) : null }
}

async function detectNvidia(run: RunCmd, timeoutMs: number): Promise<NvidiaSection> {
  const base = ['--format=csv,noheader,nounits']
  const query = (withCc: boolean) => run('nvidia-smi', [`--query-gpu=index,name,driver_version,${withCc ? 'compute_cap,' : ''}memory.total`, ...base], timeoutMs)
  let parsed: ReturnType<typeof parseNvidiaGpus> | null = null
  let missing = false
  try {
    parsed = parseNvidiaGpus(await query(true), true)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing = true
    else {
      // Old drivers do not know `compute_cap`: ask again without it.
      try { parsed = parseNvidiaGpus(await query(false), false) } catch (e2) { missing = (e2 as NodeJS.ErrnoException).code === 'ENOENT' }
    }
  }
  if (!parsed) return { state: missing ? 'none' : 'unknown', driver: null, maxCuda: null, gpus: [], otherVendors: [] }
  if (!parsed.gpus.length) return { state: 'none', driver: parsed.driver, maxCuda: null, gpus: [], otherVendors: [] }
  let maxCuda: string | null = null
  try { maxCuda = parseCudaBanner(await run('nvidia-smi', [], timeoutMs)) } catch { /* the driver number alone still gives a limit */ }
  return { state: 'ok', driver: parsed.driver, maxCuda, gpus: parsed.gpus, otherVendors: [] }
}

// ---------------------------------------------------------------------------------------------
// Windows CPU / video probe (one PowerShell call: ~1-2 s, so it is cached by the caller)

// IsProcessorFeaturePresent ids (winnt.h): 39 AVX, 40 AVX2, 41 AVX-512F. Windows has no id for FMA / F16C.
const WIN_PROBE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LwK { [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f); [DllImport("kernel32.dll")] public static extern bool GetNumaHighestNodeNumber(out uint n); }'`,
  '$n = 0; [void][LwK]::GetNumaHighestNodeNumber([ref]$n)',
  `'FEAT|' + [int][LwK]::IsProcessorFeaturePresent(39) + '|' + [int][LwK]::IsProcessorFeaturePresent(40) + '|' + [int][LwK]::IsProcessorFeaturePresent(41) + '|' + ($n + 1)`,
  `Get-CimInstance Win32_Processor | ForEach-Object { 'CPU|' + $_.Name + '|' + $_.NumberOfCores + '|' + $_.NumberOfLogicalProcessors }`,
  `Get-CimInstance Win32_VideoController | ForEach-Object { 'VID|' + $_.Name }`,
].join('\n')

export interface WinProbe {
  processors: Array<{ name: string, cores: number | null, logical: number | null }>
  features: { avx: boolean | null, avx2: boolean | null, avx512: boolean | null } | null
  numaNodes: number | null
  video: string[]
}

export function parseWinProbe(text: string): WinProbe {
  const out: WinProbe = { processors: [], features: null, numaNodes: null, video: [] }
  for (const raw of text.split(/\r?\n/)) {
    const p = raw.trim().split('|')
    if (p[0] === 'FEAT' && p.length >= 5) {
      out.features = { avx: flag(p[1]), avx2: flag(p[2]), avx512: flag(p[3]) }
      out.numaNodes = num(p[4])
    } else if (p[0] === 'CPU' && p.length >= 4) {
      out.processors.push({ name: p[1]!.replace(/\s+/g, ' ').trim(), cores: num(p[2]), logical: num(p[3]) })
    } else if (p[0] === 'VID' && p.length >= 2) {
      out.video.push(p.slice(1).join('|').trim())
    }
  }
  return out
}

/** AMD / Intel graphics among video controller names (virtual display adapters do not match). */
export function otherGraphicsVendors(names: string[]): string[] {
  const out = new Set<string>()
  for (const n of names) {
    if (/nvidia/i.test(n)) continue
    if (/\b(amd|radeon)\b/i.test(n)) out.add('AMD')
    else if (/\bintel\b/i.test(n) && /(arc|iris|uhd|hd graphics|graphics)/i.test(n)) out.add('Intel')
  }
  return [...out]
}

function cpuFromWin(p: WinProbe, fallback: { model: string | null, logical: number }): CpuInfo {
  const procs = p.processors
  const sum = (k: 'cores' | 'logical') => (procs.length && procs.every(x => x[k] !== null) ? procs.reduce((n, x) => n + x[k]!, 0) : null)
  return {
    model: procs[0]?.name || fallback.model,
    physicalCores: sum('cores'),
    logicalCores: sum('logical') ?? fallback.logical,
    sockets: procs.length || null,
    numaNodes: p.numaNodes,
    features: { ...NO_FEATURES, ...(p.features ?? {}) },
  }
}

// ---------------------------------------------------------------------------------------------
// macOS

const SYSCTL_KEYS = [
  'machdep.cpu.brand_string', 'hw.model', 'hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu', 'hw.physicalcpu', 'hw.logicalcpu',
  'hw.packages', 'hw.memsize', 'hw.optional.avx1_0', 'hw.optional.avx2_0', 'hw.optional.avx512f', 'hw.optional.fma', 'hw.optional.f16c', 'hw.optional.neon',
] as const

/** Turn raw `sysctl -n` answers (key → text, missing key = not reported) and `sw_vers` into Mac facts. */
export function parseMac(ctl: Record<string, string | undefined>, arch: string, macos: string | null): { mac: MacSection, cpu: Omit<CpuInfo, 'logicalCores'> & { logicalCores: number | null }, memoryMiB: number | null } {
  const apple = arch === 'arm64'
  const perf = num(ctl['hw.perflevel0.physicalcpu'])
  const eff = num(ctl['hw.perflevel1.physicalcpu'])
  const chip = ctl['machdep.cpu.brand_string']?.trim() || null
  const mem = num(ctl['hw.memsize'])
  return {
    mac: { model: ctl['hw.model']?.trim() || null, chip, performanceCores: apple ? perf : null, efficiencyCores: apple ? eff : null, macos },
    cpu: {
      model: chip,
      physicalCores: num(ctl['hw.physicalcpu']),
      logicalCores: num(ctl['hw.logicalcpu']),
      sockets: num(ctl['hw.packages']),
      numaNodes: null,
      features: apple
        ? { ...NO_FEATURES, neon: true } // x86 instruction sets do not apply: unknown, not "missing"
        : { avx: flag(ctl['hw.optional.avx1_0']), avx2: flag(ctl['hw.optional.avx2_0']), avx512: flag(ctl['hw.optional.avx512f']), fma: flag(ctl['hw.optional.fma']), f16c: flag(ctl['hw.optional.f16c']), neon: false },
    },
    memoryMiB: mem === null ? null : Math.round(mem / MiB),
  }
}

// ---------------------------------------------------------------------------------------------

export interface DetectOptions {
  os?: NodeJS.Platform
  arch?: string
  run?: RunCmd
  timeoutMs?: number
  /** Overridable for tests. */
  osCpu?: () => { model: string | null, logical: number }
  osMemory?: () => MemoryInfo
}

const hostCpu = () => { const c = cpus(); return { model: c[0]?.model?.replace(/\s+/g, ' ').trim() || null, logical: c.length || 1 } }
const hostMemory = (): MemoryInfo => ({ totalMiB: Math.round(totalmem() / MiB), freeMiB: Math.round(freemem() / MiB) })

/** Collect the facts. Never throws: whatever fails is unknown. Warnings are added by `describeSystem`. */
export async function detectSystem(o: DetectOptions = {}): Promise<Omit<SystemInfo, 'warnings'>> {
  const os = o.os ?? process.platform
  const arch = o.arch ?? process.arch
  const run = o.run ?? runCmd
  const timeout = o.timeoutMs ?? 5000
  const fallback = (o.osCpu ?? hostCpu)()
  const memory = (o.osMemory ?? hostMemory)()
  const base = { os, arch, detectedAt: new Date().toISOString() }

  if (os === 'win32') {
    const [nvidia, probeText] = await Promise.all([
      detectNvidia(run, timeout),
      run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_PROBE, 'utf16le').toString('base64')], timeout * 2).catch(() => ''),
    ])
    const probe = parseWinProbe(probeText)
    if (nvidia.state !== 'ok') nvidia.otherVendors = otherGraphicsVendors(probe.video)
    const limits = cudaLimitsOf(nvidia)
    const ccLow = limits?.maxComputeCap != null && limits.maxComputeCap < Math.min(...Object.values(CUDA_MIN_COMPUTE_CAP))
    const driverTooOld = nvidia.state === 'ok' && limits !== null && limits.maxMajor === null && Number.isFinite(Number.parseFloat(nvidia.driver ?? ''))
    return {
      ...base, cpu: cpuFromWin(probe, fallback), memory, nvidia,
      ...(limits ? { cudaLimits: limits } : {}),
      recommend: { acceleration: nvidia.state === 'ok' && !ccLow && !driverTooOld ? 'cuda' : 'cpu' },
    }
  }

  if (os === 'darwin') {
    const ask = async (k: string) => { try { return (await run('sysctl', ['-n', k], timeout)).trim() } catch { return undefined } }
    const answers = await Promise.all(SYSCTL_KEYS.map(ask))
    const ctl = Object.fromEntries(SYSCTL_KEYS.map((k, i) => [k, answers[i]]))
    const macos = await run('sw_vers', ['-productVersion'], timeout).then(s => s.trim() || null, () => null)
    const m = parseMac(ctl, arch, macos)
    return { ...base, mac: m.mac, cpu: { ...m.cpu, model: m.cpu.model ?? fallback.model, logicalCores: m.cpu.logicalCores ?? fallback.logical }, memory: m.memoryMiB === null ? memory : { ...memory, totalMiB: m.memoryMiB } }
  }

  return { ...base, cpu: { model: fallback.model, physicalCores: null, logicalCores: fallback.logical, sockets: null, numaNodes: null, features: NO_FEATURES }, memory }
}

/** Recommendations and warnings (decision 37); `cudaRuntime` is the user's override ('' = automatic). */
export function systemWarnings(info: Omit<SystemInfo, 'warnings'>, cfg: { cudaRuntime: string }): SystemWarning[] {
  const w: SystemWarning[] = []
  const f = info.cpu.features
  if (info.os === 'win32' && info.nvidia) {
    const n = info.nvidia
    if (n.state === 'none') {
      w.push({ code: 'no-nvidia', severity: 'warning' })
      if (n.otherVendors.length) w.push({ code: 'other-gpu-vendor', severity: 'info', params: { vendors: n.otherVendors.join(', ') } })
    } else if (n.state === 'unknown') {
      w.push({ code: 'nvidia-unknown', severity: 'info' })
    } else if (info.cudaLimits) {
      const lim = info.cudaLimits
      const top = CUDA_MIN_DRIVER[0]!
      if (lim.maxMajor === null && Number.isFinite(Number.parseFloat(n.driver ?? ''))) {
        w.push({ code: 'driver-too-old', severity: 'warning', params: { driver: n.driver ?? '' } })
      } else if (lim.maxMajor !== null && lim.maxMajor < top.major) {
        w.push({ code: 'driver-below-latest-cuda', severity: 'info', params: { driver: n.driver ?? '', maxMajor: lim.maxMajor, latestMajor: top.major, minDriver: top.driver } })
      }
      const lowest = Math.min(...Object.values(CUDA_MIN_COMPUTE_CAP))
      if (lim.maxComputeCap !== null && lim.maxComputeCap < lowest) {
        w.push({ code: 'compute-cap-unsupported', severity: 'warning', params: { computeCap: lim.maxComputeCap } })
      } else if (lim.maxComputeCap !== null && lim.maxComputeCap < (CUDA_MIN_COMPUTE_CAP[top.major] ?? 0)) {
        w.push({ code: 'compute-cap-below-latest-cuda', severity: 'info', params: { computeCap: lim.maxComputeCap, latestMajor: top.major } })
      }
      const why = cfg.cudaRuntime ? cudaIncompatibility(cfg.cudaRuntime, lim) : null
      if (why) w.push({ code: 'cuda-override-unsupported', severity: 'warning', params: { version: cfg.cudaRuntime, reason: why } })
    }
  }
  if (f.avx2 === false && f.neon !== true) w.push({ code: 'no-avx2', severity: 'warning' })
  if (info.cpu.logicalCores > 64) w.push({ code: 'many-logical-cores', severity: 'info', params: { logical: info.cpu.logicalCores } })
  return w
}

/**
 * Memory check for one model: `memory-tight` when the model and its context take most of the
 * memory (worded as a share of memory, so it also reads right on a Mac with unified memory),
 * `memory-below-model` when less than the model file is free (an `mlock` load would fail).
 */
export function memoryFit(memory: MemoryInfo, modelBytes: number, contextBytes = 0, unified = false): SystemWarning | null {
  if (!(modelBytes > 0) || !(memory.totalMiB > 0)) return null
  const need = (modelBytes + Math.max(0, contextBytes)) / MiB
  const share = Math.round((need / memory.totalMiB) * 100)
  // Unified memory (Mac) reports cached pages as used, so only the share counts there.
  if (!unified && memory.freeMiB < modelBytes / MiB) return { code: 'memory-below-model', severity: 'warning', params: { share } }
  return share >= 80 ? { code: 'memory-tight', severity: 'warning', params: { share } } : null
}

export async function describeSystem(o: DetectOptions & { cudaRuntime: string }): Promise<SystemInfo> {
  const info = await detectSystem(o)
  return { ...info, warnings: systemWarnings(info, { cudaRuntime: o.cudaRuntime }) }
}

/** The limits the updater uses for the automatic CUDA runtime choice (null = unknown, or not Windows). */
export const cudaLimitsFor = (info: Pick<SystemInfo, 'nvidia'>): CudaLimits | null => (info.nvidia ? cudaLimitsOf(info.nvidia) : null)
