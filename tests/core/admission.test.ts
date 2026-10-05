// Pure parts of the memory check before a load (decisions 42, 44).
import { describe, expect, test } from 'bun:test'
import { admissionFrom, decidingPool, dropMlockArgs, poolSampleId } from '../../server/core/admission'
import type { MemoryEstimate, Pool, Tier } from '../../server/core/memory-estimate'
import { preferMeasured } from '../../server/core/vram-stats'

const pool = (id: string, kind: Pool['kind'], totalMiB: number, budgetMiB: number | null, tier: Tier, ratio: number | null): Pool => ({
  id, name: '', kind, weightsMiB: totalMiB, kvMiB: 0, stateMiB: 0, computeMiB: 0, mmprojMiB: 0, draftMiB: 0, fixedMiB: 0, totalMiB, budgetMiB, ratio, tier,
})
const est = (pools: Pool[], tier: Tier): MemoryEstimate => ({
  pools, tier, mlockMiB: 0, notes: [], kv: { fullCells: 0, swaCells: 0, slots: 1, unified: true, ctx: 0 },
  total: { weightsMiB: 0, kvMiB: 0, stateMiB: 0, computeMiB: 0, mmprojMiB: 0, draftMiB: 0, fixedMiB: 0, totalMiB: 0 },
})

describe('admissionFrom', () => {
  test('pools: a card keeps its id, host memory and a Mac pool are the system', () => {
    expect(poolSampleId(pool('CUDA1', 'separate', 1, 1, 'ok', 0))).toBe('CUDA1')
    expect(poolSampleId(pool('host', 'host', 1, 1, 'ok', 0))).toBe('system')
    expect(poolSampleId(pool('default', 'shared', 1, 1, 'ok', 0))).toBe('system')
  })

  test('the worst pool names the numbers; the tier is the estimate\'s', () => {
    const e = est([pool('CUDA0', 'separate', 9000, 8000, 'nofit', 1.125), pool('host', 'host', 2000, 20000, 'ok', 0.1)], 'nofit')
    expect(decidingPool(e)?.id).toBe('CUDA0')
    const a = admissionFrom(e, { statsKey: 'k', basis: 'measured' })
    expect(a.tier).toBe('nofit')
    expect(a.detail).toEqual({ estimateMiB: 9000, availableMiB: 8000, pool: 'CUDA0' })
    expect(a.pools).toEqual(['CUDA0', 'system'])
    expect(a.data).toEqual({ statsKey: 'k', estimateMiB: [9000, 2000], sampleIds: ['CUDA0', 'system'], dropMlock: false, basis: 'measured' })
  })

  test('unknown beats risky/ok as the deciding pool; ties go to the larger share', () => {
    const e = est([pool('CUDA0', 'separate', 1, 10, 'risky', 0.9), pool('host', 'host', 1, null, 'unknown', null)], 'unknown')
    expect(decidingPool(e)?.id).toBe('host')
    const f = est([pool('CUDA0', 'separate', 1, 10, 'ok', 0.2), pool('CUDA1', 'separate', 1, 10, 'ok', 0.8)], 'ok')
    expect(decidingPool(f)?.id).toBe('CUDA1')
  })

  test('no estimate (file unreadable) is unknown with no pools', () => {
    expect(admissionFrom(null)).toEqual({ tier: 'unknown', detail: { estimateMiB: null, availableMiB: null, pool: null }, pools: [] })
  })

  test('a measured record replaces the formula and can turn ok into risky', () => {
    const e = est([pool('CUDA0', 'separate', 5000, 10000, 'ok', 0.5)], 'ok')
    const m = preferMeasured(e, { at: 1, estimateMiB: [5000], measuredMiB: [9000] })
    expect(m.basis).toBe('measured')
    expect(admissionFrom(m).tier).toBe('risky')
  })
})

describe('dropMlockArgs', () => {
  test('--load-mode mlock and --mlock go, other arguments stay in order', () => {
    expect(dropMlockArgs(['-m', 'x.gguf', '--load-mode', 'mlock', '--port', '7100'])).toEqual({ args: ['-m', 'x.gguf', '--port', '7100'], dropped: true })
    expect(dropMlockArgs(['-m', 'x.gguf', '--mlock', '-c', '4096'])).toEqual({ args: ['-m', 'x.gguf', '-c', '4096'], dropped: true })
    expect(dropMlockArgs(['--load-mode=mlock', '-c', '1'])).toEqual({ args: ['-c', '1'], dropped: true })
  })

  test('mmap+mlock becomes mmap', () => {
    expect(dropMlockArgs(['--load-mode', 'mmap+mlock', '-c', '1']).args).toEqual(['--load-mode', 'mmap', '-c', '1'])
    expect(dropMlockArgs(['--load-mode=mmap+mlock']).args).toEqual(['--load-mode=mmap'])
  })

  test('other load modes and arguments without locking are untouched', () => {
    const args = ['-m', 'x.gguf', '--load-mode', 'mmap', '--no-mmap', '-ngl', '99']
    expect(dropMlockArgs(args)).toEqual({ args, dropped: false })
  })
})
