// Forwarding to an external upstream (decision 56): prefix routing, the upstream's own key instead of the client's,
// image compression per upstream, no scheduler involved, public-entry authentication still in front.
import { afterEach, expect, test } from 'bun:test'
import sharp from 'sharp'
import { defaultSettings, type ModelConfig, type ModelsDoc, type Settings } from '../../server/core/config'
import { authenticate, createKey, defaultSecrets } from '../../server/core/keys'
import { createProxy } from '../../server/core/proxy'
import { handlePublic } from '../../server/core/public-entry'
import type { RequestRecord } from '../../server/core/request-log'
import { createUpstream, defaultUpstreams, updateUpstream, type ImageCompressMode, type UpstreamsDoc } from '../../server/core/upstreams'

const local: ModelConfig = {
  id: 'm1', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null,
  activeProfile: '默认', profiles: { 默认: { overrides: {}, extraArgs: '' } },
}
const MODELS: ModelsDoc = { version: 1, models: [local] }
const UPSTREAM_KEY = 'sk-upstream-own-key-0123456789' // pre-commit:allow fake test key

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

interface Seen { method: string, path: string, headers: Headers, body: any, aborted: boolean }

/** A pretend external engine. `hang`: the response body never ends (streams). */
function fakeUpstream(opts: { hang?: boolean, status?: number } = {}) {
  const seen: Seen[] = []
  const srv = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text()
      const entry: Seen = { method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers, body: text ? JSON.parse(text) : null, aborted: false }
      seen.push(entry)
      req.signal.addEventListener('abort', () => { entry.aborted = true })
      if (opts.hang) {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n')) } }), { headers: { 'content-type': 'text/event-stream', 'x-upstream-secret-header': 'ok' } })
      }
      return Response.json({ id: 'r', usage: { prompt_tokens: 3, completion_tokens: 4 }, echoedModel: entry.body?.model }, { status: opts.status ?? 200 })
    },
  })
  closers.push(() => srv.stop(true))
  return { seen, url: `http://127.0.0.1:${srv.port}/v1`, port: srv.port }
}

function setup(opts: { upstreamUrl: string, mode?: ImageCompressMode, settings?: Settings, key?: string, models?: ModelsDoc, exclusive?: boolean }) {
  const doc: UpstreamsDoc = defaultUpstreams()
  createUpstream(doc, { name: 'Strata', baseUrl: opts.upstreamUrl, imageCompress: opts.mode ?? 'inherit', manualModels: ['qwen-x'] }, { localNames: [], selfPorts: [] })
  const id = doc.upstreams[0]!.id
  const keys: Record<string, string> = { [id]: opts.key ?? UPSTREAM_KEY }
  const records: RequestRecord[] = []
  const events: unknown[] = []
  let acquired = 0
  const proxy = createProxy({
    scheduler: {
      acquire: () => { acquired++; return Promise.reject(new Error('the scheduler must not be used for an external model')) },
      snapshot: () => ({ models: [], queue: [] }),
      stateOf: () => 'stopped',
    },
    getModels: () => opts.models ?? MODELS, getSettings: () => opts.settings ?? defaultSettings(), heartbeatMs: 10,
    getUpstreams: () => doc, getUpstreamKey: i => keys[i] ?? '',
    onRequest: r => records.push(r), onEvent: e => events.push(e),
  })
  const front = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => proxy.handleV1(req) })
  closers.push(() => front.stop(true))
  const base = `http://127.0.0.1:${front.port}`
  const post = (body: unknown, headers: Record<string, string> = {}, path = '/v1/chat/completions') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { doc, id, post, base, records, events, acquired: () => acquired, proxy }
}

test('<prefix>-<id> goes to the upstream with its own id, the upstream key and without the client key', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  const res = await s.post({ model: 'Strata-qwen-x', messages: [{ role: 'user', content: 'secret words' }] }, { authorization: 'Bearer sk-client-key-should-not-travel' }) // pre-commit:allow fake test key
  expect(res.status).toBe(200)
  const body = await res.json() as { echoedModel: string }
  expect(body.echoedModel).toBe('qwen-x')
  expect(up.seen).toHaveLength(1)
  expect(up.seen[0]!.path).toBe('/v1/chat/completions')
  expect(up.seen[0]!.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
  expect(JSON.stringify(Object.fromEntries(up.seen[0]!.headers))).not.toContain('sk-client-key')
  expect(s.acquired()).toBe(0)
})

test('every client parameter (thinking, sampling, tools, unknown fields) reaches the upstream untouched; only the model id changes', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  const sent = {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
    reasoning_effort: 'high', chat_template_kwargs: { enable_thinking: true, thinking_budget: 8192 }, enable_thinking: true,
    thinking: { type: 'enabled', budget_tokens: 4096 }, temperature: 0.6, top_p: 0.95, top_k: 20, max_tokens: 2048, max_completion_tokens: 4096,
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], tool_choice: 'auto', some_vendor_field: { x: 1 },
  }
  await (await s.post({ model: 'Strata-qwen-x', ...sent })).text()
  expect(up.seen[0]!.body).toEqual({ model: 'qwen-x', ...sent })
})

test('the request record names the external model and carries neither the key nor the conversation', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  await (await s.post({ model: 'Strata-qwen-x', messages: [{ role: 'user', content: 'secret words' }] })).text()
  expect(s.records).toHaveLength(1)
  const r = s.records[0]!
  expect(r).toMatchObject({ modelName: 'Strata-qwen-x', modelId: `upstream:${s.id}`, status: 200, outcome: 'ok', promptTokens: 3, completionTokens: 4 })
  const dump = JSON.stringify(r) + JSON.stringify(s.events)
  expect(dump).not.toContain(UPSTREAM_KEY)
  expect(dump).not.toContain('secret words')
})

test('an upstream without a key gets no Authorization header at all', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url, key: '' })
  await (await s.post({ model: 'Strata-q' }, { authorization: 'Bearer sk-client' })).text()
  expect(up.seen[0]!.headers.get('authorization')).toBeNull()
})

test('the query string and other paths are kept, /v1 is replaced by the upstream address', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  await (await s.post({ model: 'Strata-q', input: 'x' }, {}, '/v1/embeddings?x=1')).text()
  expect(up.seen[0]!.path).toBe('/v1/embeddings?x=1')
})

test('GET /v1/models lists the upstream models next to the local ones', async () => {
  const s = setup({ upstreamUrl: 'http://127.0.0.1:9/v1' })
  const list = await (await fetch(`${s.base}/v1/models`)).json() as { data: Array<{ id: string }> }
  expect(list.data.map(m => m.id)).toEqual(['Alpha', 'Strata-qwen-x'])
  expect((await fetch(`${s.base}/v1/models/Strata-qwen-x`)).status).toBe(200)
  expect((await fetch(`${s.base}/v1/models/Strata-unlisted`)).status).toBe(200)
  expect((await fetch(`${s.base}/v1/models/Nobody-x`)).status).toBe(404)
})

test('a local model of exactly that name is never shadowed; an empty model never goes to an upstream', async () => {
  const up = fakeUpstream()
  const clash: ModelsDoc = { version: 1, models: [{ ...local, id: 'm2', name: 'Strata-local' }] }
  const s = setup({ upstreamUrl: up.url, models: clash })
  const res = await s.post({ model: 'Strata-local' })
  expect(up.seen).toHaveLength(0)
  expect(s.acquired()).toBe(1) // went to the local scheduler (which refuses in this test)
  expect(res.status).toBe(500)
  const none = await s.post({ messages: [] })
  expect(none.status).toBe(400)
  expect(((await none.json()) as any).error.code).toBe('no_model')
  expect(up.seen).toHaveLength(0)
})

test('an upstream that cannot be reached is 502 with a Chinese message, the key is nowhere in it', async () => {
  const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const url = `http://127.0.0.1:${dead.port}/v1`
  dead.stop(true)
  const s = setup({ upstreamUrl: url })
  const res = await s.post({ model: 'Strata-q' })
  expect(res.status).toBe(502)
  const text = await res.text()
  expect(text).toContain('upstream_unreachable')
  expect(text).toContain('Strata')
  expect(text).not.toContain(UPSTREAM_KEY)
  expect(s.records[0]).toMatchObject({ status: 502, outcome: 'error', error: 'upstream_unreachable' })
})

test('an error answer of the upstream passes through unchanged', async () => {
  const up = fakeUpstream({ status: 429 })
  const s = setup({ upstreamUrl: up.url })
  const res = await s.post({ model: 'Strata-q' })
  expect(res.status).toBe(429)
  expect(s.records[0]).toMatchObject({ status: 429, outcome: 'error' })
})

test('a streaming answer is passed on, and the upstream request is aborted when the client leaves', async () => {
  const up = fakeUpstream({ hang: true })
  const s = setup({ upstreamUrl: up.url })
  const ac = new AbortController()
  const res = await fetch(`${s.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Strata-q', stream: true }), signal: ac.signal })
  const reader = res.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('data: {"x":1}')
  ac.abort()
  const end = Date.now() + 3000
  while (!up.seen[0]!.aborted && Date.now() < end) await new Promise(r => setTimeout(r, 20))
  expect(up.seen[0]!.aborted).toBe(true)
})

// --- image compression per upstream -------------------------------------------------------

const png = async (w: number, h: number) => (await sharp({ create: { width: w, height: h, channels: 3, background: '#3366aa' } }).png().toBuffer()).toString('base64')

async function sentImageWidth(opts: { mode: ImageCompressMode, globalEnabled: boolean }) {
  const up = fakeUpstream()
  const settings = defaultSettings()
  settings.preprocess.image = { ...settings.preprocess.image, enabled: opts.globalEnabled, maxEdge: 100 }
  const s = setup({ upstreamUrl: up.url, mode: opts.mode, settings })
  const data = await png(400, 200)
  await (await s.post({ model: 'Strata-q', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }] })).text()
  const url: string = up.seen[0]!.body.messages[0].content[1].image_url.url
  const meta = await sharp(Buffer.from(url.split(',')[1]!, 'base64')).metadata()
  return { width: meta.width, record: s.records[0]! }
}

test('image compression: follow the global switch, force it on, force it off', async () => {
  expect((await sentImageWidth({ mode: 'inherit', globalEnabled: true })).width).toBe(100)
  expect((await sentImageWidth({ mode: 'inherit', globalEnabled: false })).width).toBe(400)
  expect((await sentImageWidth({ mode: 'on', globalEnabled: false })).width).toBe(100)
  expect((await sentImageWidth({ mode: 'off', globalEnabled: true })).width).toBe(400)
})

test('an image to an external model is not refused for a missing mmproj (the upstream decides)', async () => {
  const r = await sentImageWidth({ mode: 'inherit', globalEnabled: true })
  expect(r.record.status).toBe(200)
  expect(r.record.images).not.toBeNull()
})

// --- public entry in front ----------------------------------------------------------------

test('from the public entry a request needs llama-web\'s own key; the key is not passed on, the upstream key stays hidden', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  const secrets = defaultSecrets()
  const phone = createKey(secrets, '手机').key
  const deps = { authenticate: (h: string | null) => authenticate(secrets, h), handleV1: (r: Request, meta: any) => s.proxy.handleV1(r, meta) }
  const send = (headers: Record<string, string>) => handlePublic(new Request('http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'Strata-q' }),
  }), deps, '127.0.0.1')
  const refused = await send({})
  expect(refused.status).toBe(401)
  expect((await send({ authorization: 'Bearer sk-wrong-wrong-wrong-wrong' })).status).toBe(401) // pre-commit:allow fake test key
  expect(up.seen).toHaveLength(0)
  const ok = await send({ authorization: `Bearer ${phone}` })
  expect(ok.status).toBe(200)
  expect(up.seen[0]!.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
  expect(JSON.stringify(Object.fromEntries(up.seen[0]!.headers))).not.toContain(phone)
  expect(JSON.stringify([...ok.headers])).not.toContain(UPSTREAM_KEY)
  await ok.text()
  expect(s.records.at(-1)).toMatchObject({ source: 'public', keyName: '手机' })
})

test('after an edit the new prefix and key apply to the next request', async () => {
  const up = fakeUpstream()
  const s = setup({ upstreamUrl: up.url })
  updateUpstream(s.doc, s.id, { name: 'Renamed' }, { localNames: [], selfPorts: [] })
  expect((await s.post({ model: 'Strata-q' })).status).toBe(404)
  expect((await s.post({ model: 'Renamed-q' })).status).toBe(200)
})
