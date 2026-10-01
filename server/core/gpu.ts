// GPU memory sampling through nvidia-smi. No nvidia-smi (or no NVIDIA GPU) means `available:
// false` and the UI hides the bar. Sampling only runs while someone is watching.
import { spawn } from 'node:child_process'

export interface GpuInfo {
  index: number
  name: string
  usedMiB: number
  totalMiB: number
  /** GPU core utilisation percent, null when not reported. */
  utilization: number | null
}

export interface GpuDoc {
  available: boolean
  gpus: GpuInfo[]
}

export const NO_GPU: GpuDoc = { available: false, gpus: [] }

const QUERY = ['--query-gpu=index,name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits']

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(',').map(s => s.trim())
    if (parts.length < 5) continue
    // Index first, then the name (it may contain commas in theory), then used / total / utilisation.
    const [index, ...rest] = parts
    const nums = rest.slice(-3)
    const name = rest.slice(0, -3).join(', ')
    const usedMiB = Number(nums[0])
    const totalMiB = Number(nums[1])
    const util = Number(nums[2])
    if (!Number.isFinite(Number(index)) || !Number.isFinite(usedMiB) || !Number.isFinite(totalMiB) || totalMiB <= 0) continue
    out.push({ index: Number(index), name, usedMiB, totalMiB, utilization: Number.isFinite(util) ? util : null })
  }
  return out
}

/** Run nvidia-smi once. Rejects when it is missing or fails. */
export function runNvidiaSmi(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
    const child = spawn('nvidia-smi', QUERY, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { done(() => reject(new Error('nvidia-smi timed out'))); try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.on('error', e => done(() => reject(e)))
    child.on('close', code => done(() => (code === 0 ? resolve(out) : reject(new Error(`nvidia-smi exited with ${code}`)))))
  })
}

export interface GpuSamplerOptions {
  /** Sampling period in ms (settings.gpu.sampleSec, 2 s by default); a getter picks up edits. */
  intervalMs?: number | (() => number)
  /** Sampling pauses while this returns false (nobody is connected). */
  active?(): boolean
  /** After nvidia-smi is missing, look again this rarely. */
  retryMissingMs?: number
  run?(): Promise<string>
  onChange?(): void
}

export class GpuSampler {
  private doc: GpuDoc = NO_GPU
  private timer: ReturnType<typeof setTimeout> | null = null
  private missing = false
  private stopped = true
  private busy = false

  constructor(private readonly opts: GpuSamplerOptions = {}) {}

  get value(): GpuDoc {
    return this.doc
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Take one sample now (the loop calls this; tests call it directly). */
  async sample(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const text = await (this.opts.run ?? runNvidiaSmi)()
      const gpus = parseNvidiaSmi(text)
      this.missing = false
      this.set(gpus.length ? { available: true, gpus } : NO_GPU)
    } catch {
      this.missing = true
      this.set(NO_GPU)
    } finally {
      this.busy = false
    }
  }

  private set(next: GpuDoc): void {
    if (JSON.stringify(next) === JSON.stringify(this.doc)) return
    this.doc = next
    try { this.opts.onChange?.() } catch { /* listener errors must not stop sampling */ }
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(async () => {
      if (!this.opts.active || this.opts.active()) await this.sample()
      const every = typeof this.opts.intervalMs === 'function' ? this.opts.intervalMs() : (this.opts.intervalMs ?? 2000)
      this.schedule(this.missing ? (this.opts.retryMissingMs ?? 60_000) : every)
    }, delay)
    this.timer.unref?.()
  }
}
