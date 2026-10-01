// Public entry rules (plan 核心行为规则 · 来源识别): only /v1/* with a valid Bearer key, source
// marked in-process, everything else 404, loopback only.
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultSettings, type ModelsDoc } from '../../server/core/config'
import { authenticate, createKey, defaultSecrets, revokeKey, type SecretsDoc } from '../../server/core/keys'
import { createProxy } from '../../server/core/proxy'
import {
  handlePublic, isPublicPath, PUBLIC_HOST, PublicListener, type PublicServe, type PublicServeOptions,
} from '../../server/core/public-entry'
import type { RequestMeta, RequestRecord } from '../../server/core/request-log'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function secrets(): { doc: SecretsDoc, phone: string, old: string } {
  const doc = defaultSecrets()
  const phone = createKey(doc, '手机').key
  const oldKey = createKey(doc, '旧电脑')
  revokeKey(doc, oldKey.id)
  return { doc, phone, old: oldKey.key }
}

/** handlePublic with a stub /v1 handler that records what it was given. */
function stubbed() {
  const { doc, phone, old } = secrets()
  const calls: Array<{ path: string, meta: RequestMeta }> = []
  const authCalls: Array<string | null> = []
  const deps = {
    authenticate: (h: string | null) => { authCalls.push(h); return authenticate(doc, h) },
    handleV1: async (req: Request, meta: RequestMeta) => {
      calls.push({ path: new URL(req.url).pathname, meta })
      return Response.json({ ok: true })
    },
  }
  const send = (path: string, headers: Record<string, string> = {}, ip: string | null = '127.0.0.1') =>
    handlePublic(new Request(`http://127.0.0.1:8080${path}`, { method: 'POST', headers, body: '{}' }), deps, ip)
  return { calls, authCalls, send, phone, old, doc }
}

const bearer = (k: string) => ({ authorization: `Bearer ${k}` })

describe('handlePublic: paths', () => {
  const NOT_PUBLIC = [
    '/', '/index.html', '/settings', '/_nuxt/entry.js', '/favicon.ico',
    '/api/state', '/api/stream', '/api/keys', '/api/settings', '/api/models/a/start',
    '/upstream/Alpha/', '/upstream/Alpha/props',
    '/v1', '/v1x/models', '/V1/models', '//v1/models',
    '/v1/%2e%2e/api/state', '/v1/..%2fprops', '/v1/models%5c..%5cprops', '/v1/%2E%2E/slots',
  ]

  test('every path outside /v1/* is 404 even with a valid key, and the key is not even checked', async () => {
    const s = stubbed()
    for (const p of NOT_PUBLIC) {
      const res = await s.send(p, bearer(s.phone))
      expect({ p, status: res.status }).toEqual({ p, status: 404 })
      expect(await res.text()).toBe('Not Found')
    }
    expect(s.calls).toEqual([])
    expect(s.authCalls).toEqual([])
  })

  test('dot segments are resolved before the check (/v1/../api → /api)', async () => {
    const s = stubbed()
    expect((await s.send('/v1/../api/state', bearer(s.phone))).status).toBe(404)
    expect((await s.send('/v1/./models/../../upstream/a/props', bearer(s.phone))).status).toBe(404)
    expect(s.calls).toEqual([])
  })

  test('isPublicPath', () => {
    expect(isPublicPath('/v1/chat/completions')).toBe(true)
    expect(isPublicPath('/v1/models')).toBe(true)
    expect(isPublicPath('/v1')).toBe(false)
    expect(isPublicPath('/v1/a\\b')).toBe(false)
  })
})

describe('handlePublic: API key', () => {
  test('no key, wrong scheme, unknown key and revoked key are 401 and never reach /v1', async () => {
    const s = stubbed()
    const cases: Array<Record<string, string>> = [
      {}, { authorization: '' }, { authorization: s.phone }, { authorization: `Basic ${s.phone}` },
      bearer('sk-guess'), bearer(s.old), bearer(`${s.phone}0`),
      // A key in other places is not accepted.
      { 'x-api-key': s.phone }, { cookie: `key=${s.phone}` },
    ]
    for (const h of cases) {
      const res = await s.send('/v1/chat/completions', h)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      const body = await res.json() as any
      expect(body.error.code).toBe('invalid_api_key')
      // Same answer whatever the reason: no hint that a key exists or was revoked.
      expect(JSON.stringify(body)).not.toContain(s.phone)
    }
    expect(s.calls).toEqual([])
  })

  test('a valid key reaches /v1 with the key name as source, plus the socket address', async () => {
    const s = stubbed()
    const res = await s.send('/v1/chat/completions', bearer(s.phone), '127.0.0.1')
    expect(res.status).toBe(200)
    expect(s.calls).toEqual([{ path: '/v1/chat/completions', meta: { ip: '127.0.0.1', keyName: '手机' } }])
  })

  test('/v1/models also needs a key', async () => {
    const s = stubbed()
    expect((await handlePublic(new Request('http://127.0.0.1:8080/v1/models'), { authenticate: h => authenticate(s.doc, h), handleV1: async () => new Response('x') })).status).toBe(401)
  })

  test('client headers cannot set the source or key name', async () => {
    const s = stubbed()
    await s.send('/v1/chat/completions', {
      ...bearer(s.phone), 'x-llama-web-key': 'admin', 'x-llama-web-source': 'local', 'x-forwarded-for': '192.168.1.5',
    }, null)
    expect(s.calls[0]!.meta).toEqual({ ip: null, keyName: '手机' })
  })

  test('revoking takes effect on the next request', async () => {
    const s = stubbed()
    expect((await s.send('/v1/chat/completions', bearer(s.phone))).status).toBe(200)
    revokeKey(s.doc, s.doc.apiKeys[0]!.id)
    expect((await s.send('/v1/chat/completions', bearer(s.phone))).status).toBe(401)
  })

  test('an error inside /v1 becomes a plain 500 without details', async () => {
    const { doc, phone } = secrets()
    const res = await handlePublic(new Request('http://127.0.0.1:8080/v1/chat/completions', { headers: bearer(phone) }), {
      authenticate: h => authenticate(doc, h),
      handleV1: async () => { throw new Error('secret path X:\\models\\a.gguf') },
    })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('models')
  })
})

describe('PublicListener', () => {
  function fakeServe() {
    const started: PublicServeOptions[] = []
    let stopped = 0
    let failNext: Error | null = null
    const serve: PublicServe = (opts) => {
      if (failNext) { const e = failNext; failNext = null; throw e }
      started.push(opts)
      return { stop: () => { stopped++ } }
    }
    return { serve, started, get stopped() { return stopped }, fail(e: Error) { failNext = e } }
  }
  const handler = async () => new Response('x')

  test('without a listener implementation (nuxt dev) it reports unavailable and does nothing', () => {
    const l = new PublicListener(handler)
    expect(l.apply({ enabled: true, port: 8080 })).toEqual({ state: 'unavailable' })
  })

  test('starts on 127.0.0.1 only, restarts only when enabled / port change, stops when disabled', () => {
    const f = fakeServe()
    const l = new PublicListener(handler)
    l.attach(f.serve)
    expect(l.status()).toEqual({ state: 'off' })
    expect(l.apply({ enabled: false, port: 8080 })).toEqual({ state: 'off' })
    expect(f.started.length).toBe(0)

    expect(l.apply({ enabled: true, port: 8080 })).toEqual({ state: 'listening', host: '127.0.0.1', port: 8080 })
    expect(f.started.map(o => [o.hostname, o.port])).toEqual([['127.0.0.1', 8080]])
    expect(f.started[0]!.fetch).toBe(handler)

    l.apply({ enabled: true, port: 8080 })
    expect(f.started.length).toBe(1)

    l.apply({ enabled: true, port: 8081 })
    expect(f.stopped).toBe(1)
    expect(f.started.map(o => [o.hostname, o.port])).toEqual([['127.0.0.1', 8080], ['127.0.0.1', 8081]])

    expect(l.apply({ enabled: false, port: 8081 })).toEqual({ state: 'off' })
    expect(f.stopped).toBe(2)
  })

  test('a failed bind is reported and retried on the next apply', () => {
    const f = fakeServe()
    const l = new PublicListener(handler)
    l.attach(f.serve)
    f.fail(new Error('EADDRINUSE'))
    expect(l.apply({ enabled: true, port: 8080 })).toEqual({ state: 'error', port: 8080, detail: 'EADDRINUSE' })
    expect(l.apply({ enabled: true, port: 8080 }).state).toBe('listening')
  })

  test('close stops the listener', () => {
    const f = fakeServe()
    const l = new PublicListener(handler)
    l.attach(f.serve)
    l.apply({ enabled: true, port: 8080 })
    l.close()
    expect(f.stopped).toBe(1)
    expect(l.status()).toEqual({ state: 'off' })
  })
})

// ---------------------------------------------------------------------------------------
// End to end over real sockets: public listener → real /v1 proxy → fake llama-server.

describe('public entry over HTTP', () => {
  const MODELS: ModelsDoc = {
    version: 1,
    models: [{
      id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null,
      activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' } },
    }],
  }

  function setup() {
    const upstreamSeen: Array<{ path: string, headers: Headers }> = []
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        upstreamSeen.push({ path: new URL(req.url).pathname, headers: req.headers })
        await req.text()
        return Response.json({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
      },
    })
    cleanups.push(() => upstream.stop(true))
    let released = 0
    const scheduler = {
      acquire: async (target: any) => ({ target, port: upstream.port!, signal: new AbortController().signal, release: () => { released++ } }),
      snapshot: () => ({ models: [{ modelId: 'a', profile: 'default', state: 'ready' }], queue: [] }),
      stateOf: () => 'ready',
    }
    const records: RequestRecord[] = []
    const proxy = createProxy({
      scheduler: scheduler as any, getModels: () => MODELS, getSettings: defaultSettings, onRequest: r => records.push(r),
    })
    const { doc, phone, old } = secrets()
    let bound: ReturnType<typeof Bun.serve> | null = null
    const listener = new PublicListener((req, ip) => handlePublic(req, { authenticate: h => authenticate(doc, h), handleV1: proxy.handleV1 }, ip))
    listener.attach((opts) => {
      // Port 0 in the test so it never collides; the address is still the fixed loopback host.
      bound = Bun.serve({ hostname: opts.hostname, port: 0, fetch: (req, srv) => opts.fetch(req, srv.requestIP(req)?.address ?? null) })
      const s = bound
      return { stop: () => void s.stop(true) }
    })
    listener.apply({ enabled: true, port: 18080 })
    cleanups.push(() => listener.close())
    const base = `http://127.0.0.1:${bound!.port}`
    return { base, bound: bound!, upstreamSeen, records, phone, old, released: () => released, listener }
  }

  const chat = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'Alpha', messages: [] }),
  })

  test('listens on loopback only', () => {
    const s = setup()
    expect(s.bound.hostname).toBe(PUBLIC_HOST)
  })

  test('valid key: forwarded without the Authorization header, recorded as public with the key name', async () => {
    const s = setup()
    const res = await chat(s.base, { ...bearer(s.phone), 'x-llama-web-key': 'forged' })
    expect(res.status).toBe(200)
    expect((await res.json() as any).choices[0].message.content).toBe('hi')
    expect(s.upstreamSeen.length).toBe(1)
    expect(s.upstreamSeen[0]!.headers.get('authorization')).toBeNull()
    expect(s.upstreamSeen[0]!.headers.get('x-llama-web-key')).toBeNull()
    expect(s.records.length).toBe(1)
    expect(s.records[0]).toMatchObject({ source: 'public', keyName: '手机', modelId: 'a', status: 200 })
    expect(JSON.stringify(s.records[0])).not.toContain(s.phone)
    expect(s.released()).toBe(1)
  })

  test('no key / revoked key: 401, upstream never called, nothing recorded', async () => {
    const s = setup()
    expect((await chat(s.base)).status).toBe(401)
    expect((await chat(s.base, bearer(s.old))).status).toBe(401)
    expect(s.upstreamSeen).toEqual([])
    expect(s.records).toEqual([])
  })

  test('management paths, pages, /upstream and the live stream are 404 over the socket', async () => {
    const s = setup()
    for (const p of ['/', '/settings', '/api/state', '/api/stream', '/api/keys', '/upstream/Alpha/props', '/_nuxt/app.js']) {
      for (const method of ['GET', 'POST']) {
        const res = await fetch(`${s.base}${p}`, { method, headers: bearer(s.phone) })
        expect({ p, method, status: res.status }).toEqual({ p, method, status: 404 })
      }
    }
    expect(s.upstreamSeen).toEqual([])
  })

  test('the same request on the main entry (no key name) is recorded as local, whatever its headers say', async () => {
    const { phone } = secrets()
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => Response.json({ ok: true }) })
    cleanups.push(() => upstream.stop(true))
    const records: RequestRecord[] = []
    const scheduler = {
      acquire: async (target: any) => ({ target, port: upstream.port!, signal: new AbortController().signal, release() {} }),
      snapshot: () => ({ models: [{ modelId: 'a', profile: 'default', state: 'ready' }], queue: [] }),
      stateOf: () => 'ready',
    }
    const proxy = createProxy({ scheduler: scheduler as any, getModels: () => MODELS, getSettings: defaultSettings, onRequest: r => records.push(r) })
    const req = new Request('http://127.0.0.1:5001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(phone), 'x-llama-web-key': 'phone', 'x-llama-web-source': 'public' },
      body: JSON.stringify({ model: 'Alpha' }),
    })
    await (await proxy.handleV1(req, { ip: '127.0.0.1' })).text()
    expect(records[0]).toMatchObject({ source: 'local', keyName: null })
  })

  test('turning it off closes the port', async () => {
    const s = setup()
    expect((await chat(s.base, bearer(s.phone))).status).toBe(200)
    s.listener.apply({ enabled: false, port: 18080 })
    let failed = false
    try { await chat(s.base, bearer(s.phone)) } catch { failed = true }
    expect(failed).toBe(true)
  })
})
