import { describe, expect, test } from 'bun:test'
import {
  ModelCrashError, Scheduler, SchedulerError, type Lease, type ModelProcess, type SchedulerEvent, type Target,
} from '../../server/core/scheduler'

// ---------------------------------------------------------------------------------------
// Fake runner: every launch creates a FakeProc the test resolves / fails / crashes by hand.

class FakeProc implements ModelProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<string>
  stopped = false
  alive = true
  private res!: () => void
  private rej!: (e: unknown) => void
  private exit!: (why: string) => void

  constructor(readonly target: Target, readonly port: number) {
    this.ready = new Promise((a, b) => { this.res = a; this.rej = b })
    this.ready.catch(() => {})
    this.exited = new Promise(r => { this.exit = r })
  }

  succeed() { this.res() }
  fail(e: unknown = new Error('load failed')) { this.rej(e); this.die('failed') }
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

function setup(opts: { maxLoaded?: number, drainTimeoutMs?: number, autoReady?: boolean } = {}) {
  const procs: FakeProc[] = []
  const events: SchedulerEvent[] = []
  let port = 7100
  const sched = new Scheduler({
    maxLoaded: opts.maxLoaded ?? 1,
    drainTimeoutMs: opts.drainTimeoutMs ?? 5000,
    onEvent: e => events.push(e),
    launch: async (target) => {
      const p = new FakeProc(target, port++)
      procs.push(p)
      if (opts.autoReady) queueMicrotask(() => p.succeed())
      return p
    },
  })
  const states = (modelId: string) => events
    .filter((e): e is Extract<SchedulerEvent, { type: 'state' }> => e.type === 'state' && e.target.modelId === modelId)
    .map(e => e.to)
  return { sched, procs, events, states }
}

const A: Target = { modelId: 'a', profile: '默认' }
const B: Target = { modelId: 'b', profile: '默认' }
const C: Target = { modelId: 'c', profile: '默认' }

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

/** Wait until `cond` holds (flushing timers/microtasks), or fail. */
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await tick(1)
  }
}

async function settled<T>(p: Promise<T>): Promise<{ ok: true, value: T } | { ok: false, error: any }> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return { ok: false, error }
  }
}

function pending(p: Promise<unknown>) {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  return () => !done
}

// ---------------------------------------------------------------------------------------

describe('loading', () => {
  test('cold request loads the model, later requests go straight through', async () => {
    const { sched, procs, states } = setup()
    const p = sched.acquire(A)
    await until(() => procs.length === 1)
    expect(sched.stateOf(A)).toBe('loading')
    procs[0]!.succeed()
    const lease = await p
    expect(lease.port).toBe(7100)
    expect(sched.stateOf(A)).toBe('ready')

    const again = await sched.acquire(A)
    expect(again.port).toBe(7100)
    expect(procs.length).toBe(1)
    expect(states('a')).toEqual(['loading', 'ready'])
    lease.release('ok')
    again.release('ok')
  })

  test('concurrent requests for the same target share one load', async () => {
    const { sched, procs } = setup()
    const ps = [sched.acquire(A), sched.acquire(A), sched.acquire(A)]
    await until(() => procs.length === 1)
    const snap = sched.snapshot()
    expect(snap.queue).toEqual([{ modelId: 'a', profile: '默认', kind: 'load', started: true, waiting: 3 }])
    procs[0]!.succeed()
    const leases = await Promise.all(ps)
    expect(procs.length).toBe(1)
    expect(new Set(leases.map(l => l.port))).toEqual(new Set([7100]))
    expect(sched.snapshot().models[0]!.inflight).toBe(3)
    leases.forEach(l => l.release())
    expect(sched.snapshot().models[0]!.inflight).toBe(0)
  })

  test('a different profile of the same model is a separate target (restart)', async () => {
    const { sched, procs } = setup({ autoReady: true })
    const l1 = await sched.acquire(A)
    l1.release('ok')
    const l2 = await sched.acquire({ modelId: 'a', profile: 'RP' })
    expect(procs.length).toBe(2)
    expect(procs[0]!.stopped).toBe(true)
    expect(sched.stateOf(A)).toBe('stopped')
    expect(sched.stateOf({ modelId: 'a', profile: 'RP' })).toBe('ready')
    l2.release()
  })
})

describe('switching', () => {
  test('switch waits for in-flight requests; old model takes no new requests while draining', async () => {
    const { sched, procs, states } = setup({ autoReady: true })
    const la = await sched.acquire(A)

    const pb = sched.acquire(B)
    await until(() => sched.stateOf(A) === 'draining')
    expect(procs.length).toBe(1) // B not launched yet

    // A request for A while A is draining must not be served by the draining process.
    const pa2 = sched.acquire(A)
    const pa2Pending = pending(pa2)
    await tick(10)
    expect(pa2Pending()).toBe(true)
    expect(sched.snapshot().queue.map(q => q.modelId)).toEqual(['b', 'a'])

    la.release('ok')
    const lb = await pb
    expect(procs[0]!.stopped).toBe(true)
    expect(lb.port).toBe(7101)
    expect(states('a')).toEqual(['loading', 'ready', 'draining', 'unloading', 'stopped'])
    expect(states('b')).toEqual(['loading', 'ready'])

    // Queued A request now drains B (whose request is still running) — FIFO, no starvation.
    await until(() => sched.stateOf(B) === 'draining')
    expect(pa2Pending()).toBe(true)
    lb.release('ok')
    const la2 = await pa2
    expect(la2.port).toBe(7102)
    la2.release()
  })

  test('drain timeout force-unloads and aborts the stuck lease', async () => {
    const { sched, procs, events } = setup({ autoReady: true, drainTimeoutMs: 30 })
    const la = await sched.acquire(A)
    const lb = await sched.acquire(B) // never releases A
    expect(la.signal.aborted).toBe(true)
    expect(procs[0]!.stopped).toBe(true)
    expect(events.some(e => e.type === 'drain-timeout' && e.target.modelId === 'a' && e.inflight === 1)).toBe(true)
    la.release() // late release after force-unload is harmless
    lb.release()
  })

  test('draining ends early if the old process exits on its own', async () => {
    const { sched, procs } = setup({ autoReady: true, drainTimeoutMs: 60_000 })
    const la = await sched.acquire(A)
    const pb = sched.acquire(B)
    await until(() => sched.stateOf(A) === 'draining')
    procs[0]!.crash()
    const lb = await pb
    expect(la.signal.aborted).toBe(true)
    lb.release()
  })

  test('online limit > 1 evicts the least recently used model', async () => {
    const { sched, procs } = setup({ autoReady: true, maxLoaded: 2 })
    ;(await sched.acquire(A)).release()
    ;(await sched.acquire(B)).release()
    ;(await sched.acquire(A)).release() // A is now more recent than B
    ;(await sched.acquire(C)).release()
    expect(procs.map(p => [p.target.modelId, p.stopped])).toEqual([['a', false], ['b', true], ['c', false]])
    expect(sched.stateOf(A)).toBe('ready')
    expect(sched.stateOf(B)).toBe('stopped')
  })
})

test('invalid maxLoaded falls back to 1', () => {
  for (const v of [Number.NaN, 0, 1.5, 'x' as any]) expect(new Scheduler({ launch: async () => { throw new Error('unused') }, maxLoaded: v }).maxLoaded).toBe(1)
})

describe('failures', () => {
  test('precondition launch errors fail the request but leave the target stopped, not failed', async () => {
    class NoRuntime extends Error {}
    let installed = false
    let calls = 0
    const sched = new Scheduler({
      drainTimeoutMs: 1000,
      isPrecondition: e => e instanceof NoRuntime,
      launch: async (target) => {
        calls++
        if (!installed) throw new NoRuntime('llama.cpp still downloading')
        const p = new FakeProc(target, 7100)
        queueMicrotask(() => p.succeed())
        return p
      },
    })
    const e = await sched.acquire(A).catch(x => x)
    expect(e).toBeInstanceOf(SchedulerError)
    expect(e.code).toBe('failed')
    expect(e.cause).toBeInstanceOf(NoRuntime)
    expect(sched.stateOf(A)).toBe('stopped')
    installed = true
    const lease = await sched.acquire(A)
    expect(sched.stateOf(A)).toBe('ready')
    expect(calls).toBe(2)
    lease.release()
  })

  test('other launch errors still leave the target failed', async () => {
    const sched = new Scheduler({
      drainTimeoutMs: 1000,
      isPrecondition: () => false,
      launch: async () => { throw new Error('bad config') },
    })
    await sched.acquire(A).catch(() => {})
    expect(sched.stateOf(A)).toBe('failed')
  })

  test('load failure -> failed; waiters rejected; no auto retry until manual retry', async () => {
    const { sched, procs } = setup()
    const p1 = settled(sched.acquire(A))
    const p2 = settled(sched.acquire(A))
    await until(() => procs.length === 1)
    const cause = new Error('out of memory')
    procs[0]!.fail(cause)
    for (const r of [await p1, await p2]) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(SchedulerError)
        expect(r.error.code).toBe('failed')
        expect(r.error.cause).toBe(cause)
      }
    }
    expect(sched.stateOf(A)).toBe('failed')
    expect(sched.snapshot().models[0]!.error).toBe(cause)

    // Next request is rejected immediately without launching.
    const r3 = await settled(sched.acquire(A))
    expect(r3.ok).toBe(false)
    expect(procs.length).toBe(1)

    const retried = sched.retry(A)
    await until(() => procs.length === 2)
    procs[1]!.succeed()
    await retried
    expect(sched.stateOf(A)).toBe('ready')
  })

  test('launcher throwing (e.g. no free port) is a load failure', async () => {
    const sched = new Scheduler({ drainTimeoutMs: 100, launch: async () => { throw new Error('no-port') } })
    const r = await settled(sched.acquire(A))
    expect(r.ok).toBe(false)
    expect(sched.stateOf(A)).toBe('failed')
  })

  test('crash -> crashed; next request auto-reloads once', async () => {
    const { sched, procs, states } = setup({ autoReady: true })
    const l = await sched.acquire(A)
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')
    expect(l.signal.aborted).toBe(true)
    expect(l.signal.reason).toBeInstanceOf(ModelCrashError)
    l.release()

    const l2 = await sched.acquire(A)
    expect(procs.length).toBe(2)
    expect(states('a')).toEqual(['loading', 'ready', 'crashed', 'loading', 'ready'])
    l2.release('ok')
  })

  test('auto reload that fails to load -> failed, and stays failed', async () => {
    const { sched, procs } = setup()
    const p = sched.acquire(A)
    await until(() => procs.length === 1)
    procs[0]!.succeed()
    ;(await p).release('ok')
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')

    const r = settled(sched.acquire(A))
    await until(() => procs.length === 2)
    procs[1]!.fail()
    expect((await r).ok).toBe(false)
    expect(sched.stateOf(A)).toBe('failed')
    expect((await settled(sched.acquire(A))).ok).toBe(false)
    expect(procs.length).toBe(2)
  })

  test('crash again right after the auto reload (no successful request) -> failed', async () => {
    const { sched, procs } = setup({ autoReady: true })
    ;(await sched.acquire(A)).release('ok')
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')

    const l = await sched.acquire(A) // auto reload
    procs[1]!.crash() // e.g. the same prompt kills it again
    await until(() => sched.stateOf(A) !== 'ready')
    l.release()
    expect(sched.stateOf(A)).toBe('failed')
    expect((await settled(sched.acquire(A))).ok).toBe(false)
    expect(procs.length).toBe(2)
  })

  test('a crash after the auto reload -> failed, even if the reloaded process served requests', async () => {
    const { sched, procs } = setup({ autoReady: true })
    ;(await sched.acquire(A)).release('ok')
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')
    ;(await sched.acquire(A)).release('ok') // auto reload, served fine
    procs[1]!.crash()
    await until(() => sched.stateOf(A) !== 'ready')
    expect(sched.stateOf(A)).toBe('failed')
    expect((await settled(sched.acquire(A))).ok).toBe(false)
    expect(procs.length).toBe(2)
  })

  test('manual retry after that grants a new automatic reload', async () => {
    const { sched, procs } = setup({ autoReady: true })
    ;(await sched.acquire(A)).release('ok')
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')
    ;(await sched.acquire(A)).release('ok')
    procs[1]!.crash()
    await until(() => sched.stateOf(A) === 'failed')
    await sched.retry(A)
    procs[2]!.crash()
    await until(() => sched.stateOf(A) !== 'ready')
    expect(sched.stateOf(A)).toBe('crashed')
    ;(await sched.acquire(A)).release()
    expect(procs.length).toBe(4)
  })

  test('manual start after a crash is not counted as the automatic reload', async () => {
    const { sched, procs } = setup({ autoReady: true })
    ;(await sched.acquire(A)).release('ok')
    procs[0]!.crash()
    await until(() => sched.stateOf(A) === 'crashed')
    await sched.start(A)
    procs[1]!.crash()
    await until(() => sched.stateOf(A) !== 'ready')
    expect(sched.stateOf(A)).toBe('crashed')
  })
})

describe('cancellation and manual control', () => {
  test('cancelManual withdraws manual starters only; a job left with requests still loads', async () => {
    const { sched, procs } = setup({ autoReady: true })
    const la = await sched.acquire(A)
    const B2: Target = { modelId: 'b', profile: 'other' }
    const manualB = settled(sched.start(B)) // becomes the running job, waiting for A to drain
    const reqB = sched.acquire(B) // joins the same job
    const manualB2 = settled(sched.start(B2)) // queued behind it, manual only
    await until(() => sched.stateOf(A) === 'draining')
    expect(sched.cancelManual('b')).toBe(2)
    const [rb, rb2] = await Promise.all([manualB, manualB2])
    expect(rb.ok || rb.error.code).toBe('stopped')
    expect(rb2.ok || rb2.error.code).toBe('stopped')
    expect(sched.snapshot().queue.map(q => q.profile)).toEqual(['默认']) // B2 dropped, B kept for the request
    la.release()
    ;(await reqB).release()
    await tick(10)
    expect(procs.map(p => `${p.target.modelId}:${p.target.profile}`)).toEqual(['a:默认', 'b:默认'])
    expect(sched.cancelManual('b')).toBe(0)
  })

  test('aborted waiter is removed; a queued switch nobody waits for is dropped', async () => {
    const { sched, procs } = setup({ autoReady: true })
    const la = await sched.acquire(A)
    const pb = sched.acquire(B)
    await until(() => sched.stateOf(A) === 'draining')
    const ac = new AbortController()
    const pc = settled(sched.acquire(C, { signal: ac.signal }))
    await tick(5)
    ac.abort()
    const rc = await pc
    expect(rc.ok).toBe(false)
    if (!rc.ok) expect(rc.error.code).toBe('cancelled')
    expect(sched.snapshot().queue.map(q => q.modelId)).toEqual(['b'])

    la.release()
    ;(await pb).release()
    await tick(10)
    expect(procs.map(p => p.target.modelId)).toEqual(['a', 'b']) // C never launched
  })

  test('already-aborted signal rejects immediately', async () => {
    const { sched, procs } = setup()
    const ac = new AbortController()
    ac.abort()
    const r = await settled(sched.acquire(A, { signal: ac.signal }))
    expect(r.ok).toBe(false)
    await tick(5)
    expect(procs.length).toBe(0)
  })

  test('manual stop during loading aborts the load and rejects waiters with stopped', async () => {
    const { sched, procs } = setup()
    const p = settled(sched.acquire(A))
    await until(() => procs.length === 1)
    await sched.stop('a')
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('stopped')
    expect(procs[0]!.stopped).toBe(true)
    expect(sched.stateOf(A)).toBe('stopped')

    // Not marked failed: the next request loads normally.
    const p2 = sched.acquire(A)
    await until(() => procs.length === 2)
    procs[1]!.succeed()
    ;(await p2).release()
  })

  test('manual stop drains a ready model; force kills at once', async () => {
    const { sched, procs } = setup({ autoReady: true, drainTimeoutMs: 60_000 })
    const l = await sched.acquire(A)
    const stopping = sched.stop('a')
    await until(() => sched.stateOf(A) === 'draining')
    await sched.stop('a', { force: true })
    await stopping
    expect(l.signal.aborted).toBe(true)
    expect(procs[0]!.stopped).toBe(true)
    expect(sched.stateOf(A)).toBe('stopped')
  })

  test('manual stop rejects queued requests for that model', async () => {
    const { sched } = setup({ autoReady: true })
    const la = await sched.acquire(A)
    const pb = settled(sched.acquire(B))
    const pb2 = settled(sched.acquire(B))
    await until(() => sched.stateOf(A) === 'draining')
    await sched.stop('b')
    la.release()
    for (const r of [await pb, await pb2]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('stopped')
    }
    expect(sched.stateOf(B)).toBe('stopped')
  })

  test('manual stop clears failed state', async () => {
    const { sched, procs } = setup()
    const p = settled(sched.acquire(A))
    await until(() => procs.length === 1)
    procs[0]!.fail()
    await p
    expect(sched.stateOf(A)).toBe('failed')
    await sched.stop('a')
    expect(sched.stateOf(A)).toBe('stopped')
  })

  test('shutdown kills everything and rejects waiters', async () => {
    const { sched, procs } = setup({ autoReady: true, drainTimeoutMs: 60_000 })
    const la = await sched.acquire(A)
    const pb = settled(sched.acquire(B))
    await until(() => sched.stateOf(A) === 'draining')
    await sched.shutdown()
    const r = await pb
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['shutdown', 'stopped']).toContain(r.error.code)
    expect(la.signal.aborted).toBe(true)
    expect(procs.every(p => !p.alive)).toBe(true)
    expect(procs.length).toBe(1)
    expect((await settled(sched.acquire(A))).ok).toBe(false)
  })
})

test('leases survive a model going away without throwing', async () => {
  const { sched, procs } = setup({ autoReady: true })
  const l: Lease = await sched.acquire(A)
  procs[0]!.crash()
  await until(() => sched.stateOf(A) === 'crashed')
  expect(l.port).toBe(7100)
  expect(() => l.release()).not.toThrow()
  expect(() => l.release()).not.toThrow()
})
