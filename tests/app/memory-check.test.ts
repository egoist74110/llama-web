import { describe, expect, test } from 'bun:test'
import t from '../../i18n/zh-CN'
import {
  barPercent, estimateTitle, gib, guardView, issueText, mainPool, memoryNoun, modelsOnCard, noRoomReasonTemplate, noteTexts, onlineSignature, poolRows, poolText, poolTitle,
  readStartGuard, saveNeedsConfirm, saveRiskView, summaryText, tierBar, tierClass, usesVram, type StartGuard,
} from '../../app/utils/memory-check'
import type { StateDoc } from '../../server/core/live'
import type { Breakdown, EstimateNote, MemoryEstimate, Pool, Tier } from '../../server/core/memory-estimate'
import type { CheckCode } from '../../server/core/model-check'

const GPU_WORDS = /GPU|显存|显卡|CUDA|Metal/
const zero: Breakdown = { weightsMiB: 0, kvMiB: 0, stateMiB: 0, computeMiB: 0, mmprojMiB: 0, draftMiB: 0, fixedMiB: 0, totalMiB: 0 }
const pool = (over: Partial<Pool>): Pool => ({ ...zero, id: 'CUDA0', name: 'RTX', kind: 'separate', budgetMiB: 10_000, ratio: 0.5, tier: 'ok', ...over })
const estimate = (pools: Pool[], tier: Tier = 'ok', notes: EstimateNote[] = []): MemoryEstimate => ({
  pools, tier, mlockMiB: 0, total: { ...zero, totalMiB: pools.reduce((n, p) => n + p.totalMiB, 0) }, notes,
  kv: { fullCells: 0, swaCells: 0, slots: 1, unified: true, ctx: 4096 },
})
const card = pool({ weightsMiB: 8000, kvMiB: 1000, computeMiB: 500, fixedMiB: 512, totalMiB: 10_012, ratio: 1.0012, tier: 'nofit' })
const host = pool({ id: 'host', name: '', kind: 'host', weightsMiB: 100, totalMiB: 100, budgetMiB: 20_000, ratio: 0.005 })
const unified = pool({ id: 'default', name: 'Apple M3', kind: 'shared', weightsMiB: 4000, kvMiB: 600, totalMiB: 4600, budgetMiB: 8000, ratio: 0.575 })

describe('tiers and titles', () => {
  test('every tier has a pill and a bar class', () => {
    expect(tierClass('ok')).toBe('lw-st-ready')
    expect(tierClass('risky')).toBe('lw-st-loading')
    expect(tierClass('nofit')).toBe('lw-st-failed')
    expect(tierClass('unknown')).toBe('lw-st-stopped')
    expect([tierBar('ok'), tierBar('risky'), tierBar('nofit'), tierBar('unknown')]).toEqual(['', 'warn', 'err', 'dim'])
  })
  test('video memory is only named for a card on a host that has GPUs', () => {
    const win = estimate([card, host])
    expect(usesVram(win, false)).toBe(true)
    expect(estimateTitle(win, false)).toBe(t.memory.titleVram)
    expect(estimateTitle(win, true)).toBe(t.memory.titleRam)
    expect(estimateTitle(estimate([host]), false)).toBe(t.memory.titleRam)
    expect(estimateTitle(estimate([unified]), true)).toBe(t.memory.titleRam)
    expect(estimateTitle(null, false)).toBe(t.memory.titleRam)
  })
  test('the noun of the memory a launch is judged against', () => {
    expect(memoryNoun('CUDA0', false)).toBe('显存')
    expect(memoryNoun('CUDA0', true)).toBe('内存')
    expect(memoryNoun('system', false)).toBe('内存')
    expect(memoryNoun(null, false)).toBe('内存')
  })
  test('pool titles', () => {
    expect(poolTitle(card, false)).toBe('RTX')
    expect(poolTitle(host, false)).toBe(t.memory.poolSystem)
    expect(poolTitle(unified, true)).toBe(t.memory.poolUnified)
  })
})

describe('size text', () => {
  test('GB from one gigabyte up, MiB below, ? when unknown', () => {
    expect(gib(30_720)).toBe('30.0 GB')
    expect(gib(1024)).toBe('1.0 GB')
    expect(gib(309.3)).toBe('309 MiB')
    expect(gib(0)).toBe('0 MiB')
    expect(gib(null)).toBe('?')
  })
})

describe('breakdown', () => {
  test('rows are the non-empty parts, biggest first', () => {
    expect(poolRows(card).map(r => r.key)).toEqual(['weights', 'kv', 'fixed', 'compute'])
    expect(poolRows(pool({ weightsMiB: 0.2 }))).toEqual([])
  })
  test('the deciding pool, the summary and the bar', () => {
    const est = estimate([host, card], 'nofit')
    expect(mainPool(est)?.id).toBe('CUDA0')
    expect(summaryText(est, false)).toBe('预估需要 9.8 GB，当前可用 9.8 GB（100%）')
    expect(barPercent(card)).toBe(100)
    expect(barPercent(pool({ ratio: 0.426 }))).toBe(43)
    expect(barPercent(pool({ ratio: null }))).toBe(0)
    expect(barPercent(null)).toBe(0)
    expect(barPercent(pool({ ratio: null, budgetMiB: 0, totalMiB: 500 }))).toBe(100)
    expect(barPercent(pool({ ratio: null, budgetMiB: 0, totalMiB: 0 }))).toBe(0)
    expect(summaryText(estimate([pool({ budgetMiB: null, ratio: null, tier: 'unknown', totalMiB: 2048 })], 'unknown'), false)).toBe('预估需要 2.0 GB，读不到当前可用的显存')
  })
  test('a Mac estimate never says GPU or video memory', () => {
    const est = estimate([unified], 'ok', ['unverified-separate-memory', 'unverified-multi-device', 'ctx-from-model'])
    expect(summaryText(est, true)).not.toMatch(GPU_WORDS)
    expect(noteTexts(est, true)).toEqual([t.memory.notes['ctx-from-model']])
    expect(noteTexts(est, false)).toHaveLength(3)
    for (const r of poolRows(unified)) expect(r.label).not.toMatch(GPU_WORDS)
    expect(poolTitle(unified, true)).not.toMatch(GPU_WORDS)
  })
})

describe('findings of the check', () => {
  const codes = Object.keys(t.models.check.issues) as CheckCode[]
  test('every code has a text and the details are filled in', () => {
    for (const code of codes) expect(issueText({ code, severity: 'warning', detail: { type: 'q4_0', ctx: 8, train: 4, ubatch: 2, batch: 1, layers: 99, mlockMiB: 1, availableMiB: 2, parallel: 4, perSlot: 100, kind: 'mmproj', mode: 'row', device: 'CUDA1' } }, false)).not.toMatch(/\{\w+\}/)
  })
  test('on a Mac the findings that could be reached read without GPU wording', () => {
    // `device-missing` is never judged on a Mac (model-check.ts skips it), `v-cache-needs-fa` etc. carry no GPU word.
    for (const code of codes.filter(c => c !== 'device-missing')) {
      expect(issueText({ code, severity: 'warning', detail: { type: 'q4_0', layers: 99, mode: 'row' } }, true)).not.toMatch(GPU_WORDS)
    }
    expect(issueText({ code: 'cpu-gpu-layers', severity: 'warning', detail: { layers: 99 } }, true)).toContain('99')
    expect(issueText({ code: 'cpu-gpu-layers', severity: 'warning', detail: { layers: 99 } }, false)).toContain('GPU')
  })
  test('saving asks only for a risky or not fitting estimate', () => {
    const est = estimate([card])
    expect(saveNeedsConfirm({ tier: 'risky', estimate: est })).toBe(true)
    expect(saveNeedsConfirm({ tier: 'nofit', estimate: est })).toBe(true)
    expect(saveNeedsConfirm({ tier: 'ok', estimate: est })).toBe(false)
    expect(saveNeedsConfirm({ tier: 'unknown', estimate: est })).toBe(false)
    expect(saveNeedsConfirm({ tier: 'nofit', estimate: null })).toBe(false)
    expect(saveNeedsConfirm(null)).toBe(false)
  })
  test('the save confirm names the memory of the deciding pool, never video memory on a Mac', () => {
    const win = saveRiskView(estimate([card, host], 'nofit'), 'nofit', false)
    expect(win.body).toContain('显存')
    expect(win.title).toBe(t.models.edit.risk.titleNofit)
    const mac = saveRiskView(estimate([unified], 'risky'), 'risky', true)
    expect(`${mac.title}${mac.body}${mac.summary}`).not.toMatch(GPU_WORDS)
    expect(mac.title).toBe(t.models.edit.risk.titleRisky)
  })
})

describe('refused manual start', () => {
  const refusal = (data: Record<string, unknown>, status = 409) => ({ statusCode: status, data: { statusCode: status, message: 'x', data } })
  test('reads the 409 of the server (statusCode and data.data.reason)', () => {
    expect(readStartGuard(refusal({ reason: 'nofit', tier: 'nofit', estimateMiB: 30_000, availableMiB: 20_000, pool: 'CUDA0' }))).toEqual({
      reason: 'nofit', limit: null, estimateMiB: 30_000, availableMiB: 20_000, pool: 'CUDA0',
    })
    expect(readStartGuard(refusal({ reason: 'limit', limit: 2 }))).toEqual({ reason: 'limit', limit: 2, estimateMiB: null, availableMiB: null, pool: null })
    expect(readStartGuard({ status: 409, data: { data: { reason: 'risky' } } })?.reason).toBe('risky')
  })
  test('anything else is not a guard', () => {
    expect(readStartGuard(refusal({ reason: 'nofit' }, 400))).toBeNull()
    expect(readStartGuard(refusal({ reason: 'weird' }))).toBeNull()
    expect(readStartGuard(refusal({}))).toBeNull()
    expect(readStartGuard(new Error('boom'))).toBeNull()
    expect(readStartGuard(null)).toBeNull()
  })
  const g = (reason: StartGuard['reason'], over: Partial<StartGuard> = {}): StartGuard => ({ reason, limit: 2, estimateMiB: 30_720, availableMiB: 20_480, pool: 'CUDA0', ...over })
  test('risky and unknown can be confirmed, does-not-fit and limit only stop the others first', () => {
    expect(guardView(g('risky'), 'M', false)).toMatchObject({ confirm: true, stopOthers: false })
    expect(guardView(g('unknown', { estimateMiB: null }), 'M', false)).toMatchObject({ confirm: true, stopOthers: false, detail: null })
    expect(guardView(g('nofit'), 'M', false)).toMatchObject({ confirm: false, stopOthers: true })
    expect(guardView(g('limit'), 'M', false)).toMatchObject({ confirm: false, stopOthers: true })
  })
  test('the texts carry the numbers and the model; the Mac reads without GPU wording', () => {
    const v = guardView(g('nofit'), '模型甲', false)
    expect(v.title).toContain('模型甲')
    expect(v.detail).toBe('预估需要 30.0 GB，当前可用 20.0 GB。')
    expect(v.body).toContain('显存')
    expect(guardView(g('limit'), 'M', false).body).toContain('2 个')
    for (const reason of ['limit', 'nofit', 'risky', 'unknown'] as const) {
      const m = guardView(g(reason, { pool: 'system' }), '模型甲', true)
      expect(`${m.title}${m.body}${m.detail ?? ''}`).not.toMatch(GPU_WORDS)
      expect(`${m.title}${m.body}`).not.toMatch(/\{\w+\}/)
    }
    // A Mac's pool is `system` even if a stale record said otherwise: the noun still comes from the platform.
    expect(guardView(g('risky', { pool: 'CUDA0' }), 'M', true).body).not.toMatch(GPU_WORDS)
  })
})

describe('events a Mac reads', () => {
  test('refused-load reasons and pool names', () => {
    expect(noRoomReasonTemplate('unknown', false)).toContain('显存')
    expect(noRoomReasonTemplate('unknown', true)).not.toMatch(GPU_WORDS)
    for (const r of ['memory', 'limit', 'watchdog'] as const) expect(noRoomReasonTemplate(r, true)).toBe(t.events.noRoomReason[r])
    expect(`${noRoomReasonTemplate('memory', true)}${noRoomReasonTemplate('limit', true)}${noRoomReasonTemplate('watchdog', true)}`).not.toMatch(GPU_WORDS)
    expect(poolText('system', true)).toBe(t.platform.mac.poolSystem)
    expect(poolText('system', false)).toBe(t.memory.poolSystem)
    expect(poolText('host', false)).toBe(t.memory.poolSystem)
    expect(poolText('CUDA1', false)).toBe('CUDA1')
    expect(t.platform.mac.poolSystem).not.toMatch(GPU_WORDS)
  })
})

describe('what is online', () => {
  const doc = (list: Array<[string, string, string]>): StateDoc => ({
    models: list.reduce<StateDoc['models']>((acc, [id, profile, state]) => {
      let m = acc.find(x => x.id === id)
      if (!m) { m = { id, name: id, activeProfile: profile, profiles: [profile], hasMmproj: false, needsSetup: false, files: { model: '', mmproj: null, draft: null }, missing: [], instances: [] }; acc.push(m) }
      m.instances.push({ profile, state: state as never, inflight: 0, error: null, failure: null, since: null, progress: null })
      return acc
    }, []),
  } as unknown as StateDoc)
  test('only loading / ready / draining count and the order does not matter', () => {
    expect(onlineSignature(null)).toBe('')
    expect(onlineSignature(doc([['b', 'p', 'ready'], ['a', 'p', 'loading'], ['c', 'p', 'failed'], ['d', 'p', 'unloading']]))).toBe('a:p:loading|b:p:ready')
    expect(onlineSignature(doc([['a', 'p', 'loading'], ['b', 'p', 'ready']]))).toBe(onlineSignature(doc([['b', 'p', 'ready'], ['a', 'p', 'loading']])))
    expect(onlineSignature(doc([['a', 'p', 'ready']]))).not.toBe(onlineSignature(doc([['a', 'p', 'draining']])))
  })
})

describe('models on a card', () => {
  const doc = (list: Array<[string, string, string]>) => ({
    models: list.map(([id, profile, state]) => ({ id, name: `Name ${id}`, instances: [{ profile, state }] })),
  }) as unknown as StateDoc
  const est = (...ids: string[]) => estimate([...ids.map(id => pool({ id })), host])
  const checks: Record<string, MemoryEstimate> = { 'a:p': est('CUDA0'), 'b:p': est('CUDA1'), 'c:p': est('CUDA0', 'CUDA1'), 'd:p': estimate([unified]) }
  const of = (id: string, profile: string) => checks[`${id}:${profile}`]
  test('each online model is named on the cards its check draws memory from', () => {
    const s = doc([['a', 'p', 'ready'], ['b', 'p', 'loading'], ['c', 'p', 'ready'], ['d', 'p', 'ready']])
    expect(modelsOnCard(s, of, 0)).toEqual(['Name a', 'Name c'])
    expect(modelsOnCard(s, of, 1)).toEqual(['Name b', 'Name c'])
    expect(modelsOnCard(s, of, 2)).toEqual([])
  })
  test('stopped / failed models, models without a check and no state name nothing', () => {
    expect(modelsOnCard(doc([['a', 'p', 'unloading'], ['b', 'p', 'failed']]), of, 0)).toEqual([])
    expect(modelsOnCard(doc([['x', 'p', 'ready']]), of, 0)).toEqual([])
    expect(modelsOnCard(null, of, 0)).toEqual([])
  })
})
