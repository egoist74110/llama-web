// Host facts and explicit runtime targets. Detection never treats an unknown GPU as CUDA.
import { bestCudaRunnable, type CudaHardware } from './cuda'
import { execFileSync } from 'node:child_process'
export type Acceleration = 'auto' | 'cuda' | 'cpu' | 'metal' | 'vulkan'
export interface RuntimeTarget {
  os: NodeJS.Platform
  arch: string
  acceleration: Exclude<Acceleration, 'auto'>
  /** Official Windows GPU channel, fixed by context at startup (independent of auto's target). */
  gpuChannel?: 'cuda' | 'vulkan'
}
export type NvidiaProbe = 'found' | 'none' | 'missing' | 'failed'
export interface PlatformInfo {
  os: NodeJS.Platform
  arch: string
  acceleration: Exclude<Acceleration, 'auto' | 'vulkan'> | 'unknown'
  /** Windows only: distinguish a missing driver tool from a transient NVIDIA probe failure. */
  nvidiaProbe?: NvidiaProbe
  /** Windows only: can any NVIDIA card run a CUDA build that llama.cpp ships? null = unknown. */
  cudaRunnable?: boolean | null
  shell: 'cmd' | 'posix'
  verified: boolean
}
export function platformInfo(os = process.platform, arch = process.arch, nvidia?: boolean | NvidiaProbe, runnable?: boolean | null): PlatformInfo {
  const nvidiaProbe = typeof nvidia === 'string' ? nvidia : nvidia === true ? 'found' : nvidia === false ? 'none' : 'failed'
  const acceleration = os === 'win32' ? (nvidiaProbe === 'found' ? runnable === false ? 'unknown' : 'cuda' : nvidiaProbe === 'none' ? 'cpu' : 'unknown')
    : os === 'darwin' && arch === 'arm64' ? 'metal' : os === 'darwin' ? 'cpu' : 'unknown'
  return { os, arch, acceleration, ...(os === 'win32' ? { nvidiaProbe, ...(runnable !== undefined ? { cudaRunnable: runnable } : {}) } : {}), shell: os === 'win32' ? 'cmd' : 'posix', verified: (os === 'win32' && arch === 'x64') || (os === 'darwin' && arch === 'arm64') }
}
export function runtimeTarget(info: PlatformInfo, wanted: Acceleration): RuntimeTarget {
  const acceleration = wanted === 'auto' ? info.acceleration : wanted
  if (!['win32', 'darwin'].includes(info.os) || !['x64', 'arm64'].includes(info.arch)
    || (info.os === 'win32' && info.arch !== 'x64') || acceleration === 'unknown'
    || (info.os === 'win32' && acceleration === 'metal') || (info.os === 'darwin' && (acceleration === 'cuda' || acceleration === 'vulkan'))) {
    throw new Error(`Choose a supported runtime acceleration for ${info.os}/${info.arch}`)
  }
  return { os: info.os, arch: info.arch, acceleration }
}
/** Name plus optional numeric facts, read from the right so GPU names may contain commas. */
export function parseStartupNvidia(text: string, withComputeCap = true): Array<CudaHardware & { name: string }> {
  return text.split(/\r?\n/).map(line => {
    const parts = line.trim().split(',').map(p => p.trim())
    if (!line.trim()) return null
    const full = withComputeCap && parts.length >= 3
    const hasDriver = parts.length >= 2
    const driver = hasDriver ? parts.pop()! : null
    const cc = full ? Number(parts.pop()) : NaN
    return { name: parts.join(', '), computeCap: Number.isFinite(cc) && cc > 0 ? cc : null, driver }
  }).filter((row): row is NonNullable<typeof row> => row !== null && !!row.name)
}

/** At most two bounded calls (3 s each), with a retry for drivers that cannot query compute_cap. */
export function detectPlatform(os = process.platform, arch = process.arch, probe = (withComputeCap = true) => execFileSync('nvidia-smi', [`--query-gpu=name,${withComputeCap ? 'compute_cap,' : ''}driver_version`, '--format=csv,noheader'], { encoding: 'utf8', timeout: 3000, windowsHide: true })): PlatformInfo {
  if (os !== 'win32') return platformInfo(os, arch)
  const missing = (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'
  let text: string, withCc = true
  try { text = probe(true) }
  catch (e) {
    if (missing(e)) return platformInfo(os, arch, 'missing')
    try { text = probe(false); withCc = false }
    catch (retry) { return platformInfo(os, arch, missing(retry) ? 'missing' : 'failed') }
  }
  const cards = parseStartupNvidia(text, withCc)
  return platformInfo(os, arch, cards.length ? 'found' : 'none', cards.length ? bestCudaRunnable(cards) : null)
}

export interface RuntimeSelection {
  /** Saved acceleration read once at startup; auto remains auto even when it resolves to CUDA / Metal. */
  requested: Acceleration
  target: RuntimeTarget
  selectionError?: string
}

/** Resolve once at startup; an unknown probe still needs an explicit user choice (decision 61). */
export function selectRuntime(info: PlatformInfo, wanted: Acceleration): RuntimeSelection {
  let target: RuntimeTarget, selectionError: string | undefined
  try { target = runtimeTarget(info, wanted) }
  catch (e) {
    selectionError = (e as Error).message
    target = { os: info.os, arch: info.arch, acceleration: 'cpu' }
  }
  if (info.os === 'win32' && info.arch === 'x64') target.gpuChannel = gpuChannelFor(info, wanted)
  return { requested: wanted, target, ...(selectionError ? { selectionError } : {}) }
}
export const targetKey = (t: RuntimeTarget) => `${t.os}-${t.arch}-${t.acceleration}`
export const legacyWindows = (t: RuntimeTarget) => t.os === 'win32' && t.arch === 'x64' && t.acceleration === 'cuda'
export function cloudflaredAssetName(os = process.platform, arch: string = process.arch): string | null {
  if (os === 'win32' && arch === 'x64') return 'cloudflared-windows-amd64.exe'
  if (os === 'darwin' && ['x64', 'arm64'].includes(arch)) return `cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`
  if (os === 'linux' && ['x64', 'arm64'].includes(arch)) return `cloudflared-linux-${arch === 'x64' ? 'amd64' : 'arm64'}`
  return null
}

/** The Windows GPU channel is fixed at startup; it does not change the automatic launch target. */
export function gpuChannelFor(info: Pick<PlatformInfo, 'acceleration' | 'nvidiaProbe' | 'cudaRunnable'>, wanted: Acceleration): 'cuda' | 'vulkan' {
  if (wanted === 'vulkan') return 'vulkan'
  if (wanted === 'cuda') return 'cuda'
  if (info.nvidiaProbe === 'found' && info.cudaRunnable === false) return 'vulkan'
  return info.nvidiaProbe === 'found' || info.nvidiaProbe === 'failed' || (info.nvidiaProbe === undefined && info.acceleration !== 'cpu') ? 'cuda' : 'vulkan'
}

/** Conservative name heuristic for Windows devices that share host RAM (decision 61). */
export function isIntegratedGpuName(name: string): boolean {
  if (/\bnvidia\b/i.test(name)) return false
  if (/\bintel\b|\barc\b|\buhd\b|\biris\b/i.test(name)) {
    return !/\barc(?:\s*\(tm\))?\s+(?:pro\s+)?[ab]\d+\b/i.test(name)
  }
  return /\bradeon(?:\b|\(tm\))/i.test(name) && !/\b(?:rx|pro|instinct)\b/i.test(name)
}
