// Pure parts of the memory check before a load (decisions 42, 44): turn the estimate of a launch into the scheduler's
// answer, name the memory pool each part is drawn from, and take `mlock` off a launch that would lock more than is free.
import { canonicalFlag, groupArgs, groupValue } from './args'
import type { MemoryEstimate, Pool, Tier } from './memory-estimate'
import type { Admission } from './scheduler'

/** Id of the pool in a memory reading: a card keeps its device id; host memory and a Mac's shared memory are `system`. */
export const SYSTEM_POOL = 'system'
export const poolSampleId = (p: Pick<Pool, 'id' | 'kind'>): string => (p.kind === 'separate' ? p.id : SYSTEM_POOL)

const RANK: Record<Tier, number> = { ok: 0, risky: 1, unknown: 2, nofit: 3 }

/** The pool that decides: the worst tier, then the highest share of its budget. */
export function decidingPool(est: MemoryEstimate): Pool | null {
  let best: Pool | null = null
  for (const p of est.pools) {
    if (!best || RANK[p.tier] > RANK[best.tier] || (RANK[p.tier] === RANK[best.tier] && (p.ratio ?? 0) > (best.ratio ?? 0))) best = p
  }
  return best
}

/** What travels from the check to the launcher (`Admission.data`). */
export interface AdmissionData {
  /** Key of the measured-memory record of this launch shape (vram-stats.json). */
  statsKey: string | null
  /** Estimated MiB per pool, in the order of `sampleIds`. */
  estimateMiB: number[]
  /** Id (in a memory reading) of each estimated pool. */
  sampleIds: string[]
  /** `mlock` would lock more than is free: load without it. */
  dropMlock: boolean
  basis: 'measured' | 'formula'
}

/**
 * The scheduler's answer for an estimate (null = nothing could be estimated: unknown). Only the pools that hold
 * something are named; a launch with no GPU part draws on `system` only.
 */
export function admissionFrom(est: MemoryEstimate | null, extra: { statsKey?: string | null, dropMlock?: boolean, basis?: 'measured' | 'formula' } = {}): Admission {
  if (!est) return { tier: 'unknown', detail: { estimateMiB: null, availableMiB: null, pool: null }, pools: [] }
  const pool = decidingPool(est)
  const ids = est.pools.map(poolSampleId)
  const data: AdmissionData = {
    statsKey: extra.statsKey ?? null,
    estimateMiB: est.pools.map(p => p.totalMiB),
    sampleIds: ids,
    dropMlock: !!extra.dropMlock,
    basis: extra.basis ?? 'formula',
  }
  return {
    tier: est.tier,
    detail: { estimateMiB: pool?.totalMiB ?? null, availableMiB: pool?.budgetMiB ?? null, pool: pool ? poolSampleId(pool) : null },
    pools: [...new Set(ids)],
    data,
  }
}

/**
 * The argument array without weight locking: `--mlock` is removed, `--load-mode mlock` is removed and `mmap+mlock`
 * becomes `mmap`. The caller states the change (command preview, log); nothing here is silent.
 */
export function dropMlockArgs(args: string[]): { args: string[], dropped: boolean } {
  const mlock = canonicalFlag('--mlock')
  let dropped = false
  const out: string[] = []
  for (const g of groupArgs(args)) {
    if (g.flag && g.canon === mlock) { dropped = true; continue }
    if (g.flag && g.canon === canonicalFlag('--load-mode')) {
      const v = groupValue(g).toLowerCase()
      if (v === 'mlock') { dropped = true; continue }
      if (v === 'mmap+mlock') {
        dropped = true
        out.push(g.tokens[0]!.includes('=') ? `${g.flag}=mmap` : g.tokens[0]!)
        if (!g.tokens[0]!.includes('=')) out.push('mmap')
        continue
      }
    }
    out.push(...g.tokens)
  }
  return { args: out, dropped }
}
