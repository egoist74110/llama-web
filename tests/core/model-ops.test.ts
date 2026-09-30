import { describe, expect, test } from 'bun:test'
import { ModelOps } from '../../server/core/model-ops'
import { Scheduler, SchedulerError, type ModelProcess, type Target } from '../../server/core/scheduler'

// Fake process that becomes ready on the next microtask and exits when stopped.
class FakeProc implements ModelProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<string>
  private exit!: (why: string) => void
  private alive = true

  constructor(readonly target: Target, readonly port: number) {
    this.ready = Promise.resolve()
    this.exited = new Promise(r => { this.exit = r })
  }

  stop() {
    if (this.alive) { this.alive = false; this.exit('stopped') }
    return this.exited
  }
}

function setup() {
  const launched: string[] = []
  let port = 7100
  const sched = new Scheduler({
    maxLoaded: 1,
    drainTimeoutMs: 5000,
    launch: async (t) => { launched.push(t.profile); return new FakeProc(t, port++) },
  })
  const ops = new ModelOps(sched)
  const states = () => sched.snapshot().models.filter(s => s.modelId === 'm').map(s => `${s.profile}:${s.state}`)
  return { sched, ops, launched, states }
}

const at = (profile: string): Target => ({ modelId: 'm', profile })
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

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
