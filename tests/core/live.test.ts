import { describe, expect, test } from 'bun:test'
import { handleStream, LiveHub, type ActivityEvent, type StateDoc } from '../../server/core/live'
import type { SchedulerSnapshot } from '../../server/core/scheduler'

function setup() {
  let clock = 1000
  const sched: SchedulerSnapshot = { models: [], queue: [] }
  const hub = new LiveHub({
    now: () => clock,
    coalesceMs: 1,
    historySize: 3,
    snapshot: () => ({
      scheduler: sched,
      models: [{ id: 'm1', name: 'Model One', activeProfile: 'default', profiles: ['default'], hasMmproj: false, files: { model: 'main/m.gguf', mmproj: null, draft: null }, missing: [], instances: [] }],
      queue: sched.queue.map(q => ({ modelId: q.modelId, profile: q.profile, started: q.started, waiting: q.waiting })),
      llamacpp: { current: 'b1', runtime: { state: 'ready', tag: 'b1' } },
    }),
  })
  const target = { modelId: 'm1', profile: 'default' }
  return { hub, sched, target, tick: (ms: number) => { clock += ms } }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('LiveHub', () => {
  test('carries the first-run flag (false unless the snapshot source says so)', () => {
    const { hub } = setup()
    expect(hub.snapshot().firstRun).toBe(false)
    const first = new LiveHub({ snapshot: () => ({ scheduler: { models: [], queue: [] }, models: [], queue: [], llamacpp: { current: '', runtime: { state: 'idle' } }, firstRun: true }) })
    expect(first.snapshot().firstRun).toBe(true)
  })

  test('tracks when an instance entered its state and lists only running instances', () => {
    const { hub, sched, target, tick } = setup()
    expect(hub.snapshot().models[0]!.instances).toEqual([])
    hub.onSchedulerEvent({ type: 'state', target, from: 'stopped', to: 'loading' })
    sched.models.push({ ...target, state: 'loading', port: 1, inflight: 2, lastUsedAt: null, error: null })
    tick(500)
    const snap = hub.snapshot()
    expect(snap.now).toBe(1500)
    expect(snap.models[0]!.instances).toEqual([{ profile: 'default', state: 'loading', inflight: 2, error: null, since: 1000 }])
    sched.models[0]!.state = 'stopped'
    expect(hub.snapshot().models[0]!.instances).toEqual([])
  })

  test('keeps a bounded history with increasing ids and the error code', () => {
    const { hub, target } = setup()
    for (let i = 0; i < 5; i++) hub.onSchedulerEvent({ type: 'state', target, from: 'stopped', to: 'loading' })
    hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'failed', error: Object.assign(new Error('x'), { code: 'timeout' }) })
    const h = hub.recent()
    expect(h.map(e => e.id)).toEqual([4, 5, 6])
    const last = h[2]!
    expect(last.kind === 'state' && last.error).toBe('timeout')
  })

  test('pushes activity at once and a coalesced snapshot for a burst of changes', async () => {
    const { hub, target } = setup()
    const got: string[] = []
    hub.subscribe(m => got.push(m.type))
    hub.onSchedulerEvent({ type: 'state', target, from: 'stopped', to: 'loading' })
    hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    expect(got).toEqual(['activity', 'activity'])
    await wait(20)
    expect(got).toEqual(['activity', 'activity', 'snapshot'])
  })

  test('does not push an unchanged snapshot again, and a broken subscriber is isolated', async () => {
    const { hub } = setup()
    const got: string[] = []
    hub.subscribe(() => { throw new Error('boom') })
    hub.subscribe(m => got.push(m.type))
    hub.notify()
    await wait(20)
    hub.notify()
    await wait(20)
    expect(got).toEqual(['snapshot'])
  })

  test('download progress updates do not flood the history', () => {
    const { hub } = setup()
    hub.onRuntimeStatus({ state: 'working', step: 'resolve', detail: '' })
    hub.onRuntimeStatus({ state: 'working', step: 'download', detail: 'a' })
    hub.onRuntimeStatus({ state: 'ready', tag: 'b2' })
    expect(hub.recent().map(e => e.kind === 'runtime' && e.state)).toEqual(['working', 'ready'])
  })
})

async function readFrames(res: Response, until: (frames: string[]) => boolean, timeoutMs = 2000) {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames: string[] = []
  const deadline = Date.now() + timeoutMs
  while (!until(frames) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), wait(50).then(() => null)])
    if (r === null) continue
    if (r.done) break
    buf += dec.decode(r.value)
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2) }
  }
  reader.releaseLock()
  return frames
}

describe('handleStream', () => {
  test('sends history and snapshot on connect, then live changes; abort unsubscribes', async () => {
    const { hub, target } = setup()
    hub.onSchedulerEvent({ type: 'state', target, from: 'stopped', to: 'loading' })
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, pollMs: 10_000 })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(hub.subscriberCount).toBe(1)
    hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    const frames = await readFrames(res, f => f.some(x => x.startsWith('event: activity')) && f.filter(x => x.startsWith('event: snapshot')).length >= 2)
    const names = frames.filter(f => f.startsWith('event:')).map(f => f.split('\n')[0])
    expect(names.slice(0, 2)).toEqual(['event: history', 'event: snapshot'])
    expect(names).toContain('event: activity')
    const hist = JSON.parse(frames.find(f => f.startsWith('event: history'))!.split('data: ')[1]!) as ActivityEvent[]
    expect(hist).toHaveLength(1)
    const snap = JSON.parse(frames.find(f => f.startsWith('event: snapshot'))!.split('data: ')[1]!) as StateDoc
    expect(snap.models[0]!.name).toBe('Model One')
    ac.abort()
    await wait(10)
    expect(hub.subscriberCount).toBe(0)
  })

  test('an already aborted request subscribes nobody', () => {
    const { hub } = setup()
    const res = handleStream(new Request('http://x/api/stream', { signal: AbortSignal.abort() }), { hub })
    expect(res.status).toBe(200)
    expect(hub.subscriberCount).toBe(0)
  })

  test('cancelling the response body unsubscribes', async () => {
    const { hub } = setup()
    const res = handleStream(new Request('http://x/api/stream'), { hub })
    expect(hub.subscriberCount).toBe(1)
    await res.body!.cancel()
    expect(hub.subscriberCount).toBe(0)
  })

  test('polling pushes changes that have no event (in-flight counts, missing files)', async () => {
    const { hub, sched, target } = setup()
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, pollMs: 15 })
    sched.models.push({ ...target, state: 'ready', port: 1, inflight: 3, lastUsedAt: null, error: null })
    const frames = await readFrames(res, f => f.filter(x => x.startsWith('event: snapshot')).length >= 2)
    ac.abort()
    const last = JSON.parse(frames.filter(x => x.startsWith('event: snapshot')).at(-1)!.split('data: ')[1]!) as StateDoc
    expect(last.models[0]!.instances[0]?.inflight).toBe(3)
  })

  test('sends keep-alive comments', async () => {
    const { hub } = setup()
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, heartbeatMs: 10, pollMs: 10_000 })
    const frames = await readFrames(res, f => f.some(x => x.startsWith(': keep-alive')))
    ac.abort()
    expect(frames.some(f => f.startsWith(': keep-alive'))).toBe(true)
  })
})
