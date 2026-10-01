import { describe, expect, test } from 'bun:test'
import { handleStream, LiveHub, type ActivityEvent, type LiveHubOptions, type StateDoc } from '../../server/core/live'
import type { SchedulerSnapshot } from '../../server/core/scheduler'

function setup(extra: Partial<LiveHubOptions> = {}) {
  let clock = 1000
  const sched: SchedulerSnapshot = { models: [], queue: [] }
  const hub = new LiveHub({
    now: () => clock,
    coalesceMs: 1,
    historySize: 3,
    ...extra,
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
  // One read stays outstanding across the 50 ms polls; abandoning a pending read would swallow its chunk.
  let pending: ReturnType<typeof reader.read> | null = null
  while (!until(frames) && Date.now() < deadline) {
    pending ??= reader.read()
    const r = await Promise.race([pending, wait(50).then(() => null)])
    if (r === null) continue
    pending = null
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

describe('handleStream backpressure', () => {
  const dataOf = <T>(f: string) => JSON.parse(f.split('data: ')[1]!) as T

  test('a reader that falls behind gets every held activity in order and only the latest snapshot', async () => {
    const { hub, sched, target } = setup()
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, pollMs: 10_000, highWaterMark: 4 })
    sched.models.push({ ...target, state: 'ready', port: 1, inflight: 0, lastUsedAt: null, error: null })
    for (let i = 0; i < 20; i++) hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    for (let n = 1; n <= 5; n++) {
      sched.models[0]!.inflight = n
      hub.notify()
      await wait(5)
    }
    const frames = await readFrames(res, f => f.filter(x => x.startsWith('event: activity')).length >= 20
      && f.filter(x => x.startsWith('event: snapshot')).length >= 2)
    ac.abort()
    const acts = frames.filter(x => x.startsWith('event: activity')).map(f => dataOf<ActivityEvent>(f).id)
    expect(acts).toHaveLength(20)
    expect(acts).toEqual([...acts].sort((a, b) => a - b))
    const snaps = frames.filter(x => x.startsWith('event: snapshot'))
    expect(snaps).toHaveLength(2) // the one on connect + the latest held one
    expect(dataOf<StateDoc>(snaps[1]!).models[0]!.instances[0]!.inflight).toBe(5)
  })

  test('too many held activity events close the connection and unsubscribe', async () => {
    const { hub, target } = setup()
    const res = handleStream(new Request('http://x/api/stream'), { hub, pollMs: 10_000, highWaterMark: 4, maxPendingActivity: 50 })
    for (let i = 0; i < 10_000; i++) hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    expect(hub.subscriberCount).toBe(0)
    // Only what fitted in the stream's queue is left to read, then the stream ends.
    const reader = res.body!.getReader()
    let chunks = 0
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      chunks++
    }
    expect(chunks).toBeLessThanOrEqual(4)
  })

  test('many connections that stop reading stay bounded and clean up on cancel', async () => {
    const { hub, target } = setup()
    const conns = Array.from({ length: 5 }, () => handleStream(new Request('http://x/api/stream'), { hub, pollMs: 10_000, highWaterMark: 4 }))
    expect(hub.subscriberCount).toBe(5)
    for (let i = 0; i < 100; i++) hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    expect(hub.subscriberCount).toBe(5) // 100 held events is under the default limit
    await Promise.all(conns.map(r => r.body!.cancel()))
    expect(hub.subscriberCount).toBe(0)
  })
})

describe('requests and model output', () => {
  const dataOf = <T>(f: string) => JSON.parse(f.split('data: ')[1]!) as T
  const record = (id: number) => ({
    id, at: 1000 + id, source: 'local', keyName: null, method: 'POST', path: '/v1/chat/completions', modelId: 'm1', modelName: 'Model One',
    profile: 'default', stream: false, status: 200, outcome: 'ok', error: null, durationMs: 5, promptTokens: 1, completionTokens: 2, images: null, params: {},
  }) as const

  test('every activity event is also handed to onActivity (persistence); a failing sink does not break the feed', () => {
    const seen: ActivityEvent[] = []
    let boom = false
    const hub = new LiveHub({
      onActivity: (e) => { seen.push(e); if (boom) throw new Error('disk full') },
      snapshot: () => ({ scheduler: { models: [], queue: [] }, models: [], queue: [], llamacpp: { current: '', runtime: { state: 'idle' } } }),
    })
    const got: string[] = []
    hub.subscribe(m => got.push(m.type))
    const target = { modelId: 'm1', profile: 'default' }
    hub.onSchedulerEvent({ type: 'state', target, from: 'stopped', to: 'loading' })
    boom = true
    hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    expect(seen.map(e => e.id)).toEqual([1, 2])
    expect(got.filter(x => x === 'activity')).toHaveLength(2)
  })

  test('request records are pushed and the last ones kept for new connections', () => {
    const hub = new LiveHub({ requestHistorySize: 3, snapshot: () => ({ scheduler: { models: [], queue: [] }, models: [], queue: [], llamacpp: { current: '', runtime: { state: 'idle' } } }) })
    const got: number[] = []
    hub.subscribe(m => { if (m.type === 'request') got.push(m.record.id) })
    for (let i = 1; i <= 5; i++) hub.onRequest(record(i))
    expect(got).toEqual([1, 2, 3, 4, 5])
    expect(hub.recentRequests().map(r => r.id)).toEqual([3, 4, 5])
  })

  test('output lines of a burst arrive as one batch, history is bounded, nobody listening costs no batches', async () => {
    const { hub } = setup()
    const batches: number[][] = []
    hub.onLogLine('m1', 'default', 'stderr', 'before anyone listens')
    const off = hub.subscribe((m) => { if (m.type === 'log') batches.push(m.lines.map(l => l.id)) })
    for (let i = 0; i < 5; i++) hub.onLogLine('m1', 'default', 'stdout', `line ${i}`)
    expect(batches).toEqual([])
    await wait(150)
    expect(batches).toEqual([[2, 3, 4, 5, 6]])
    off()
    const small = new LiveHub({ logHistorySize: 3, snapshot: () => ({ scheduler: { models: [], queue: [] }, models: [], queue: [], llamacpp: { current: '', runtime: { state: 'idle' } } }) })
    for (let i = 0; i < 10; i++) small.onLogLine('m1', 'default', 'stdout', `l${i}`)
    expect(small.recentLogs().map(l => l.text)).toEqual(['l7', 'l8', 'l9'])
  })

  test('a connection gets request / output history first, then live records and lines', async () => {
    const { hub } = setup()
    hub.onRequest(record(1))
    hub.onLogLine('m1', 'default', 'stdout', 'old line')
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, pollMs: 10_000 })
    hub.onRequest(record(2))
    hub.onLogLine('m1', 'default', 'stdout', 'new line')
    const frames = await readFrames(res, f => f.some(x => x.startsWith('event: log\n')) && f.some(x => x.startsWith('event: request\n')))
    ac.abort()
    const names = frames.filter(f => f.startsWith('event:')).map(f => f.split('\n')[0]!.slice(7))
    expect(names.slice(0, 4)).toEqual(['history', 'request-history', 'log-history', 'snapshot'])
    expect(dataOf<Array<{ id: number }>>(frames.find(f => f.startsWith('event: request-history'))!).map(r => r.id)).toEqual([1])
    expect(dataOf<Array<{ text: string }>>(frames.find(f => f.startsWith('event: log-history'))!).map(l => l.text)).toEqual(['old line'])
    expect(dataOf<{ id: number }>(frames.find(f => f.startsWith('event: request\n'))!).id).toBe(2)
    expect(dataOf<Array<{ text: string }>>(frames.find(f => f.startsWith('event: log\n'))!).map(l => l.text)).toEqual(['new line'])
  })

  test('a reader that falls behind loses the oldest output batches but keeps the connection and the activity', async () => {
    const { hub, target } = setup({ logBatchMs: 1 })
    const ac = new AbortController()
    const res = handleStream(new Request('http://x/api/stream', { signal: ac.signal }), { hub, pollMs: 10_000, highWaterMark: 4, maxPendingLogs: 5, maxPendingActivity: 50 })
    hub.onSchedulerEvent({ type: 'state', target, from: 'loading', to: 'ready' })
    for (let i = 0; i < 40; i++) {
      hub.onLogLine('m1', 'default', 'stdout', `l${i}`)
      await wait(3) // one batch per line
    }
    expect(hub.subscriberCount).toBe(1)
    const frames = await readFrames(res, f => f.some(x => x.startsWith('event: activity')) && f.some(x => x.includes('"l39"')))
    ac.abort()
    expect(frames.some(x => x.startsWith('event: activity'))).toBe(true)
    const lines = frames.filter(x => x.startsWith('event: log\n')).flatMap(x => dataOf<Array<{ text: string }>>(x).map(l => l.text))
    expect(lines.length).toBeLessThan(40)
    expect(lines.at(-1)).toBe('l39')
  })
})
