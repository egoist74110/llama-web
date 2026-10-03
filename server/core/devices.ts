// Device list of one llama.cpp build (decision 39): what `llama-server --list-devices` reports,
// cached per executable, with a fallback to the nvidia-smi order when the program cannot be run.
// Pure module: the program is run through `RunCmd`, so tests feed constructed output.
//
// Checked on a real RTX 5090 with b11146: stdout holds
//   Available devices:
//     CUDA0: NVIDIA GeForce RTX 5090 (32579 MiB, 30991 MiB free)
// the process exits in well under a second, loads no model and ends with exit 0; an unknown name in
// `--device` makes llama-server exit 1 with `invalid device: <name>`.
import type { CpuInfo, NvidiaGpu, RunCmd } from './system'

export interface GpuDevice {
  /** The name `--device` takes (`CUDA0`). */
  id: string
  name: string
  totalMiB: number
  /** Free memory when listed; null when the list came from nvidia-smi. */
  freeMiB: number | null
}

/** `list-devices`: the build itself answered. `nvidia-smi`: it could not be run, the order is a guess. */
export type DeviceSource = 'list-devices' | 'nvidia-smi' | 'unavailable'

export interface DeviceList {
  source: DeviceSource
  gpus: GpuDevice[]
}

const DEVICE_LINE = /^\s*([A-Za-z][A-Za-z0-9_.-]*):\s+(.+?)\s+\((\d+) MiB,\s*(\d+) MiB free\)\s*$/

/** Parse the stdout of `--list-devices`; lines that are not a device (the heading, log noise) are skipped. */
export function parseListDevices(text: string): GpuDevice[] {
  const out: GpuDevice[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = DEVICE_LINE.exec(line)
    if (m) out.push({ id: m[1]!, name: m[2]!, totalMiB: Number(m[3]), freeMiB: Number(m[4]) })
  }
  return out
}

/** `CUDA<index>` for every NVIDIA card nvidia-smi reports (the order can differ from CUDA's own: only a fallback). */
export function devicesFromNvidia(gpus: readonly NvidiaGpu[]): GpuDevice[] {
  return gpus.map(g => ({ id: `CUDA${g.index}`, name: g.name, totalMiB: g.memoryMiB ?? 0, freeMiB: null }))
}

/** Run `--list-devices` of one build. A program that cannot run, times out or prints nothing readable is `unavailable`. */
export async function probeDevices(exe: string, run: RunCmd, timeoutMs = 15_000): Promise<DeviceList> {
  let text: string
  try {
    text = await run(exe, ['--list-devices'], timeoutMs)
  } catch {
    return { source: 'unavailable', gpus: [] }
  }
  // No heading at all means this was not the list (a wrapper, a very old build): do not trust an empty result.
  if (!/Available devices:/i.test(text)) return { source: 'unavailable', gpus: [] }
  return { source: 'list-devices', gpus: parseListDevices(text) }
}

/**
 * Split modes this build accepts: the values in braces after `--split-mode` in its `--help` (checked on
 * b11146: `-sm,   --split-mode {none,layer,row,tensor}`). `none` is how a single device is pinned and is not a
 * choice of its own. Null = the help does not say (a wrapper, an older layout): nothing is blocked then.
 */
export function parseSplitModes(help: string): string[] | null {
  const m = /--split-mode\s+\{([^}]+)\}/.exec(help)
  if (!m) return null
  return m[1]!.split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z]+$/.test(x) && x !== 'none')
}

/** Per-executable cache of the probe (the device set only changes with hardware or driver, so a minute is plenty). */
export class DeviceProbe {
  private cache = new Map<string, { at: number, value: DeviceList }>()
  private running = new Map<string, Promise<DeviceList>>()
  private modes = new Map<string, string[] | null>()
  private modeRuns = new Map<string, Promise<string[] | null>>()

  constructor(private run: RunCmd, private ttlMs = 60_000, private now: () => number = Date.now) {}

  list(exe: string, opts: { refresh?: boolean } = {}): Promise<DeviceList> {
    const hit = this.cache.get(exe)
    if (hit && !opts.refresh && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value)
    const busy = this.running.get(exe)
    if (busy) return busy
    const p = probeDevices(exe, this.run).then((value) => {
      // A failure is not remembered: the next call tries again.
      if (value.source === 'list-devices') this.cache.set(exe, { at: this.now(), value })
      return value
    }).finally(() => this.running.delete(exe))
    this.running.set(exe, p)
    return p
  }

  /**
   * Split modes of one build (`--help`). A version never changes its own help, so a readable answer is kept for good;
   * a failed run is not remembered. Null = unknown.
   */
  splitModes(exe: string): Promise<string[] | null> {
    if (this.modes.has(exe)) return Promise.resolve(this.modes.get(exe)!)
    const busy = this.modeRuns.get(exe)
    if (busy) return busy
    const p = this.run(exe, ['--help'], 15_000).then(parseSplitModes, () => null).then((v) => {
      if (v) this.modes.set(exe, v)
      return v
    }).finally(() => this.modeRuns.delete(exe))
    this.modeRuns.set(exe, p)
    return p
  }

  forget(exe: string) {
    this.cache.delete(exe)
    this.modes.delete(exe)
  }
}

/**
 * Is the chosen device on this build's list? Only the build's own answer counts: a guess from
 * nvidia-smi or a failed probe never rejects a launch (the process reports an unknown device itself).
 */
export function deviceMissing(device: string, list: DeviceList): boolean {
  if (device === 'auto' || device === 'cpu') return false
  return list.source === 'list-devices' && !list.gpus.some(g => g.id === device)
}

export interface CpuDeviceInfo {
  logicalCores: number
  sockets: number | null
  numaNodes: number | null
  /** More than one socket or NUMA node: the NUMA / affinity options matter (shown by the interface). */
  multi: boolean
}

export interface DevicesView {
  applicable: true
  /** Reference of the build the list belongs to (null = the global version). */
  runtime: string | null
  source: DeviceSource
  gpus: GpuDevice[]
  cpu: CpuDeviceInfo
  /** Split modes the build accepts (`layer`, `row`, `tensor`); null = could not be read, nothing is blocked. */
  splitModes: string[] | null
}

/** Payload of `GET /api/devices` (a Mac gets `{ applicable: false }` from the route and never reaches this). */
export function describeDevices(runtime: string | null, list: DeviceList, cpu: Pick<CpuInfo, 'logicalCores' | 'sockets' | 'numaNodes'>, nvidia: readonly NvidiaGpu[], splitModes: string[] | null = null): DevicesView {
  const usable = list.source === 'list-devices' ? list : { source: nvidia.length ? 'nvidia-smi' as const : list.source, gpus: devicesFromNvidia(nvidia) }
  return {
    applicable: true, runtime, source: usable.source, gpus: usable.gpus, splitModes,
    cpu: {
      logicalCores: cpu.logicalCores, sockets: cpu.sockets, numaNodes: cpu.numaNodes,
      multi: (cpu.sockets ?? 1) > 1 || (cpu.numaNodes ?? 1) > 1,
    },
  }
}
