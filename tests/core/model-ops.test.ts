import { describe, expect, test } from 'bun:test'
import { ModelOps } from '../../server/core/model-ops'
import { Scheduler, SchedulerError, type ModelProcess, type Target } from '../../server/core/scheduler'

// Fake process that becomes ready on the next microtask and exits when stopped.
class FakeProc implements ModelProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<string>
  private exit!: (why: string) => void
  private alive = true

  constructor(readonly target: Target, readonly port: number, ready: Promise<void> = Promise.resolve()) {
    this.ready = ready
    this.exited = new Promise(r => { this.exit = r })
  }

  stop() {
    if (this.alive) { this.alive = false; this.exit('stopped') }
    return this.exited
  }

  get stopped() { return !this.alive }
}

/** `gate`: launches stay loading until `open()`. `config` is read at launch, like the real launcher. */
function setup(opts: { gate?: boolean } = {}) {
  const launched: string[] = []
  const procs: FakeProc[] = []
  const config = { ctx: 4096 }
  const launchedWith: number[] = []
  let gate: (() => void) | null = null
  let port = 7100
  const sched = new Scheduler({
    maxLoaded: 1,
    drainTimeoutMs: 5000,
    launch: async (t) => {
      launched.push(t.profile)
      launchedWith.push(config.ctx)
      const ready = opts.gate ? new Promise<void>((r) => { gate = r }) : undefined
      const p = new FakeProc(t, port++, ready)
      procs.push(p)
      return p
    },
  })
  const ops = new ModelOps(sched)
  const states = () => sched.snapshot().models.filter(s => s.modelId === 'm').map(s => `${s.profile}:${s.state}`)
  const open = () => { gate?.(); gate = null }
  return { sched, ops, launched, states, procs, config, launchedWith, open }
}

const at = (profile: string): Target => ({ modelId: 'm', profile })
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await tick(2)
  }
}

describe('ModelOps.switchTo', () => {
  test('A -> B -> A while A drains ends on A; the superseded restart does not start B', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('A'))
    const lease = await sched.acquire(at('A'))

    const toB = ops.switchTo('m', 'B')
    expect(toB.restarted).toBe(true)
    await tick()
    expect(states()).toEqual(['A:draining'])

    const toA = ops.switchTo('m', 'A')
    expect(toA.restarted).toBe(true)
    lease.release()
    await Promise.all([toB.work, toA.work])

    expect(states()).toEqual(['A:ready'])
    expect(launched).not.toContain('B')
    await sched.shutdown()
  })

  test('manual stop while a restart waits for the drain cancels the restart', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('A'))
    const lease = await sched.acquire(at('A'))
    const { work } = ops.switchTo('m', 'B')
    await tick()
    const stopped = ops.stop('m')
    lease.release()
    await Promise.all([work, stopped])
    expect(states()).toEqual([])
    expect(launched).toEqual(['A'])
    await sched.shutdown()
  })

  test('already serving the profile: nothing to do; stopped model: only clears marks', async () => {
    const { sched, ops } = setup()
    await sched.start(at('A'))
    expect(ops.switchTo('m', 'A')).toEqual({ restarted: false, work: null })
    await ops.stop('m')
    expect(ops.switchTo('m', 'B')).toEqual({ restarted: false, work: null })
    await sched.shutdown()
  })

  test('a manual start still queued (another model draining) is replaced by the new profile', async () => {
    const { sched, ops, launched, states } = setup()
    const other: Target = { modelId: 'other', profile: 'A' }
    await sched.start(other)
    const lease = await sched.acquire(other)
    const started = ops.start(at('A')).catch(e => e)
    await tick()
    expect(sched.snapshot().queue.map(q => `${q.modelId}:${q.profile}`)).toEqual(['m:A'])
    expect(states()).toEqual([])

    const { restarted, work } = ops.switchTo('m', 'B')
    expect(restarted).toBe(true)
    await tick()
    // The withdrawn job no longer shows as queued, nor blocks renaming A.
    expect(sched.snapshot().queue.map(q => `${q.modelId}:${q.profile}`)).toEqual(['m:B'])
    expect(ops.inUseProfiles('m')).toEqual(['B'])
    lease.release()
    await work
    expect((await started as SchedulerError).code).toBe('stopped')
    expect(states()).toEqual(['B:ready'])
    expect(launched).toEqual(['A', 'B']) // other:A, then m:B — m:A never launched
    await sched.shutdown()
  })

  test('a queued request (not a manual start) keeps its profile when the current one changes', async () => {
    const { sched, ops, states } = setup()
    const other: Target = { modelId: 'other', profile: 'A' }
    await sched.start(other)
    const lease = await sched.acquire(other)
    const request = sched.acquire(at('A'))
    await tick()
    expect(ops.switchTo('m', 'B')).toEqual({ restarted: false, work: null })
    lease.release()
    ;(await request).release()
    expect(states()).toEqual(['A:ready'])
    await sched.shutdown()
  })

  test('switching while the same model drains keeps a queued client request (manual start withdrawn)', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('H'))
    const leaseH = await sched.acquire(at('H'))
    const manualA = ops.start(at('A')).catch(e => e)
    const clientA = sched.acquire(at('A'))
    await tick()
    expect(states()).toEqual(['H:draining'])

    const { restarted, work } = ops.switchTo('m', 'B')
    expect(restarted).toBe(true)
    leaseH.release()
    const leaseA = await clientA // the request still gets the profile it asked for
    expect(leaseA.target.profile).toBe('A')
    expect((await manualA as SchedulerError).code).toBe('stopped')
    leaseA.release()
    await work
    await until(() => states().join() === 'B:ready')
    expect(launched).toEqual(['H', 'A', 'B'])
    await sched.shutdown()
  })

  test('a newer switch during a pending restart keeps queued client requests too', async () => {
    const { sched, ops, states } = setup()
    await sched.start(at('H'))
    const leaseH = await sched.acquire(at('H'))
    const first = ops.switchTo('m', 'B') // restart waits for H to drain
    await tick()
    const clientC = sched.acquire(at('C'))
    await tick()
    const second = ops.switchTo('m', 'D')
    expect(second.restarted).toBe(true)
    leaseH.release()
    const leaseC = await clientC
    expect(leaseC.target.profile).toBe('C')
    leaseC.release()
    await Promise.all([first.work, second.work])
    await until(() => states().join() === 'D:ready')
    await sched.shutdown()
  })

  test('an explicit stop still rejects queued client requests', async () => {
    const { sched, ops } = setup()
    await sched.start(at('H'))
    const leaseH = await sched.acquire(at('H'))
    const clientA = sched.acquire(at('A')).catch(e => e)
    await tick()
    const stopped = ops.stop('m')
    leaseH.release()
    await stopped
    expect((await clientA as SchedulerError).code).toBe('stopped')
    await sched.shutdown()
  })

  test('ready on another profile restarts onto the new one', async () => {
    const { sched, ops, states } = setup()
    await sched.start(at('A'))
    const { restarted, work } = ops.switchTo('m', 'B')
    expect(restarted).toBe(true)
    await work
    expect(states()).toEqual(['B:ready'])
    await sched.shutdown()
  })
})

describe('ModelOps.inUseProfiles', () => {
  test('a profile a request is queued for (waiting for another to drain) is in use', async () => {
    const { sched, ops } = setup()
    await sched.start(at('A'))
    const lease = await sched.acquire(at('A'))
    const queued = sched.acquire(at('B'))
    await tick()
    expect(sched.snapshot().queue.map(q => q.profile)).toEqual(['B'])
    expect(ops.inUseProfiles('m').sort()).toEqual(['A', 'B'])
    lease.release()
    ;(await queued).release()
    await sched.shutdown()
  })

  test('the target of a pending restart is in use before it has an instance', async () => {
    const { sched, ops } = setup()
    await sched.start(at('A'))
    const lease = await sched.acquire(at('A'))
    const { work } = ops.switchTo('m', 'B')
    await tick()
    expect(ops.upProfiles('m')).toEqual(['A'])
    expect(ops.inUseProfiles('m').sort()).toEqual(['A', 'B'])
    lease.release()
    await work
    await sched.shutdown()
  })

  test('a stopped model with no queue uses nothing', async () => {
    const { sched, ops } = setup()
    expect(ops.inUseProfiles('m')).toEqual([])
    await sched.shutdown()
  })
})

describe('ModelOps.restartIfUp', () => {
  test('restarts the serving profile, honours `only`, and ignores a profile on its way out', async () => {
    const { sched, ops, launched, states } = setup()
    expect(ops.restartIfUp('m')).toBeNull()
    await sched.start(at('A'))
    expect(ops.restartIfUp('m', 'B')).toBeNull()
    await ops.restartIfUp('m', 'A')
    expect(launched).toEqual(['A', 'A'])

    // A drains towards B: saving A must not restart onto A; saving B restarts onto B.
    const lease = await sched.acquire(at('A'))
    const { work } = ops.switchTo('m', 'B')
    await tick()
    expect(ops.restartIfUp('m', 'A')).toBeNull()
    const again = ops.restartIfUp('m', 'B')
    expect(again).not.toBeNull()
    lease.release()
    await Promise.all([work, again])
    expect(states()).toEqual(['B:ready'])
    expect(launched).toEqual(['A', 'A', 'B'])
    await sched.shutdown()
  })

  test('a manual start still queued needs no restart after a save: it launches with the saved config', async () => {
    const { sched, ops, launched, states } = setup()
    const other: Target = { modelId: 'other', profile: 'A' }
    await sched.start(other)
    const lease = await sched.acquire(other)
    const started = ops.start(at('A'))
    await tick()
    expect(ops.restartIfUp('m', 'A')).toBeNull()
    lease.release()
    await started
    expect(states()).toEqual(['A:ready'])
    expect(launched).toEqual(['A', 'A']) // other:A, m:A
    await sched.shutdown()
  })

  test('a request queued for a profile that is later stopped is rejected, not failed', async () => {
    const { sched, ops } = setup()
    await sched.start(at('A'))
    const lease = await sched.acquire(at('A'))
    const queued = sched.acquire(at('B'))
    await tick()
    const stopped = ops.stop('m')
    lease.release()
    await stopped
    const err = await queued.then(() => null, e => e)
    expect(err).toBeInstanceOf(SchedulerError)
    expect((err as SchedulerError).code).toBe('stopped')
    await sched.shutdown()
  })
})

describe('management targets go after kept requests and are not merged into them', () => {
  test('save + restart while a client load is in progress: the client is served, then the profile reloads with the new config', async () => {
    const { sched, ops, launchedWith, procs, config, states, open } = setup({ gate: true })
    const client = sched.acquire(at('A'))
    await until(() => procs.length === 1) // launched with ctx 4096, still loading
    config.ctx = 8192 // the save
    const work = ops.restartIfUp('m', 'A')
    expect(work).not.toBeNull()
    open()
    const lease = await client
    expect(lease.port).toBe(procs[0]!.port) // the request got the load it was waiting for
    lease.release()
    await until(() => procs.length === 2)
    open()
    await work
    expect(launchedWith).toEqual([4096, 8192])
    expect(procs[0]!.stopped).toBe(true)
    expect(states()).toEqual(['A:ready'])
    await sched.shutdown()
  })

  test('save + restart of a ready profile reloads even when nobody is queued', async () => {
    const { sched, ops, launchedWith, config, states } = setup()
    await sched.start(at('A'))
    config.ctx = 8192
    await ops.restartIfUp('m', 'A')
    expect(launchedWith).toEqual([4096, 8192])
    expect(states()).toEqual(['A:ready'])
    await sched.shutdown()
  })

  test('switching to a profile an earlier request also wants ends on it, after the requests behind', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('H'))
    const leaseH = await sched.acquire(at('H'))
    const clientB = sched.acquire(at('B'))
    const clientC = sched.acquire(at('C'))
    await tick()
    expect(sched.snapshot().queue.map(q => q.profile)).toEqual(['B', 'C'])
    const { restarted, work } = ops.switchTo('m', 'B')
    expect(restarted).toBe(true)
    leaseH.release()
    ;(await clientB).release()
    ;(await clientC).release()
    await work
    expect(launched).toEqual(['H', 'B', 'C', 'B'])
    expect(states()).toEqual(['B:ready'])
    await sched.shutdown()
  })

  test('already on the profile with requests for another queued: comes back to it after them', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('B'))
    const other: Target = { modelId: 'other', profile: 'X' }
    const leaseB = await sched.acquire(at('B'))
    const clientX = sched.acquire(other) // waits for m:B to drain
    const clientC = sched.acquire(at('C')) // queued behind it
    await tick()
    const r = ops.switchTo('m', 'C') // makes C current: m:B is draining, so this restarts
    expect(r.restarted).toBe(true)
    const back = ops.switchTo('m', 'B')
    leaseB.release()
    ;(await clientX).release()
    ;(await clientC).release()
    await Promise.all([r.work, back.work])
    expect(launched).toEqual(['B', 'X', 'C', 'B'])
    expect(states()).toEqual(['B:ready'])
    await sched.shutdown()
  })

  test('a later switch or an explicit stop drops the queued management target', async () => {
    const { sched, ops, launched, states } = setup()
    await sched.start(at('H'))
    const leaseH = await sched.acquire(at('H'))
    const clientC = sched.acquire(at('C'))
    await tick()
    const toB = ops.switchTo('m', 'B')
    await tick()
    const toD = ops.switchTo('m', 'D')
    leaseH.release()
    ;(await clientC).release()
    await Promise.all([toB.work, toD.work])
    expect(launched).toEqual(['H', 'C', 'D'])
    expect(states()).toEqual(['D:ready'])

    const leaseD = await sched.acquire(at('D'))
    const clientE = sched.acquire(at('E')).catch(e => e)
    await tick()
    const toF = ops.switchTo('m', 'F')
    await tick()
    const stopped = ops.stop('m')
    leaseD.release()
    await stopped
    await toF.work // superseded by the stop: ends without starting F
    expect((await clientE as SchedulerError).code).toBe('stopped')
    expect(launched).toEqual(['H', 'C', 'D'])
    expect(states()).toEqual([])
    await sched.shutdown()
  })
})
