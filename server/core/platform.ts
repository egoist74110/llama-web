// Host facts and explicit runtime targets. Detection never treats an unknown GPU as CUDA.
import { execFileSync } from 'node:child_process'
export type Acceleration = 'auto' | 'cuda' | 'cpu' | 'metal'
export interface RuntimeTarget { os: NodeJS.Platform, arch: string, acceleration: Exclude<Acceleration, 'auto'> }
export interface PlatformInfo {
  os: NodeJS.Platform
  arch: string
  acceleration: Exclude<Acceleration, 'auto'> | 'unknown'
  shell: 'cmd' | 'posix'
  verified: boolean
}
export function platformInfo(os = process.platform, arch = process.arch, nvidia?: boolean): PlatformInfo {
  const acceleration = os === 'win32' ? (nvidia === undefined ? 'unknown' : nvidia ? 'cuda' : 'cpu')
    : os === 'darwin' && arch === 'arm64' ? 'metal' : os === 'darwin' ? 'cpu' : 'unknown'
  return { os, arch, acceleration, shell: os === 'win32' ? 'cmd' : 'posix', verified: os === 'win32' && arch === 'x64' }
}
export function runtimeTarget(info: PlatformInfo, wanted: Acceleration): RuntimeTarget {
  const acceleration = wanted === 'auto' ? info.acceleration : wanted
  if (!['win32', 'darwin'].includes(info.os) || !['x64', 'arm64'].includes(info.arch)
    || (info.os === 'win32' && info.arch !== 'x64') || acceleration === 'unknown'
    || (info.os === 'win32' && acceleration === 'metal') || (info.os === 'darwin' && acceleration === 'cuda')) {
    throw new Error(`Choose a supported runtime acceleration for ${info.os}/${info.arch}`)
  }
  return { os: info.os, arch: info.arch, acceleration }
}
export function detectPlatform(): PlatformInfo {
  if (process.platform !== 'win32') return platformInfo()
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return platformInfo(process.platform, process.arch, !!out.trim())
  } catch { return platformInfo() }
}
export const targetKey = (t: RuntimeTarget) => `${t.os}-${t.arch}-${t.acceleration}`
export const legacyWindows = (t: RuntimeTarget) => t.os === 'win32' && t.arch === 'x64' && t.acceleration === 'cuda'
export function cloudflaredAssetName(os = process.platform, arch: string = process.arch): string | null {
  if (os === 'win32' && arch === 'x64') return 'cloudflared-windows-amd64.exe'
  if (os === 'darwin' && ['x64', 'arm64'].includes(arch)) return `cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`
  if (os === 'linux' && ['x64', 'arm64'].includes(arch)) return `cloudflared-linux-${arch === 'x64' ? 'amd64' : 'arm64'}`
  return null
}
