import { describe, expect, test } from 'bun:test'
import { defaultSettings, type Settings } from '../../server/core/config'
import { applyRetune, planRetune, withoutLegacyFlags } from '../../server/core/retune'
import type { TuneInput } from '../../server/core/config'

const GiB = 1024
const mac = (gib: number): TuneInput => ({ os: 'darwin', memory: { totalMiB: gib * GiB } })
const win = (ramGiB: number, cards: number[]): TuneInput => ({
  os: 'win32', memory: { totalMiB: ramGiB * GiB },
  nvidia: cards.length ? { state: 'ok', gpus: cards.map(g => ({ memoryMiB: g * GiB })) } : { state: 'absent', gpus: [] },
})
const MAC = { os: 'darwin' as const }
const WIN = { os: 'win32' as const }
const fresh = (host: { os: NodeJS.Platform }) => structuredClone(defaultSettings({ os: host.os, acceleration: host.os === 'win32' ? 'cuda' : 'metal' } as never))

describe('withoutLegacyFlags', () => {
  test('drops only the four legacy flags and keeps the rest', () => {
    expect(withoutLegacyFlags('--jinja --props --slots -cb --no-prefill-assistant --load-mode mlock')).toBe('--no-prefill-assistant --load-mode mlock')
    expect(withoutLegacyFlags('--no-prefill-assistant')).toBeNull()
    expect(withoutLegacyFlags('--jinja')).toBe('')
    expect(withoutLegacyFlags('--chat-template-file "C:\\a b\\t.jinja" -cb')).toBe('--chat-template-file "C:\\a b\\t.jinja"')
    expect(withoutLegacyFlags('--x "unterminated')).toBeNull()
  })
})

describe('planRetune', () => {
  test('tier boundaries follow the first-run tiers (Mac memory, Windows VRAM)', () => {
    const s = fresh(MAC)
    s.defaults.ctxSize = 1
    s.defaults.batchSize = 1
    s.defaults.ubatchSize = 1
    const ctx = (gib: number) => planRetune(s, mac(gib), MAC).items.find(i => i.field === 'ctxSize')!.to
    expect([ctx(11.9), ctx(12), ctx(23.9), ctx(24), ctx(48), ctx(96)]).toEqual([8192, 32768, 32768, 65536, 131072, 262144])
    const w = fresh(WIN)
    w.defaults.ctxSize = 1
    const vram = (gib: number) => planRetune(w, win(32, [gib]), WIN).items.find(i => i.id === 'defaults.ctxSize')!.to
    expect([vram(7.9), vram(8), vram(12), vram(16), vram(24), vram(48)]).toEqual([8192, 16384, 32768, 65536, 131072, 262144])
  })

  test('values already recommended are not listed; unknown hardware recommends nothing', () => {
    const s = fresh(MAC)
    const first = planRetune(s, mac(32), MAC)
    for (const i of first.items) (s.defaults as unknown as Record<string, unknown>)[i.field] = i.to
    expect(planRetune(s, mac(32), MAC)).toEqual({ detected: true, items: [] })
    expect(planRetune(s, { os: 'darwin', memory: { totalMiB: 0 } }, MAC)).toEqual({ detected: false, items: [] })
  })

  test('Mac has one default set; Windows has GPU and CPU sets', () => {
    const m = planRetune(fresh(MAC), mac(8), MAC)
    expect(new Set(m.items.map(i => i.scope))).toEqual(new Set(['defaults']))
    const w = fresh(WIN)
    w.defaultsCpu.ctxSize = 1
    w.defaults.ctxSize = 1
    const scopes = new Set(planRetune(w, win(32, [24]), WIN).items.map(i => i.scope))
    expect(scopes).toEqual(new Set(['defaults', 'defaultsCpu']))
  })

  test('legacy extra args are offered as their own item', () => {
    const s = fresh(MAC)
    s.defaults.extraArgs = '--jinja --props --slots -cb --no-prefill-assistant'
    const item = planRetune(s, mac(32), MAC).items.find(i => i.id === 'defaults.extraArgs')!
    expect(item.to).toBe('--no-prefill-assistant')
    expect(item.from).toBe('--jinja --props --slots -cb --no-prefill-assistant')
  })
})

describe('applyRetune', () => {
  const old = (): Settings => {
    const s = fresh(WIN)
    s.defaults.ctxSize = 4096
    s.defaults.batchSize = 256
    s.defaults.extraArgs = '--jinja -cb --keep-me'
    s.defaultsCpu.ctxSize = 4096
    s.setup.tuned = false
    return s
  }

  test('planning never writes', () => {
    const s = old()
    const before = JSON.stringify(s)
    planRetune(s, win(32, [24]), WIN)
    expect(JSON.stringify(s)).toBe(before)
  })

  test('only the ticked items change', () => {
    const s = old()
    const before = structuredClone(s)
    expect(applyRetune(s, win(32, [24]), WIN, ['defaults.ctxSize', 'defaults.extraArgs'])).toBe(2)
    expect(s.defaults.ctxSize).toBe(131072)
    expect(s.defaults.extraArgs).toBe('--keep-me')
    expect(s.defaults.batchSize).toBe(before.defaults.batchSize)
    expect(s.defaultsCpu).toEqual(before.defaultsCpu)
  })

  test('nothing ticked, or ids not in the plan: nothing changes', () => {
    const s = old()
    const before = JSON.stringify(s)
    expect(applyRetune(s, win(32, [24]), WIN, [])).toBe(0)
    expect(applyRetune(s, win(32, [24]), WIN, ['defaults.gpuLayers', 'nope'])).toBe(0)
    expect(JSON.stringify(s)).toBe(before)
  })

  test('Mac writes the single default set and never touches defaultsCpu', () => {
    const s = fresh(MAC)
    s.defaults.ctxSize = 1
    const cpu = structuredClone(s.defaultsCpu)
    expect(applyRetune(s, mac(64), MAC, ['defaults.ctxSize', 'defaultsCpu.ctxSize'])).toBe(1)
    expect(s.defaults.ctxSize).toBe(131072)
    expect(s.defaultsCpu).toEqual(cpu)
  })
})
