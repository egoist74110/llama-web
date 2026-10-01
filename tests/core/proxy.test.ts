import { afterEach, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { defaultSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { LoadError } from '../../server/core/runner'
import { activeBoundedWaits, bounded, createProxy, type ProxyEvent } from '../../server/core/proxy'
import type { RequestRecord } from '../../server/core/request-log'
import { Scheduler, type ModelProcess, type Target } from '../../server/core/scheduler'

// ---------------------------------------------------------------------------------------
// Fake llama-server: an in-process Bun server per launch. /v1/chat/completions streams
// `chunks` SSE events `gapMs` apart (or answers JSON when stream is false).

interface Upstream {
  target: Target
  server: ReturnType<typeof Bun.serve>
  requests: Array<{ path: string, headers: Headers, body: any }>
  /** Set when a streaming response was cancelled by the proxy. */
  aborted: boolean
  succeed(): void
  fail(e?: unknown): void
  /** The process dies while ready. */
  crash(): void
}

function makeUpstream(target: Target, opts: { chunks?: number, gapMs?: number, holdHeaders?: boolean }): Upstream {
  let res!: () => void
  let rej!: (e: unknown) => void
  let exit!: () => void
  const ready = new Promise<void>((a, b) => { res = a; rej = b })
  ready.catch(() => {})
  const exited = new Promise<void>(r => { exit = r })
  const up: Upstream = {
    target,
    requests: [],
    aborted: false,
    succeed: () => res(),
    fail: (e = new LoadError('exited', 'boom')) => { rej(e); exit() },
    crash: () => { up.server.stop(true); exit() },
    server: Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const text = req.method === 'GET' ? '' : await req.text()
        let body: any = text
        try { body = JSON.parse(text) } catch { /* raw */ }
        up.requests.push({ path: url.pathname + url.search, headers: req.headers, body })
        if (url.pathname === '/props') return Response.json({ model: target.modelId, profile: target.profile })
        if (url.pathname === '/boom') return Response.json({ error: { message: 'bad', code: 500 } }, { status: 500 })
        // Accept the request but never send response headers (until the server is stopped).
        if (body?.stream && opts.holdHeaders) return new Promise<Response>(() => {})
        if (body?.stream) {
          const n = opts.chunks ?? 3
          const gap = opts.gapMs ?? 50
          let i = 0
          let timer: ReturnType<typeof setTimeout> | undefined
          const stream = new ReadableStream({
            pull(ctrl) {
              return new Promise<void>((done) => {
                timer = setTimeout(() => {
                  if (i < n) ctrl.enqueue(new TextEncoder().encode(`data: {"i":${i++}}\n\n`))
                  else { ctrl.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\ndata: [DONE]\n\n')); ctrl.close() }
                  done()
                }, gap)
              })
            },
            cancel() { up.aborted = true; clearTimeout(timer) },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
        }
        return Response.json({ ok: true, model: target.modelId, profile: target.profile, echo: body, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
      },
    }),
  }
  const proc: ModelProcess = {
    get port() { return up.server.port! },
    ready,
    exited,
    stop: async () => { rej(new Error('stopped')); up.server.stop(true); exit() },
  }
  ;(up as any).proc = proc
  return up
}

const MODELS: ModelsDoc = {
  version: 1,
  models: [
    {
      id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: { dirId: 'd', rel: 'mm.gguf' }, draft: null,
      activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' }, RP: { overrides: {}, extraArgs: '', preprocess: { image: { maxEdge: 64 } } } },
    },
    {
      id: 'b', name: 'Beta', backend: 'llama-server', file: { dirId: 'd', rel: 'b.gguf' }, mmproj: null, draft: null,
      activeProfile: 'main', profiles: { main: { overrides: {}, extraArgs: '' } },
    },
  ],
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup(opts: { autoReady?: boolean, chunks?: number, gapMs?: number, heartbeatMs?: number, maxBodyBytes?: number, drainTimeoutMs?: number, finalEventTimeoutMs?: number, holdHeaders?: boolean } = {}) {
  const ups: Upstream[] = []
  const events: ProxyEvent[] = []
  const records: RequestRecord[] = []
  const settings: Settings = defaultSettings()
  const sched = new Scheduler({
    drainTimeoutMs: opts.drainTimeoutMs ?? 5000,
    launch: async (target) => {
      const up = makeUpstream(target, opts)
      ups.push(up)
      if (opts.autoReady !== false) setTimeout(() => up.succeed(), 20)
      return (up as any).proc
    },
  })
  const proxy = createProxy({
    scheduler: sched,
    getModels: () => MODELS,
    getSettings: () => settings,
    heartbeatMs: opts.heartbeatMs ?? 30,
    maxBodyBytes: opts.maxBodyBytes,
    finalEventTimeoutMs: opts.finalEventTimeoutMs,
    onEvent: e => events.push(e),
    onRequest: r => records.push(r),
  })
  const front = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      server.timeout(req, 0)
      const p = new URL(req.url).pathname
      return p.startsWith('/upstream/') ? proxy.handleUpstream(req) : proxy.handleV1(req)
    },
  })
  cleanups.push(async () => {
    await sched.shutdown()
    front.stop(true)
    for (const u of ups) u.server.stop(true)
  })
  const base = `http://127.0.0.1:${front.port}`
  const post = (path: string, body: unknown, init: RequestInit = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(init.headers as any) }, body: JSON.stringify(body), ...init,
  })
  const inflight = () => sched.snapshot().models.reduce((n, m) => n + m.inflight, 0)
  return { sched, ups, events, records, base, post, inflight, settings, proxy }
}

async function readAll(res: Response): Promise<{ text: string, times: number[] }> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let text = ''
  const times: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    times.push(Date.now())
    text += dec.decode(value, { stream: true })
  }
  return { text, times }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition')
    await Bun.sleep(10)
  }
}

describe('/v1/models', () => {
  test('lists base names and name:profile', async () => {
    const { base } = setup()
    const res = await fetch(`${base}/v1/models`)
    const json = await res.json() as any
    expect(json.object).toBe('list')
    expect(json.data.map((d: any) => d.id)).toEqual(['Alpha', 'Beta', 'Alpha:default', 'Alpha:RP', 'Beta:main'])
    expect((await fetch(`${base}/v1/models/Alpha:RP`)).status).toBe(200)
    expect((await fetch(`${base}/v1/models/Nope`)).status).toBe(404)
  })
})

describe('/v1 routing', () => {
  test('non-stream request loads the model and forwards to the right profile', async () => {
    const { post, ups, inflight } = setup()
    const res = await post('/v1/chat/completions', { model: 'Alpha:RP', messages: [] }, { headers: { authorization: 'Bearer secret' } })
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json).toMatchObject({ ok: true, model: 'a', profile: 'RP' })
    expect(ups[0]!.requests[0]!.headers.get('authorization')).toBeNull()
    expect(inflight()).toBe(0)
  })

  test('unknown model → 404, unknown profile → 404, launch never called', async () => {
    const { post, ups } = setup()
    const r1 = await post('/v1/chat/completions', { model: 'Nope' })
    expect(r1.status).toBe(404)
    expect(((await r1.json()) as any).error.code).toBe('model_not_found')
    const r2 = await post('/v1/chat/completions', { model: 'Alpha:nope' })
    expect(r2.status).toBe(404)
    expect(ups.length).toBe(0)
  })

  test('no model field and nothing running → 400; with a running model → that model', async () => {
    const { post } = setup()
    expect((await post('/v1/chat/completions', { messages: [] })).status).toBe(400)
    await (await post('/v1/chat/completions', { model: 'Beta' })).json()
    const json = await (await post('/v1/chat/completions', { messages: [] })).json() as any
    expect(json.model).toBe('b')
  })

  test('invalid JSON → 400', async () => {
    const { base } = setup()
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(res.status).toBe(400)
  })

  test('body over the limit → 413', async () => {
    const { post, ups } = setup({ maxBodyBytes: 1000 })
    const res = await post('/v1/chat/completions', { model: 'Alpha', pad: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
    expect(ups.length).toBe(0)
  })

  test('load failure → 503 with a Chinese message (non-stream)', async () => {
    const { post, ups } = setup({ autoReady: false })
    const p = post('/v1/chat/completions', { model: 'Alpha' })
    await until(() => ups.length === 1)
    ups[0]!.fail()
    const res = await p
    expect(res.status).toBe(503)
    const json = await res.json() as any
    expect(json.error.code).toBe('model_load_failed')
    expect(json.error.message).toContain('加载失败')
  })
})

describe('streaming', () => {
  test('ready model: chunks are passed through as they arrive', async () => {
    const { post, inflight } = setup({ chunks: 4, gapMs: 120 })
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json() // load first
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const { text, times } = await readAll(res)
    expect(text).toContain('data: {"i":3}')
    expect(text).toContain('[DONE]')
    // Not buffered: first chunk well before the last.
    expect(times.length).toBeGreaterThanOrEqual(4)
    expect(times[times.length - 1]! - times[0]!).toBeGreaterThan(250)
    expect(inflight()).toBe(0)
  })

  test('waiting for a load: heartbeat comments, then the stream', async () => {
    const { post, ups, inflight } = setup({ autoReady: false, heartbeatMs: 40 })
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await until(() => ups.length === 1)
    setTimeout(() => ups[0]!.succeed(), 200)
    const { text } = await readAll(res)
    const beats = text.split(': loading').length - 1
    expect(beats).toBeGreaterThanOrEqual(3)
    expect(text.indexOf(': loading')).toBeLessThan(text.indexOf('data: {"i":0}'))
    expect(text).toContain('[DONE]')
    expect(inflight()).toBe(0)
  })

  test('waiting for a load that fails: SSE error event', async () => {
    const { post, ups } = setup({ autoReady: false })
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    await until(() => ups.length === 1)
    ups[0]!.fail()
    const { text } = await readAll(res)
    expect(text).toContain(': loading')
    const data = text.split('\n').find(l => l.startsWith('data: '))!
    expect(JSON.parse(data.slice(6)).error.code).toBe('model_load_failed')
  })

  test('waiting path keeps the query string and releases the lease', async () => {
    const { post, ups, inflight } = setup({ autoReady: false })
    const res = await post('/v1/chat/completions?x=1', { model: 'Alpha', stream: true })
    await until(() => ups.length === 1)
    ups[0]!.succeed()
    const { text } = await readAll(res)
    expect(text).toContain('data: ')
    expect(ups[0]!.requests.at(-1)!.path).toBe('/v1/chat/completions?x=1')
    expect(inflight()).toBe(0)
  })
})

describe('client disconnect', () => {
  test('mid-stream: lease released and upstream cancelled', async () => {
    const { post, ups, inflight } = setup({ chunks: 100, gapMs: 30 })
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
    const ac = new AbortController()
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true }, { signal: ac.signal })
    const reader = res.body!.getReader()
    await reader.read()
    expect(inflight()).toBe(1)
    ac.abort()
    await until(() => inflight() === 0)
    await until(() => ups[0]!.aborted)
  })

  test('while waiting for a load (stream): waiter removed, no lease left behind', async () => {
    const { post, ups, sched, inflight } = setup({ autoReady: false })
    const ac = new AbortController()
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true }, { signal: ac.signal })
    await res.body!.getReader().read()
    await until(() => ups.length === 1)
    ac.abort()
    await until(() => sched.snapshot().queue.every(q => q.waiting === 0))
    ups[0]!.succeed()
    await until(() => sched.stateOf({ modelId: 'a', profile: 'default' }) === 'ready')
    await Bun.sleep(50)
    expect(inflight()).toBe(0)
  })

  test('mid-stream after waiting for a load: lease released and upstream cancelled', async () => {
    const { post, ups, inflight } = setup({ chunks: 100, gapMs: 30 })
    const ac = new AbortController()
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true }, { signal: ac.signal })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    while (!text.includes('data: {"i":1}')) text += dec.decode((await reader.read()).value)
    expect(inflight()).toBe(1)
    ac.abort()
    await until(() => inflight() === 0)
    await until(() => ups[0]!.aborted)
  })

  // nuxt dev: h3 never cancels the response body, only req.signal reports the disconnect.
  for (const waited of [false, true]) {
    test(`signal-only disconnect (${waited ? 'after waiting for a load' : 'ready model'}): lease released`, async () => {
      const { post, ups, inflight, proxy } = setup({ chunks: 100, gapMs: 30 })
      if (!waited) await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
      const ac = new AbortController()
      const req = new Request('http://x/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
        body: JSON.stringify({ model: 'Alpha', stream: true }),
      })
      const res = await proxy.handleV1(req)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let text = ''
      while (!text.includes('data: {"i":1}')) text += dec.decode((await reader.read()).value)
      expect(inflight()).toBe(1)
      ac.abort()
      await until(() => inflight() === 0)
      await until(() => ups[0]!.aborted)
    })
  }

  // Client read one heartbeat, then stopped pulling: the forward loop is parked on a
  // backpressured write when the disconnect arrives through req.signal only.
  test('signal-only disconnect while the cold-load stream is backpressured: lease released at once', async () => {
    const { ups, inflight, proxy } = setup({ chunks: 100, gapMs: 5 })
    const ac = new AbortController()
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ model: 'Alpha', stream: true }),
    })
    const res = await proxy.handleV1(req)
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': loading')
    await until(() => inflight() === 1)
    await Bun.sleep(200) // upstream chunks pile up until the writer blocks
    expect(inflight()).toBe(1)
    ac.abort()
    await until(() => inflight() === 0, 500)
    await until(() => ups[0]!.aborted)
  })

  /** Cold-load stream whose client reads one heartbeat and then stops pulling. */
  async function stalledColdStream(proxy: ReturnType<typeof setup>['proxy'], inflight: () => number) {
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Alpha', stream: true }),
    })
    // The forwarding task removes its req.signal listener in its finally: count that.
    let exited = 0
    const sig = req.signal
    const remove = sig.removeEventListener.bind(sig)
    ;(sig as any).removeEventListener = (type: string, l: any, o?: any) => {
      if (type === 'abort') exited++
      return remove(type, l, o)
    }
    const res = await proxy.handleV1(req)
    const reader = res.body!.getReader()
    await reader.read()
    await until(() => inflight() === 1)
    await Bun.sleep(200) // upstream chunks pile up until the writer blocks
    return { reader, exited: () => exited }
  }

  test('drain timeout while the cold-load stream is backpressured: lease released, task ends without the client', async () => {
    const { inflight, proxy, sched } = setup({ chunks: 1000, gapMs: 5, drainTimeoutMs: 100, finalEventTimeoutMs: 100 })
    const { reader, exited } = await stalledColdStream(proxy, inflight)
    const lease = await sched.acquire({ modelId: 'b', profile: 'main' })
    expect(sched.stateOf({ modelId: 'a', profile: 'default' })).toBe('stopped')
    expect(inflight()).toBe(1) // only the new lease on b
    // The old forwarding task must finish on its own, before anyone cancels the body.
    await until(() => exited() === 1, 1000)
    lease.release()
    await reader.cancel().catch(() => {})
  })

  test('model crash while the cold-load stream is backpressured: lease released, task ends without the client', async () => {
    const { inflight, proxy, sched, ups } = setup({ chunks: 1000, gapMs: 5, finalEventTimeoutMs: 100 })
    const { reader, exited } = await stalledColdStream(proxy, inflight)
    ups[0]!.crash()
    await until(() => inflight() === 0, 1000)
    expect(sched.stateOf({ modelId: 'a', profile: 'default' })).toBe('crashed')
    await until(() => exited() === 1, 1000)
    await reader.cancel().catch(() => {})
  })

  test('model crash before the response headers, client stalled: the error event is bounded and the task ends', async () => {
    const { inflight, proxy, sched, ups } = setup({ holdHeaders: true, finalEventTimeoutMs: 100 })
    const { reader, exited } = await stalledColdStream(proxy, inflight)
    expect(ups[0]!.requests.length).toBe(1) // request sent, headers pending
    ups[0]!.crash()
    await until(() => inflight() === 0, 1000)
    expect(sched.stateOf({ modelId: 'a', profile: 'default' })).toBe('crashed')
    await until(() => exited() === 1, 1000)
    // The undeliverable error event did not stay queued: the response was aborted.
    expect(await reader.read().then(() => 'data', () => 'aborted')).toBe('aborted')
  })

  test('long cold-load stream read normally: bounded() waiters stay bounded and are all removed', async () => {
    const before = activeBoundedWaits()
    const { post } = setup({ chunks: 200, gapMs: 1 })
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    let peak = 0
    for (;;) {
      const { done, value } = await reader.read()
      peak = Math.max(peak, activeBoundedWaits() - before)
      if (done) break
      text += dec.decode(value)
    }
    expect(text).toContain('data: {"i":199}')
    expect(peak).toBeLessThanOrEqual(1) // one wait at a time, not one per chunk
    await until(() => activeBoundedWaits() === before, 1000)
  }, 20000)

  test('while waiting for a load (non-stream): no lease left behind', async () => {
    const { post, ups, sched, inflight } = setup({ autoReady: false })
    const ac = new AbortController()
    const p = post('/v1/chat/completions', { model: 'Alpha' }, { signal: ac.signal }).catch(e => e)
    await until(() => ups.length === 1)
    ac.abort()
    await p
    await until(() => sched.snapshot().queue.every(q => q.waiting === 0))
    ups[0]!.succeed()
    await until(() => sched.stateOf({ modelId: 'a', profile: 'default' }) === 'ready')
    await Bun.sleep(50)
    expect(inflight()).toBe(0)
  })
})

describe('switching', () => {
  test('a long stream on A finishes before B is loaded', async () => {
    const { post, ups } = setup({ chunks: 6, gapMs: 60 })
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
    const longRes = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    const long = readAll(longRes)
    await Bun.sleep(30)
    const other = post('/v1/chat/completions', { model: 'Beta' }).then(async r => ({ at: Date.now(), json: await r.json() as any }))
    const [{ times, text }, b] = await Promise.all([long, other])
    expect(text).toContain('[DONE]')
    expect(b.json.model).toBe('b')
    expect(b.at).toBeGreaterThanOrEqual(times[times.length - 1]!)
    expect(ups.map(u => u.target.modelId)).toEqual(['a', 'b'])
  })
})

describe('images', () => {
  const png = async (w: number, h: number) => (await sharp({ create: { width: w, height: h, channels: 3, background: '#3366aa' } }).png().toBuffer()).toString('base64')

  test('model without mmproj → 400, no load', async () => {
    const { post, ups } = setup()
    const res = await post('/v1/chat/completions', {
      model: 'Beta',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${await png(8, 8)}` } }] }],
    })
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error.code).toBe('image_without_mmproj')
    expect(json.error.message).toContain('mmproj')
    expect(ups.length).toBe(0)
  })

  test('images are compressed with the profile override before forwarding', async () => {
    const { post, ups, events } = setup()
    const res = await post('/v1/chat/completions', {
      model: 'Alpha:RP',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${await png(300, 150)}` } }] }],
    })
    expect(res.status).toBe(200)
    const sent = ups[0]!.requests[0]!.body
    const url: string = sent.messages[0].content[1].image_url.url
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    const meta = await sharp(Buffer.from(url.split(',')[1]!, 'base64')).metadata()
    expect([meta.width, meta.height]).toEqual([64, 32])
    const ev = events.find(e => e.type === 'preprocess') as Extract<ProxyEvent, { type: 'preprocess' }>
    expect(ev.result.reports.image![0]).toMatchObject({ action: 'compressed', before: { width: 300, height: 150 }, after: { width: 64, height: 32 } })
  })
})

describe('request records', () => {
  const png = async (w: number, h: number) => (await sharp({ create: { width: w, height: h, channels: 3, background: '#3366aa' } }).png().toBuffer()).toString('base64')

  test('non-stream: model, profile, tokens, parameters, no conversation content or Authorization', async () => {
    const { post, records } = setup()
    const res = await post('/v1/chat/completions', {
      model: 'Alpha:RP', temperature: 0.7, reasoning_effort: 'high', max_tokens: 64, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: 'my secret question' }],
    }, { headers: { authorization: 'Bearer sk-very-secret' } })
    expect(res.status).toBe(200)
    await res.text()
    await until(() => records.length === 1)
    const r = records[0]!
    expect(r).toMatchObject({
      source: 'local', keyName: null, method: 'POST', path: '/v1/chat/completions', modelId: 'a', modelName: 'Alpha', profile: 'RP',
      stream: false, status: 200, outcome: 'ok', error: null, promptTokens: 7, completionTokens: 3, images: null,
      params: { temperature: 0.7, reasoning_effort: 'high', max_tokens: 64, 'chat_template_kwargs.enable_thinking': false, messages: 1 },
    })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    const text = JSON.stringify(r)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('Bearer')
  })

  test('streaming on a ready model: tokens come from the final chunk, one record', async () => {
    const { post, records } = setup({ chunks: 2, gapMs: 10 })
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    await readAll(res)
    await until(() => records.length === 2)
    expect(records[1]).toMatchObject({ stream: true, status: 200, outcome: 'ok', promptTokens: 11, completionTokens: 4 })
  })

  test('streaming while the model loads: tokens and status are recorded too', async () => {
    const { post, records } = setup({ chunks: 2, gapMs: 10, heartbeatMs: 20 })
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true })
    await readAll(res)
    await until(() => records.length === 1)
    expect(records[0]).toMatchObject({ stream: true, status: 200, outcome: 'ok', promptTokens: 11, completionTokens: 4, modelName: 'Alpha' })
  })

  test('errors are recorded with their code; GET /v1/models is not recorded', async () => {
    const { post, base, records, ups } = setup({ autoReady: false })
    await fetch(`${base}/v1/models`)
    const unknown = await post('/v1/chat/completions', { model: 'Nope' })
    expect(unknown.status).toBe(404)
    await until(() => records.length === 1)
    expect(records[0]).toMatchObject({ status: 404, outcome: 'error', error: 'model_not_found', modelId: null, modelName: null })

    const p = post('/v1/chat/completions', { model: 'Alpha' })
    await until(() => ups.length === 1)
    ups[0]!.fail()
    expect((await p).status).toBe(503)
    await until(() => records.length === 2)
    expect(records[1]).toMatchObject({ status: 503, outcome: 'error', error: 'model_load_failed', modelName: 'Alpha' })
    expect(records).toHaveLength(2)
  })

  test('client leaving mid-stream is recorded as aborted', async () => {
    const { post, records, inflight } = setup({ chunks: 100, gapMs: 30 })
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
    const ac = new AbortController()
    const res = await post('/v1/chat/completions', { model: 'Alpha', stream: true }, { signal: ac.signal })
    await res.body!.getReader().read()
    ac.abort()
    await until(() => inflight() === 0)
    await until(() => records.length === 2)
    expect(records[1]).toMatchObject({ stream: true, outcome: 'aborted' })
  })

  test('image step: sizes before / after, never the image data', async () => {
    const { post, records } = setup()
    const data = await png(300, 150)
    await post('/v1/chat/completions', {
      model: 'Alpha:RP',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }],
    })
    await until(() => records.length === 1)
    const img = records[0]!.images!
    expect(img).toMatchObject({ count: 1, compressed: 1, maxEdgeBefore: 300, maxEdgeAfter: 64 })
    expect(img.beforeBytes).toBeGreaterThan(0)
    expect(img.afterBytes).toBeGreaterThan(0)
    expect(JSON.stringify(records[0])).not.toContain(data.slice(0, 40))
  })

  test('source follows the client address and the key name', async () => {
    const { proxy, records } = setup()
    const call = (meta?: Parameters<typeof proxy.handleV1>[1]) => proxy.handleV1(
      new Request('http://x/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Nope' }) }), meta)
    await call()
    await call({ ip: '::1' })
    await call({ ip: '192.0.2.5' })
    await call({ ip: '198.51.100.9', keyName: 'phone' })
    expect(records.map(r => [r.source, r.keyName])).toEqual([['local', null], ['local', null], ['lan', null], ['public', 'phone']])
  })
})

describe('/upstream', () => {
  test('passes through to a running model, 503 when not running, never loads', async () => {
    const { base, post, ups, inflight } = setup()
    const r0 = await fetch(`${base}/upstream/Alpha/props`)
    expect(r0.status).toBe(503)
    expect(ups.length).toBe(0)
    await (await post('/v1/chat/completions', { model: 'Alpha:RP' })).json()
    const r1 = await fetch(`${base}/upstream/a/props?q=1`)
    expect(await r1.json()).toEqual({ model: 'a', profile: 'RP' })
    expect(ups[0]!.requests.at(-1)!.path).toBe('/props?q=1')
    const r2 = await fetch(`${base}/upstream/Alpha`, { redirect: 'manual' })
    expect(r2.status).toBe(308)
    expect(r2.headers.get('location')).toBe('/upstream/Alpha/')
    expect((await fetch(`${base}/upstream/Nope/x`)).status).toBe(404)
    expect(inflight()).toBe(0)
  })

  test('upstream 500 is passed through and the lease released', async () => {
    const { base, post, inflight } = setup()
    await (await post('/v1/chat/completions', { model: 'Alpha' })).json()
    const r = await fetch(`${base}/upstream/Alpha/boom`)
    expect(r.status).toBe(500)
    await r.text()
    expect(inflight()).toBe(0)
  })
})

describe('bounded()', () => {
  test('resolves/rejects with the promise and leaves no abort listener behind', async () => {
    const ac = new AbortController()
    let added = 0
    let removed = 0
    const add = ac.signal.addEventListener.bind(ac.signal)
    const remove = ac.signal.removeEventListener.bind(ac.signal)
    ;(ac.signal as any).addEventListener = (t: string, l: any, o?: any) => { added++; return add(t, l, o) }
    ;(ac.signal as any).removeEventListener = (t: string, l: any, o?: any) => { removed++; return remove(t, l, o) }
    for (let i = 0; i < 1000; i++) expect(await bounded(Promise.resolve(i), ac.signal)).toBe(i)
    expect(await bounded(Promise.reject(new Error('x')), ac.signal).catch(e => e.message)).toBe('x')
    expect(added).toBe(1001)
    expect(removed).toBe(1001)
    expect(activeBoundedWaits()).toBe(0)
  })

  test('rejects early on abort or timeout', async () => {
    const ac = new AbortController()
    const never = new Promise<void>(() => {})
    const p = bounded(never, ac.signal).catch(e => e)
    ac.abort(new Error('gone'))
    expect((await p).message).toBe('gone')
    expect((await bounded(never, new AbortController().signal, 20).catch(e => e)).message).toContain('timed out')
    expect((await bounded(never, ac.signal).catch(e => e)).message).toBe('gone') // already aborted
  })
})
