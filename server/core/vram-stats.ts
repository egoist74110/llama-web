// Measured memory of finished loads (decision 43): `data/vram-stats.json`. Only numbers are stored, under an opaque
// key (a hash of the model / profile / device / parameter summary the caller passes), never paths or names.
// The next estimate for the same key prefers the measurement (`preferMeasured`); a big gap between the two is
// reported so the coefficients can be corrected. Atomic writes; a damaged file starts again empty (everything in it
// can be measured again), a file of a newer version is left alone and only kept in memory.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEstimate, Pool } from './memory-estimate'
import { tierOf, worstTier } from './memory-estimate'
import { writeFileAtomic } from './store'

export const VRAM_STATS_VERSION = 1
const MAX_ENTRIES = 500

export interface StatsEntry {
  /** Epoch ms of the measurement. */
  at: number
  /** What was estimated for the same launch, per pool (MiB), in the order of `measuredMiB`. */
  estimateMiB: number[]
  /** Memory the load added, per pool (MiB): the difference of the device's used memory before and after. */
  measuredMiB: number[]
}

export interface StatsDoc {
  version: number
  entries: Record<string, StatsEntry>
}

/** Opaque key of one launch shape. Pass what changes the memory: model, profile, devices, the parameter summary. */
export function statsKey(parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/** Memory a load added per pool: `after - before`; a pool with no usable pair, or no growth (noise), is null. */
export function loadDelta(beforeMiB: ReadonlyArray<number | null>, afterMiB: ReadonlyArray<number | null>): Array<number | null> {
  return beforeMiB.map((b, i) => {
    const a = afterMiB[i]
    if (b === null || b === undefined || a === null || a === undefined) return null
    return a - b > 0 ? a - b : null
  })
}

export interface RecordResult {
  recorded: boolean
  reason?: 'concurrent-load' | 'no-measurement' | 'invalid'
  /** (measured - estimated) / estimated of the biggest pool; null when not recorded. */
  deviation: number | null
  /** The gap is worth an event: the estimate was more than 10% too low or more than twice too high. */
  significant: boolean
}

function emptyDoc(): StatsDoc {
  return { version: VRAM_STATS_VERSION, entries: {} }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

function clean(raw: unknown): StatsDoc | 'newer' {
  if (!raw || typeof raw !== 'object') return emptyDoc()
  const o = raw as { version?: unknown, entries?: unknown }
  if (typeof o.version === 'number' && o.version > VRAM_STATS_VERSION) return 'newer'
  const doc = emptyDoc()
  if (o.entries && typeof o.entries === 'object') {
    for (const [k, v] of Object.entries(o.entries as Record<string, any>)) {
      if (!/^[0-9a-f]{16}$/.test(k) || !v || !isNum(v.at) || !Array.isArray(v.estimateMiB) || !Array.isArray(v.measuredMiB)) continue
      if (!v.estimateMiB.every(isNum) || !v.measuredMiB.every(isNum) || v.estimateMiB.length !== v.measuredMiB.length) continue
      doc.entries[k] = { at: v.at, estimateMiB: v.estimateMiB, measuredMiB: v.measuredMiB }
    }
  }
  return doc
}

export class VramStats {
  readonly file: string
  private doc: StatsDoc
  private readOnly = false

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, 'vram-stats.json')
    this.doc = this.read()
  }

  private read(): StatsDoc {
    if (!existsSync(this.file)) return emptyDoc()
    try {
      const doc = clean(JSON.parse(readFileSync(this.file, 'utf8')))
      if (doc === 'newer') { this.readOnly = true; return emptyDoc() }
      return doc
    } catch {
      return emptyDoc()
    }
  }

  lookup(key: string): StatsEntry | null {
    return this.doc.entries[key] ?? null
  }

  get size(): number {
    return Object.keys(this.doc.entries).length
  }

  /**
   * Record the memory a finished load added. Refused while another load was in progress (its memory would be mixed
   * in) or when nothing was measured. `measuredMiB` / `estimateMiB` are per pool in the same order.
   */
  record(key: string, m: { estimateMiB: number[], measuredMiB: Array<number | null>, exclusive: boolean }): RecordResult {
    const none = (reason: RecordResult['reason']): RecordResult => ({ recorded: false, reason, deviation: null, significant: false })
    if (!/^[0-9a-f]{16}$/.test(key) || !m.estimateMiB.every(isNum) || m.estimateMiB.length !== m.measuredMiB.length) return none('invalid')
    if (!m.exclusive) return none('concurrent-load')
    if (!m.measuredMiB.some(v => v !== null)) return none('no-measurement')
    // A pool without a measurement keeps what was estimated, so the arrays stay aligned.
    const measured = m.measuredMiB.map((v, i) => (v === null ? m.estimateMiB[i]! : v))
    let big = 0
    m.estimateMiB.forEach((e, i) => { if (e > m.estimateMiB[big]!) big = i })
    const est = m.estimateMiB[big]!
    const deviation = est > 0 && m.measuredMiB[big] !== null ? (measured[big]! - est) / est : null
    this.doc.entries[key] = { at: this.now(), estimateMiB: m.estimateMiB.map(round), measuredMiB: measured.map(round) }
    this.prune()
    this.save()
    return { recorded: true, deviation, significant: deviation !== null && (deviation > 0.1 || deviation < -0.5) }
  }

  private prune() {
    const keys = Object.keys(this.doc.entries)
    if (keys.length <= MAX_ENTRIES) return
    keys.sort((a, b) => this.doc.entries[a]!.at - this.doc.entries[b]!.at)
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.doc.entries[k]
  }

  private save() {
    if (this.readOnly) return
    try { writeFileAtomic(this.file, JSON.stringify(this.doc, null, 2) + '\n') } catch { /* statistics only: the load already succeeded */ }
  }
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * Use the measurement of an earlier identical launch instead of the formula (decision 43). The measured number never
 * goes below what is known exactly (weights + KV + state + mmproj + draft): the device counters are noisy and a low
 * reading must not make a launch look safer than its fixed parts. Pools are matched by position.
 */
export function preferMeasured(est: MemoryEstimate, entry: StatsEntry | null): MemoryEstimate & { basis: 'measured' | 'formula' } {
  if (!entry || entry.measuredMiB.length !== est.pools.length) return { ...est, basis: 'formula' }
  const pools: Pool[] = est.pools.map((p, i) => {
    const exact = p.weightsMiB + p.kvMiB + p.stateMiB + p.mmprojMiB + p.draftMiB
    const totalMiB = Math.max(entry.measuredMiB[i]!, exact)
    return { ...p, totalMiB, ...tierOf(totalMiB, p.budgetMiB) }
  })
  const total = { ...est.total, totalMiB: pools.reduce((n, p) => n + p.totalMiB, 0) }
  return { ...est, pools, total, tier: worstTier(pools.map(p => p.tier)), basis: 'measured' }
}
