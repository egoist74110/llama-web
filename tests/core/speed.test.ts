import { describe, expect, test } from 'bun:test'
import { countEvents, SpeedMeter } from '../../server/core/speed'

const enc = (s: string) => new TextEncoder().encode(s)

describe('countEvents', () => {
  test('counts SSE events, also when chunks split anywhere', () => {
    expect(countEvents(enc('data: {"a":1}\n\ndata: {"a":2}\n\n'), true)).toEqual({ events: 2, atLineStart: true })
    const first = countEvents(enc('data: {"a":1}\n\ndata: {"a'), true)
    expect(first).toEqual({ events: 2, atLineStart: false })
    const second = countEvents(enc('":2}\n\n'), first.atLineStart)
    expect(second).toEqual({ events: 0, atLineStart: true })
    // chunk boundary exactly after the newline
    const a = countEvents(enc('data: {"x":1}\n\n'), true)
    expect(countEvents(enc('data: {"x":2}\n\n'), a.atLineStart).events).toBe(1)
  })

  test('generated text cannot fake an event (JSON has no raw newline)', () => {
    const chunk = enc('data: {"choices":[{"delta":{"content":"x\\ndata: y"}}]}\n\n')
    expect(countEvents(chunk, true).events).toBe(1)
  })

  test('works on a view into a larger buffer', () => {
    const big = enc('xxxxdata: {"a":1}\n\nyyyy')
    expect(countEvents(big.subarray(4, 4 + 'data: {"a":1}\n\n'.length), true).events).toBe(1)
  })
})

describe('SpeedMeter', () => {
  function setup(windowMs = 3000) {
    let clock = 10_000
    const meter = new SpeedMeter({ now: () => clock, windowMs })
    const tokens = (n: number) => enc('data: {"t":1}\n\n'.repeat(n))
    return { meter, tick: (ms: number) => { clock += ms }, tokens }
  }

  test('prompt phase until the first token, then a tokens/s estimate', () => {
    const { meter, tick, tokens } = setup()
    meter.begin(1, 'm', 'default')
    expect(meter.snapshot().active).toEqual([{ requestId: 1, modelId: 'm', profile: 'default', phase: 'prompt', tokensPerSec: null, tokens: 0 }])
    meter.chunk(1, tokens(1))
    expect(meter.snapshot().active[0]).toMatchObject({ phase: 'generating', tokensPerSec: null, tokens: 1 })
    for (let i = 0; i < 10; i++) { tick(100); meter.chunk(1, tokens(1)) }
    const a = meter.snapshot().active[0]!
    expect(a.tokens).toBe(11)
    expect(a.tokensPerSec).toBe(10) // 10 tokens in 1 s
  })

  test('only the recent window counts', () => {
    const { meter, tick, tokens } = setup(1000)
    meter.begin(1, 'm', 'default')
    meter.chunk(1, tokens(1))
    for (let i = 0; i < 10; i++) { tick(100); meter.chunk(1, tokens(1)) } // 10 t/s
    for (let i = 0; i < 20; i++) { tick(50); meter.chunk(1, tokens(1)) } // then 20 t/s
    expect(meter.snapshot().active[0]!.tokensPerSec).toBeGreaterThan(18)
  })

  test('end: llama-server timings replace the estimate', () => {
    const { meter, tick, tokens } = setup()
    meter.begin(1, 'm', 'default')
    meter.chunk(1, tokens(1))
    tick(100)
    meter.chunk(1, tokens(5))
    meter.end(1, { promptPerSecond: 321.5, predictedPerSecond: 44.2 })
    const s = meter.snapshot()
    expect(s.active).toEqual([])
    expect(s.last).toEqual([{ modelId: 'm', profile: 'default', at: 10_100, promptPerSec: 321.5, generationPerSec: 44.2, estimated: false }])
  })

  test('end without timings falls back to the whole-run average, flagged as an estimate', () => {
    const { meter, tick, tokens } = setup()
    meter.begin(1, 'm', 'default')
    meter.chunk(1, tokens(1))
    tick(1000)
    meter.chunk(1, tokens(10))
    meter.end(1, null)
    expect(meter.snapshot().last[0]).toMatchObject({ promptPerSec: null, generationPerSec: 10, estimated: true })
  })

  test('a request that produced nothing leaves no last speed; record() keeps non-stream timings', () => {
    const { meter } = setup()
    meter.begin(1, 'm', 'default')
    meter.end(1, null)
    expect(meter.snapshot().last).toEqual([])
    meter.record('m', 'default', { promptPerSecond: 10, predictedPerSecond: null })
    expect(meter.snapshot().last[0]).toMatchObject({ promptPerSec: 10, generationPerSec: null, estimated: false })
    meter.record('m', 'default', null)
    expect(meter.snapshot().last).toHaveLength(1)
  })

  test('unknown request ids are ignored and listener errors do not escape', () => {
    const m = new SpeedMeter({ onChange: () => { throw new Error('boom') } })
    expect(() => { m.begin(1, 'a', 'b'); m.chunk(9, enc('data: x\n\n')); m.end(9, null); m.end(1, null) }).not.toThrow()
  })

  test('keeps the last speed per model and profile', () => {
    const { meter } = setup()
    meter.record('m', 'a', { promptPerSecond: 1, predictedPerSecond: 2 })
    meter.record('m', 'b', { promptPerSecond: 3, predictedPerSecond: 4 })
    meter.record('m', 'a', { promptPerSecond: 5, predictedPerSecond: 6 })
    expect(meter.snapshot().last.map(l => [l.profile, l.promptPerSec])).toEqual([['a', 5], ['b', 3]])
  })
})
