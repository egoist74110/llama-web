// Several models online (decisions 41, 42): the memory check before a load, serial loading, what a request does
// when the target does not fit (unload / refuse), a manual start that never unloads, and the single-model default.
import { describe, expect, test } from 'bun:test'
import {
  Scheduler, SchedulerError, type Admission, type ModelProcess, type NoRoomDetail, type SchedulerEvent, type Target,
} from '../../server/core/scheduler'

class FakeProc implements ModelProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<string>
  stopped = false
  alive = true
  private res!: () => void
  private exit!: (why: string) => void

  constructor(readonly target: Target, readonly port: number, readonly admission?: Admission) {
    this.ready = new Promise((a, b) => { this.res = a; this.rej = b })
    this.ready.catch(() => {})
    this.exited = new Promise(r => { this.exit = r })
  }

  private rej!: (e: unknown) => void
  succeed() { this.res() }
  crash() { this.die('crash') }
  stop() {
    this.stopped = true
    this.rej(new Error('aborted'))
    this.die('stopped')
    return this.exited
  }

  private die(why: string) {
    if (!this.alive) return
    this.alive = false
    this.exit(why)
  }
}

const T = (id: string): Target => ({ modelId: id, profile: 'p' })
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(T) as [Target, Target, Target, Target]
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await tick(2)
  }
}

interface Opts { max?: number, multi?: boolean, policy?: 'unload' | 'error', total?: number, need?: Record<string, number>, auto?: boolean, unknownWhen?: (t: Target, online: Target[]) => boolean }

/** A machine with `total` MiB; every model takes `need[id]` while its process is alive. */
function setup(o: Opts = {}) {
  const procs: FakeProc[] = []
  const events: SchedulerEvent[] = []
  const admitted: Target[] = []
  const total = o.total ?? 1000
  const need = o.need ?? { a: 400, b: 400, c: 400, d: 900 }
  const used = () => procs.filter(p => p.alive).reduce((n, p) => n + (need[p.target.modelId] ?? 0), 0)
  let port = 7100
  const sched = new Scheduler({
    maxLoaded: o.max ?? 5,
    multiLoad: o.multi ?? true,
    onNoRoom: o.policy ?? 'unload',
    onEvent: e => events.push(e),
    drainTimeoutMs: 2000,
    admit: async (target, online) => {
      admitted.push(target)
      if (o.unknownWhen?.(target, online)) return { tier: 'unknown', detail: { estimateMiB: null, availableMiB: null, pool: null }, pools: [] }
      const free = total - used()
      const n = need[target.modelId] ?? 0
      const tier = n <= 0.85 * free ? 'ok' : n <= free ? 'risky' : 'nofit'
      return { tier, detail: { estimateMiB: n, availableMiB: free, pool: 'CUDA0' }, pools: ['CUDA0'], data: { n } }
    },
    launch: async (target, admission) => {
      const p = new FakeProc(target, port++, admission)
      procs.push(p)
      if (o.auto !== false) queueMicrotask(() => p.succeed())
      return p
    },
  })
  const noRoom = () => events.filter((e): e is Extract<SchedulerEvent, { type: 'no-room' }> => e.type === 'no-room')
  return { sched, procs, events, admitted, noRoom, used }
}

const detailOf = (e: unknown) => (e as SchedulerError).cause as NoRoomDetail

describe('multi-load', () => {
  test('models that fit stay online together, nothing is unloaded', async () => {
    const { sched, procs } = setup()
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    expect(sched.stateOf(A)).toBe('ready')
    expect(sched.stateOf(B)).toBe('ready')
    expect(procs.every(p => !p.stopped)).toBe(true)
  })

  test('the admission is handed to the launcher and the pools show up in candidates()', async () => {
    const { sched, procs } = setup()
    ;(await sched.acquire(A)).release()
    expect(procs[0]!.admission?.data).toEqual({ n: 400 })
    expect(sched.candidates()).toMatchObject([{ target: A, state: 'ready', inflight: 0, pools: ['CUDA0'] }])
  })

  test('loads are serial: the next model is not launched before the previous one is ready', async () => {
    const { sched, procs } = setup({ auto: false })
    const pa = sched.acquire(A)
    const pb = sched.acquire(B)
    await until(() => procs.length === 1)
    await tick(30)
    expect(procs).toHaveLength(1)
    expect(sched.stateOf(B)).toBe('stopped')
    procs[0]!.succeed()
    await until(() => procs.length === 2)
    procs[1]!.succeed()
    ;(await pa).release()
    ;(await pb).release()
    expect(sched.stateOf(A)).toBe('ready')
    expect(sched.stateOf(B)).toBe('ready')
  })

  test('several requests for one target share one load and one check', async () => {
    const { sched, admitted } = setup()
    const ls = await Promise.all([sched.acquire(A), sched.acquire(A), sched.acquire(A)])
    ls.forEach(l => l.release())
    expect(admitted.filter(t => t.modelId === 'a')).toHaveLength(1)
  })

  test('risky is loaded (it is inside the free memory)', async () => {
    const { sched } = setup({ need: { a: 500, b: 480 } })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release() // 480 of 500 free: risky
    expect(sched.stateOf(B)).toBe('ready')
    expect(sched.stateOf(A)).toBe('ready')
  })

  test('a crash of one model leaves the others online', async () => {
    const { sched, procs } = setup()
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')
    expect(sched.stateOf(B)).toBe('ready')
    expect(procs[1]!.stopped).toBe(false)
  })
})

describe('a request that does not fit', () => {
  test('unload: the least recently used model goes, one at a time, until it fits', async () => {
    const { sched, procs, events } = setup({ total: 1000, need: { a: 300, b: 300, c: 300, d: 700 } })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    ;(await sched.acquire(C)).release()
    ;(await sched.acquire(A)).release() // order of use: B, C, A
    ;(await sched.acquire(D)).release() // 700 needs 700 free of 1000: B and C must go (A alone leaves 700)
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', false], ['b', true], ['c', true], ['d', false]])
    const made = events.filter((e): e is Extract<SchedulerEvent, { type: 'make-room' }> => e.type === 'make-room')
    expect(made.map(e => e.victim.modelId)).toEqual(['b', 'c'])
    expect(made[0]!.detail.reason).toBe('memory')
  })

  test('unload: stops as soon as it fits (the second model stays)', async () => {
    const { sched, procs } = setup({ total: 1000, need: { a: 300, b: 300, c: 500 } })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    ;(await sched.acquire(C)).release() // free 400, needs 500: A goes (free 700), B stays
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', true], ['b', false], ['c', false]])
  })

  test('error: refused with no-room and the numbers, nothing is unloaded', async () => {
    const { sched, procs, noRoom } = setup({ policy: 'error', total: 1000, need: { a: 600, b: 600 } })
    ;(await sched.acquire(A)).release()
    const e = await sched.acquire(B).catch(x => x)
    expect(e).toBeInstanceOf(SchedulerError)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e)).toEqual({ reason: 'memory', estimateMiB: 600, availableMiB: 400, pool: 'CUDA0' })
    expect(procs.map(p => p.stopped)).toEqual([false]) // A untouched
    expect(sched.stateOf(A)).toBe('ready')
    expect(sched.stateOf(B)).toBe('stopped')
    expect(noRoom()).toMatchObject([{ target: B, manual: false }])
  })

  test('error: the online limit is also a refusal, not an eviction', async () => {
    const { sched, procs } = setup({ policy: 'error', max: 1 })
    ;(await sched.acquire(A)).release()
    const e = await sched.acquire(B).catch(x => x)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e)).toMatchObject({ reason: 'limit', limit: 1 })
    expect(procs[0]!.stopped).toBe(false)
  })

  test('unload: the limit evicts the least recently used model, as in single mode', async () => {
    const { sched, procs } = setup({ max: 2 })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    ;(await sched.acquire(C)).release()
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', true], ['b', false], ['c', false]])
  })

  test('a model that is too big on its own is refused even with unload, after nothing else is left', async () => {
    const { sched, procs } = setup({ total: 1000, need: { a: 300, d: 1500 } })
    ;(await sched.acquire(A)).release()
    const e = await sched.acquire(D).catch(x => x)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e).reason).toBe('memory')
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', true]]) // it was unloaded in vain; nothing else to try
    expect(sched.stateOf(D)).toBe('stopped')
  })

  test('requests are served from the models that stay: a ready target never goes through the check', async () => {
    const { sched, admitted } = setup()
    ;(await sched.acquire(A)).release()
    const n = admitted.length
    ;(await sched.acquire(A)).release()
    expect(admitted).toHaveLength(n)
  })

  test('a request for a model that is still draining waits; nothing is refused for memory it is about to free', async () => {
    const { sched, procs } = setup({ total: 1000, need: { a: 600, b: 600 } })
    const lease = await sched.acquire(A)
    const pb = sched.acquire(B) // needs A's memory: A drains first (a request is running)
    await until(() => sched.stateOf(A) === 'draining')
    lease.release()
    ;(await pb).release()
    expect(procs[0]!.stopped).toBe(true)
    expect(sched.stateOf(B)).toBe('ready')
  })
})

describe('a manual start', () => {
  test('is refused when it does not fit and never unloads another model, whatever the policy', async () => {
    const { sched, procs, noRoom } = setup({ policy: 'unload', total: 1000, need: { a: 600, b: 600 } })
    ;(await sched.acquire(A)).release()
    const e = await sched.start(B).catch(x => x)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(procs.map(p => p.stopped)).toEqual([false])
    expect(noRoom()).toMatchObject([{ target: B, manual: true }])
  })

  test('is refused at the online limit', async () => {
    const { sched } = setup({ max: 1 })
    ;(await sched.acquire(A)).release()
    const e = await sched.start(B).catch(x => x)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e).reason).toBe('limit')
    expect(sched.stateOf(A)).toBe('ready')
  })

  test('starts when it fits (risky was confirmed in the interface before)', async () => {
    const { sched } = setup()
    await sched.start(A)
    await sched.start(B)
    expect([sched.stateOf(A), sched.stateOf(B)]).toEqual(['ready', 'ready'])
  })
})

describe('free memory that cannot be read', () => {
  test('a manual start goes on (the interface asked the user), a request next to other models does not', async () => {
    const { sched, noRoom } = setup({ policy: 'error', unknownWhen: () => true })
    await sched.start(A) // nothing else online: same as a single-model start
    const e = await sched.acquire(B).catch(x => x)
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e).reason).toBe('unknown')
    expect(sched.stateOf(A)).toBe('ready')
    expect(noRoom()).toHaveLength(1)
  })

  test('a request with nothing else online is loaded', async () => {
    const { sched } = setup({ policy: 'error', unknownWhen: () => true })
    ;(await sched.acquire(A)).release()
    expect(sched.stateOf(A)).toBe('ready')
  })

  test('unload policy: the others make room, then the request loads alone', async () => {
    const { sched, procs } = setup({ policy: 'unload', unknownWhen: (_t, online) => online.length > 0 })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    expect(procs[0]!.stopped).toBe(true)
    expect(sched.stateOf(B)).toBe('ready')
  })

  test('a check that throws counts as unknown', async () => {
    const sched = new Scheduler({
      multiLoad: true, onNoRoom: 'error', maxLoaded: 3, drainTimeoutMs: 100,
      admit: async () => { throw new Error('probe failed') },
      launch: async (t) => { const p = new FakeProc(t, 7100); queueMicrotask(() => p.succeed()); return p },
    })
    ;(await sched.acquire(A)).release()
    const e = await sched.acquire(B).catch(x => x)
    expect(detailOf(e).reason).toBe('unknown')
  })
})

describe('single-model default', () => {
  test('with multiLoad off the check is never made and the limit works as before', async () => {
    const { sched, admitted, procs } = setup({ multi: false, max: 1 })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    expect(admitted).toHaveLength(0)
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', true], ['b', false]])
    // A manual start of another model still switches to it (it is a switch, not a second model).
    await sched.start(C)
    expect(sched.stateOf(B)).toBe('stopped')
    expect(sched.stateOf(C)).toBe('ready')
  })

  test('settings changes apply to the next load (getters)', async () => {
    let multi = false
    const procs: FakeProc[] = []
    const sched = new Scheduler({
      get multiLoad() { return multi }, get maxLoaded() { return multi ? 3 : 1 }, onNoRoom: 'error', drainTimeoutMs: 100,
      admit: async () => ({ tier: 'ok', detail: { estimateMiB: 1, availableMiB: 99, pool: null }, pools: [] }),
      launch: async (t) => { const p = new FakeProc(t, 7100 + procs.length); procs.push(p); queueMicrotask(() => p.succeed()); return p },
    })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    expect(sched.stateOf(A)).toBe('stopped')
    multi = true
    ;(await sched.acquire(C)).release()
    ;(await sched.acquire(A)).release()
    expect([sched.stateOf(A), sched.stateOf(B), sched.stateOf(C)]).toEqual(['ready', 'ready', 'ready'])
  })
})

describe('unload() for the watchdog', () => {
  test('a ready model is drained and unloaded, the others stay', async () => {
    const { sched, procs } = setup()
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    expect(await sched.unload(B)).toBe(true)
    expect(procs.map(p => p.stopped)).toEqual([false, true])
    expect(sched.stateOf(B)).toBe('stopped')
    expect(await sched.unload(B)).toBe(false)
  })

  test('a load in progress is aborted and the waiting request is told why', async () => {
    const { sched, procs } = setup({ auto: false })
    const waiting = sched.acquire(A).catch(x => x)
    await until(() => procs.length === 1)
    const cause: NoRoomDetail = { reason: 'watchdog', estimateMiB: null, availableMiB: 12, pool: 'system' }
    expect(sched.candidates()).toMatchObject([{ target: A, state: 'loading' }])
    expect(await sched.unload(A, cause)).toBe(true)
    const e = await waiting
    expect((e as SchedulerError).code).toBe('no-room')
    expect(detailOf(e)).toEqual(cause)
    expect(sched.stateOf(A)).toBe('stopped')
  })

  test('idleOnly: a model with a request running is not unloaded, its lease is not aborted', async () => {
    const { sched, procs } = setup()
    const lease = await sched.acquire(A)
    expect(await sched.unload(A, null, { idleOnly: true })).toBe(false)
    expect(sched.stateOf(A)).toBe('ready')
    expect(procs[0]!.stopped).toBe(false)
    expect(lease.signal.aborted).toBe(false)
    lease.release()
    expect(await sched.unload(A, null, { idleOnly: true })).toBe(true)
    expect(sched.stateOf(A)).toBe('stopped')
  })

  test('candidates() carries load and use order', async () => {
    const { sched } = setup()
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    ;(await sched.acquire(A)).release()
    const [a, b] = sched.candidates()
    expect(a!.loadSeq).toBeLessThan(b!.loadSeq)
    expect(a!.useSeq).toBeGreaterThan(b!.useSeq)
  })
})
