// Run-time guard (decision 44): free memory below 5% stops the newest model without running requests, then the least
// recently used idle ones, one per round; busy models and unreadable memory stop nothing.
import { describe, expect, test } from 'bun:test'
import type { Candidate, NoRoomDetail, Target } from '../../server/core/scheduler'
import { DANGER_FREE_RATIO, Watchdog, type PoolReading } from '../../server/core/watchdog'

const T = (id: string): Target => ({ modelId: id, profile: 'p' })
const cand = (id: string, o: Partial<Candidate> = {}): Candidate =>
  ({ target: T(id), state: 'ready', inflight: 0, loadSeq: 1, useSeq: 1, pools: ['CUDA0'], ...o })

function setup(cands: Candidate[], readings: () => PoolReading[] | null, enabled = () => true) {
  const live = [...cands]
  const stops: Array<{ target: Target, cause: NoRoomDetail }> = []
  const events: any[] = []
  const dog = new Watchdog({
    sample: async () => readings(),
    candidates: () => live,
    unload: async (target, cause, opts) => {
      const i = live.findIndex(c => c.target.modelId === target.modelId)
      if (i < 0) return false
      if (opts.idleOnly && live[i]!.inflight > 0) return false
      live.splice(i, 1)
      stops.push({ target, cause })
      return true
    },
    enabled, onEvent: e => events.push(e),
  })
  return { dog, stops, events, live }
}

const pool = (id: string, totalMiB: number, freeMiB: number): PoolReading => ({ id, totalMiB, freeMiB })

describe('Watchdog', () => {
  test('the danger line is 5% free', () => {
    expect(DANGER_FREE_RATIO).toBe(0.05)
  })

  test('enough memory: nothing happens', async () => {
    const { dog, stops } = setup([cand('a')], () => [pool('CUDA0', 24000, 1300)]) // 5.4%
    expect(await dog.tick()).toBeNull()
    expect(stops).toEqual([])
  })

  test('below 5%: the model loaded last is stopped first, with the numbers in the cause', async () => {
    const { dog, stops, events } = setup([cand('old', { loadSeq: 1 }), cand('new', { loadSeq: 3 }), cand('mid', { loadSeq: 2 })], () => [pool('CUDA0', 24000, 1000)])
    expect(await dog.tick()).toEqual(T('new'))
    expect(stops).toHaveLength(1)
    expect(stops[0]!.cause).toEqual({ reason: 'watchdog', estimateMiB: null, availableMiB: 1000, pool: 'CUDA0' })
    expect(events[0]).toMatchObject({ kind: 'watchdog', modelId: 'new', profile: 'p', pool: 'CUDA0', state: 'stopped' })
    expect(Math.round(events[0].freePercent)).toBe(4)
  })

  test('still short next round: the least recently used idle model follows, one per round', async () => {
    const { dog, stops, live } = setup([
      cand('a', { loadSeq: 1, useSeq: 9 }), cand('b', { loadSeq: 2, useSeq: 3 }), cand('c', { loadSeq: 3, useSeq: 5 }),
    ], () => [pool('CUDA0', 24000, 500)])
    await dog.tick() // newest: c
    await dog.tick() // least recently used: b
    expect(stops.map(s => s.target.modelId)).toEqual(['c', 'b'])
    expect(live.map(c => c.target.modelId)).toEqual(['a'])
  })

  test('the memory comes back, then goes again later: the newest one is picked again', async () => {
    let free = 500
    const { dog, stops } = setup([cand('a', { loadSeq: 1 }), cand('b', { loadSeq: 2 }), cand('c', { loadSeq: 3, useSeq: 0 })], () => [pool('CUDA0', 24000, free)])
    await dog.tick() // c
    free = 5000
    await dog.tick() // calm: resets
    free = 400
    await dog.tick() // newest again: b
    expect(stops.map(s => s.target.modelId)).toEqual(['c', 'b'])
  })

  test('a model with requests running is never stopped; the user is told once', async () => {
    const { dog, stops, events } = setup([cand('a', { inflight: 2 })], () => [pool('system', 16000, 100)])
    expect(await dog.tick()).toBeNull()
    expect(await dog.tick()).toBeNull()
    expect(stops).toEqual([])
    expect(events).toMatchObject([{ kind: 'watchdog', state: 'blocked', modelId: null, pool: 'system' }])
  })

  test('an idle model is chosen over a busy newer one', async () => {
    const { dog, stops } = setup([cand('idle', { loadSeq: 1 }), cand('busy', { loadSeq: 2, inflight: 1 })], () => [pool('system', 16000, 100)])
    await dog.tick()
    expect(stops.map(s => s.target.modelId)).toEqual(['idle'])
  })

  test('a short card only costs the models that use it; system memory costs any', async () => {
    const onOther = cand('other', { loadSeq: 5, pools: ['CUDA1'] })
    const onCard = cand('card', { loadSeq: 1, pools: ['CUDA0'] })
    const a = setup([onCard, onOther], () => [pool('CUDA0', 24000, 300), pool('CUDA1', 24000, 20000), pool('system', 32000, 20000)])
    await a.dog.tick()
    expect(a.stops.map(s => s.target.modelId)).toEqual(['card'])
    const b = setup([onCard, onOther], () => [pool('CUDA0', 24000, 20000), pool('system', 32000, 800)])
    await b.dog.tick()
    expect(b.stops.map(s => s.target.modelId)).toEqual(['other'])
  })

  test('a model whose pools are not known is eligible for any pool', async () => {
    const { dog, stops } = setup([cand('x', { pools: [] })], () => [pool('CUDA0', 24000, 100)])
    await dog.tick()
    expect(stops).toHaveLength(1)
  })

  test('the worst pool decides', async () => {
    const { dog, events } = setup([cand('a', { pools: ['CUDA0', 'CUDA1'] })], () => [pool('CUDA0', 24000, 1000), pool('CUDA1', 24000, 200)])
    await dog.tick()
    expect(events[0].pool).toBe('CUDA1')
  })

  test('unreadable memory, switched off, or nothing online: no sampling effect, nothing stopped', async () => {
    const a = setup([cand('a')], () => null)
    expect(await a.dog.tick()).toBeNull()
    let sampled = 0
    const b = setup([cand('a')], () => { sampled++; return [pool('system', 100, 1)] }, () => false)
    expect(await b.dog.tick()).toBeNull()
    expect(sampled).toBe(0)
    const c = setup([], () => { sampled++; return [pool('system', 100, 1)] })
    expect(await c.dog.tick()).toBeNull()
    expect(sampled).toBe(0)
    expect(a.stops.length + b.stops.length + c.stops.length).toBe(0)
  })

  test('a reading that throws does not break the guard; rounds do not overlap', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const dog = new Watchdog({
      sample: async () => { calls++; await gate; return [pool('system', 100, 1)] },
      candidates: () => [cand('a')], unload: async () => true, enabled: () => true, onEvent: () => {},
    })
    const first = dog.tick()
    expect(await dog.tick()).toBeNull() // the first round is still reading
    release()
    await first
    expect(calls).toBe(1)
    const bad = new Watchdog({ sample: async () => { throw new Error('x') }, candidates: () => [cand('a')], unload: async () => true, enabled: () => true, onEvent: () => {} })
    expect(await bad.tick()).toBeNull()
  })

  test('start() / stop() run the timer', async () => {
    let n = 0
    const dog = new Watchdog({ sample: async () => { n++; return [pool('system', 100, 50)] }, candidates: () => [cand('a')], unload: async () => true, enabled: () => true, onEvent: () => {}, intervalMs: 10 })
    dog.start()
    dog.start()
    await Bun.sleep(60)
    dog.stop()
    const seen = n
    expect(seen).toBeGreaterThan(1)
    await Bun.sleep(40)
    expect(n).toBe(seen)
  })

  test('the most endangered pool has only busy models: another pool in danger is still handled', async () => {
    const { dog, stops } = setup(
      [cand('gpu', { inflight: 1, pools: ['CUDA0'] }), cand('cpu', { pools: [] })],
      () => [pool('CUDA0', 24000, 20), pool('system', 16000, 300)],
    )
    expect(await dog.tick()).toEqual(T('cpu'))
    expect(stops.map(s => s.target.modelId)).toEqual(['cpu'])
  })

  test('blocked is told only when no pool in danger has a model that can be stopped', async () => {
    const { dog, stops, events } = setup([cand('gpu', { inflight: 1 })], () => [pool('CUDA0', 24000, 20), pool('system', 16000, 300)])
    expect(await dog.tick()).toBeNull()
    expect(stops).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ state: 'blocked', pool: 'CUDA0' })
  })

  test('a request that starts while the memory is being read protects its model', async () => {
    const live = [cand('a')]
    const stops: string[] = []
    const dog = new Watchdog({
      sample: async () => { live[0]!.inflight = 1; return [pool('CUDA0', 24000, 100)] },
      candidates: () => live.map(c => ({ ...c })),
      unload: async (t, _c, opts) => { if (opts.idleOnly && live[0]!.inflight > 0) return false; stops.push(t.modelId); return true },
      enabled: () => true, onEvent: () => {},
    })
    expect(await dog.tick()).toBeNull()
    expect(stops).toEqual([])
  })

  test('a request that arrives between the pick and the unload makes the unload refuse; nothing is reported stopped', async () => {
    const { dog, stops, events, live } = setup([cand('a')], () => [pool('CUDA0', 24000, 100)])
    const orig = (dog as any).deps.candidates
    ;(dog as any).deps.candidates = () => { const r = orig(); live[0]!.inflight = 1; return r.map((c: Candidate) => ({ ...c, inflight: 0 })) }
    expect(await dog.tick()).toBeNull()
    expect(stops).toEqual([])
    expect(events).toEqual([])
  })
})
