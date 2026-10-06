// Health of the external upstreams and the machine-exclusive rule (decision 56 ⑨).
import { describe, expect, test } from 'bun:test'
import { httpProbe, UpstreamHealth } from '../../server/core/upstream-health'
import { createUpstream, defaultUpstreams, updateUpstream, type Upstream, type UpstreamsDoc } from '../../server/core/upstreams'
import { ModelOps } from '../../server/core/model-ops'
import { Scheduler, SchedulerError, type ModelProcess, type SchedulerEvent, type Target } from '../../server/core/scheduler'

const ctx = { localNames: [], selfPorts: [] }

function setup(opts: { downAfter?: number } = {}) {
  const doc: UpstreamsDoc = defaultUpstreams()
  createUpstream(doc, { name: 'Strata', baseUrl: 'http://127.0.0.1:9000/v1' }, ctx)
  const answers = new Map<string, boolean | 'throw'>()
  let changes = 0
  let ticks = 0
  const health = new UpstreamHealth({
    upstreams: () => doc.upstreams,
    probe: async (u: Upstream) => { const a = answers.get(u.id); if (a === 'throw') throw new Error('boom'); return a === true },
    onChange: () => { changes++ },
    afterTick: () => { ticks++ },
    downAfter: opts.downAfter,
  })
  const id = doc.upstreams[0]!.id
  return { doc, health, answers, id, changes: () => changes, ticks: () => ticks }
}

describe('up and down', () => {
  test('unknown is not up; one answer is enough; three misses in a row are needed to go down', async () => {
    const s = setup()
    expect(s.health.isUp(s.id)).toBe(false)
    await s.health.tick()
    expect(s.health.isUp(s.id)).toBe(false)
    s.answers.set(s.id, true)
    await s.health.tick()
    expect(s.health.isUp(s.id)).toBe(true)
    s.answers.set(s.id, false)
    await s.health.tick(); await s.health.tick()
    expect(s.health.isUp(s.id)).toBe(true) // two misses: a slow answer is not an outage
    await s.health.tick()
    expect(s.health.isUp(s.id)).toBe(false)
  })

  test('an answer in between resets the count; a throwing probe is a miss', async () => {
    const s = setup()
    s.answers.set(s.id, true)
    await s.health.tick()
    s.answers.set(s.id, 'throw')
    await s.health.tick(); await s.health.tick()
    s.answers.set(s.id, true)
    await s.health.tick()
    expect(s.health.state(s.id)?.misses).toBe(0)
    s.answers.set(s.id, 'throw')
    await s.health.tick(); await s.health.tick()
    expect(s.health.isUp(s.id)).toBe(true)
  })

  test('onChange fires on up / down, not on every round; afterTick on every round', async () => {
    const s = setup({ downAfter: 1 })
    s.answers.set(s.id, true)
    await s.health.tick(); await s.health.tick()
    expect(s.changes()).toBe(1)
    s.answers.set(s.id, false)
    await s.health.tick()
    expect(s.changes()).toBe(2)
    expect(s.ticks()).toBe(3)
  })

  test('a removed upstream is forgotten', async () => {
    const s = setup()
    s.answers.set(s.id, true)
    await s.health.tick()
    s.doc.upstreams.length = 0
    await s.health.tick()
    expect(s.health.state(s.id)).toBeNull()
    expect(s.health.holder()).toBeNull()
  })
})

describe('holder', () => {
  test('only an upstream that is up, runs here and is exclusive holds the machine', async () => {
    const s = setup()
    s.answers.set(s.id, true)
    await s.health.tick()
    expect(s.health.holder()).toBe('Strata')
    updateUpstream(s.doc, s.id, { exclusive: false }, ctx)
    expect(s.health.holder()).toBeNull()
    updateUpstream(s.doc, s.id, { exclusive: true, local: false }, ctx)
    expect(s.health.holder()).toBeNull()
    updateUpstream(s.doc, s.id, { local: true }, ctx)
    expect(s.health.holder()).toBe('Strata')
    s.answers.set(s.id, false)
    for (let i = 0; i < 3; i++) await s.health.tick()
    expect(s.health.holder()).toBeNull()
  })

  test('the holder changing is reported once, also when nothing went up or down', async () => {
    const s = setup()
    s.answers.set(s.id, true)
    await s.health.tick()
    const before = s.changes()
    updateUpstream(s.doc, s.id, { exclusive: false }, ctx)
    await s.health.tick()
    expect(s.changes()).toBe(before + 1)
  })
})

describe('httpProbe', () => {
  test('any HTTP answer counts, a network failure does not, the key goes in the header', async () => {
    const seen: Array<string | null> = []
    const u = { id: 'u1', baseUrl: 'http://x/v1' } as Upstream
    const ok = httpProbe(() => 'sk-up', (async (url: any, init: any) => { seen.push(`${url} ${init.headers.authorization}`); return new Response('no', { status: 401 }) }) as any)
    expect(await ok(u)).toBe(true)
    expect(seen).toEqual(['http://x/v1/models Bearer sk-up'])
    const down = httpProbe(() => '', (async () => { throw new Error('refused') }) as any)
    expect(await down(u)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
// The scheduler side: nothing loads while an upstream holds the machine, and ModelOps.stopAll empties it.

class FakeProc implements ModelProcess {
  readonly ready = Promise.resolve()
  readonly exited: Promise<string>
  private exit!: (why: string) => void
  private alive = true
  constructor(readonly target: Target, readonly port: number) { this.exited = new Promise(r => { this.exit = r }) }
  stop() { if (this.alive) { this.alive = false; this.exit('stopped') } return this.exited }
}

function sched(blocked: { holder: string | null }, events: SchedulerEvent[] = []) {
  let port = 7100
  const s = new Scheduler({
    maxLoaded: 2, drainTimeoutMs: 1000, blocked: () => blocked.holder, onEvent: e => events.push(e),
    launch: async t => new FakeProc(t, port++),
  })
  return s
}

const A: Target = { modelId: 'a', profile: 'p' }
const B: Target = { modelId: 'b', profile: 'p' }

describe('scheduler', () => {
  test('a load is refused with `exclusive` and the holder, for a request and for a manual start alike', async () => {
    const blocked = { holder: 'Strata' as string | null }
    const events: SchedulerEvent[] = []
    const s = sched(blocked, events)
    const err = await s.acquire(A).catch(e => e)
    expect(err).toBeInstanceOf(SchedulerError)
    expect(err.code).toBe('no-room')
    expect(err.cause).toMatchObject({ reason: 'exclusive', holder: 'Strata' })
    await expect(s.start(B)).rejects.toMatchObject({ code: 'no-room' })
    const refused = events.filter(e => e.type === 'no-room')
    expect(refused).toHaveLength(2)
    expect(s.snapshot().models).toEqual([])
  })

  test('as soon as nothing holds the machine a load works again', async () => {
    const blocked = { holder: 'Strata' as string | null }
    const s = sched(blocked)
    await expect(s.start(A)).rejects.toMatchObject({ code: 'no-room' })
    blocked.holder = null
    await s.start(A)
    expect(s.stateOf(A)).toBe('ready')
  })

  test('ModelOps.stopAll stops every model that is up and nothing can come back while it is held', async () => {
    const blocked = { holder: null as string | null }
    const s = sched(blocked)
    const ops = new ModelOps(s)
    await ops.start(A)
    await ops.start(B)
    expect(ops.anyUp()).toBe(true)
    blocked.holder = 'Strata'
    expect(await ops.stopAll()).toBe(2)
    expect(ops.anyUp()).toBe(false)
    await expect(ops.start(A)).rejects.toMatchObject({ code: 'no-room' })
    expect(await ops.stopAll()).toBe(0)
  })

  test('stopAll lets a running request finish first (drain), it does not cut it off', async () => {
    const blocked = { holder: null as string | null }
    const s = sched(blocked)
    const ops = new ModelOps(s)
    const lease = await s.acquire(A)
    const stopping = ops.stopAll()
    await new Promise(r => setTimeout(r, 30))
    expect(s.stateOf(A)).toBe('draining')
    lease.release('ok')
    await stopping
    expect(ops.anyUp()).toBe(false)
  })
})
