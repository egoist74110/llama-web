// Which CUDA runtime build of llama.cpp a machine can run (decision 37). Pure functions; the
// detection that feeds them is in system.ts.
//
// Facts (NVIDIA CUDA Toolkit Release Notes, checked 2026-10-03):
// - Minor version compatibility: a CUDA 13.x runtime needs a driver >= 580, a 12.x runtime a
//   driver >= 525 (and < 580 only in the sense that 580+ drivers also run 12.x), 11.x >= 450.
//   Within one major, any minor runs on any driver of that major's range.
// - `nvidia-smi` reports the highest CUDA version the driver supports ("CUDA Version" in older
//   drivers, "CUDA UMD Version" in newer ones): a runtime of a higher major cannot run.
// - CUDA 13.0 removed Maxwell, Pascal and Volta (compute capability < 7.5); CUDA 12 still
//   supports compute capability 5.0 and up (12.0 removed Kepler).
import { RuntimeError } from './llamacpp'

/** Lowest driver version (the number nvidia-smi prints) that runs a CUDA runtime of this major. */
export const CUDA_MIN_DRIVER: ReadonlyArray<{ major: number, driver: number }> = [
  { major: 13, driver: 580 },
  { major: 12, driver: 525 },
  { major: 11, driver: 450 },
]

/** Lowest compute capability a CUDA runtime of this major still builds kernels for. */
export const CUDA_MIN_COMPUTE_CAP: Readonly<Record<number, number>> = { 13: 7.5, 12: 5.0, 11: 3.5 }

/** What the machine allows; every field null = unknown (never guessed). */
export interface CudaLimits {
  /** Highest CUDA major the driver runs. */
  maxMajor: number | null
  /** Highest compute capability among the installed NVIDIA GPUs. */
  maxComputeCap: number | null
}

export const parseVersion = (v: string): { major: number, minor: number } | null => {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

/** Highest CUDA major a driver (`580.88`) supports, from the minimum-driver table; null when it cannot be parsed or is too old. */
export function maxMajorForDriver(driver: string | null): number | null {
  const n = Number.parseFloat(driver ?? '')
  if (!Number.isFinite(n)) return null
  return CUDA_MIN_DRIVER.find(r => n >= r.driver)?.major ?? null
}

/** Why a CUDA runtime `version` cannot run on this machine, or null when it can (or nothing is known against it). */
export function cudaIncompatibility(version: string, limits: CudaLimits | null): 'driver-too-old' | 'compute-cap-too-low' | null {
  const v = parseVersion(version)
  if (!v || !limits) return null
  if (limits.maxMajor !== null && v.major > limits.maxMajor) return 'driver-too-old'
  const minCc = CUDA_MIN_COMPUTE_CAP[v.major]
  if (limits.maxComputeCap !== null && minCc !== undefined && limits.maxComputeCap < minCc) return 'compute-cap-too-low'
  return null
}

/**
 * Automatic choice among the runtime versions a release ships: the highest one the machine can
 * run. Unknown hardware picks the newest of the lowest major (the most widely supported) instead
 * of a guess upwards. Throws `no-compatible-cuda` (with the reasons) when none can run.
 */
export function pickCuda(candidates: string[], limits: CudaLimits | null): string {
  const parsed = candidates.map(c => ({ c, v: parseVersion(c)! })).filter(x => x.v)
  const newest = (xs: typeof parsed) => xs.sort((a, b) => b.v.major - a.v.major || b.v.minor - a.v.minor)[0]?.c
  if (!parsed.length) throw new RuntimeError('no-compatible-cuda', 'The release has no CUDA build', '')
  if (!limits || (limits.maxMajor === null && limits.maxComputeCap === null)) {
    const low = Math.min(...parsed.map(x => x.v.major))
    return newest(parsed.filter(x => x.v.major === low))!
  }
  const ok = parsed.filter(x => !cudaIncompatibility(x.c, limits))
  const pick = newest(ok)
  if (pick) return pick
  const why = [...new Set(parsed.map(x => `${x.c}: ${cudaIncompatibility(x.c, limits)}`))].join('; ')
  throw new RuntimeError('no-compatible-cuda', 'No CUDA build in the release can run on this machine', why)
}
