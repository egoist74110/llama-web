// How much memory a new process can take on this machine right now (decision 44), without any native binding:
//  - macOS: `vm_stat` pages that are free, speculative, inactive or purgeable. Active pages are left out on purpose
//    (the OS can compress them, but only by slowing something else down), so the number is a safe lower bound.
//    `os.freemem()` is no use there: it counts only the free pages (99 MiB on a 16 GiB Mac with half of it unused).
//  - Linux: `MemAvailable` of /proc/meminfo.
//  - Windows: `os.freemem()` is the available physical memory (standby cache included).
// A failed probe is `null` (unknown), never a guess. Pure parsing + a thin runner; tests feed constructed output.
import { readFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { runCmd, type RunCmd } from './system'

export type MemorySource = 'vm_stat' | 'meminfo' | 'os' | 'unavailable'

export interface SystemMemorySample {
  totalMiB: number | null
  availableMiB: number | null
  source: MemorySource
}

const MIB = 1024 * 1024

/** Parse `vm_stat` output into the memory a new process can take, in MiB; null when the output is not readable. */
export function availableFromVmStat(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text)
  if (!page) return null
  const pages = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const free = pages('Pages free')
  const inactive = pages('Pages inactive')
  if (free === null || inactive === null) return null
  const n = free + inactive + (pages('Pages speculative') ?? 0) + (pages('Pages purgeable') ?? 0)
  return (n * Number(page[1])) / MIB
}

/** `MemAvailable` of /proc/meminfo in MiB. */
export function availableFromMeminfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)
  return m ? Number(m[1]) / 1024 : null
}

export interface SampleDeps {
  platform?: NodeJS.Platform
  run?: RunCmd
  readText?: (file: string) => Promise<string>
  total?: () => number
  free?: () => number
}

export async function sampleSystemMemory(deps: SampleDeps = {}): Promise<SystemMemorySample> {
  const platform = deps.platform ?? process.platform
  const totalMiB = (deps.total ?? totalmem)() / MIB
  const unknown: SystemMemorySample = { totalMiB: totalMiB > 0 ? totalMiB : null, availableMiB: null, source: 'unavailable' }
  try {
    if (platform === 'darwin') {
      const v = availableFromVmStat(await (deps.run ?? runCmd)('vm_stat', [], 3000))
      return v === null ? unknown : { totalMiB: unknown.totalMiB, availableMiB: v, source: 'vm_stat' }
    }
    if (platform === 'linux') {
      const v = availableFromMeminfo(await (deps.readText ?? ((f: string) => readFile(f, 'utf8')))('/proc/meminfo'))
      return v === null ? unknown : { totalMiB: unknown.totalMiB, availableMiB: v, source: 'meminfo' }
    }
    const free = (deps.free ?? freemem)() / MIB
    return free > 0 ? { totalMiB: unknown.totalMiB, availableMiB: free, source: 'os' } : unknown
  } catch {
    return unknown
  }
}
