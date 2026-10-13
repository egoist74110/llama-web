// multipart/form-data on /v1 (audio transcriptions, image edits): the `model` form field routes exactly like the JSON
// field. External upstreams get the prefix stripped (new boundary, every other part byte-exact); local llama-server
// targets get the body unchanged. Body limit, public-entry key check, upstream key and request records still apply.
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultSettings, type ModelConfig, type ModelsDoc } from '../../server/core/config'
import { authenticate, createKey, defaultSecrets } from '../../server/core/keys'
import { multipartBoundary, multipartField, parseMultipart, rewriteMultipartField } from '../../server/core/multipart'
import { createProxy } from '../../server/core/proxy'
import { handlePublic } from '../../server/core/public-entry'
import type { RequestRecord } from '../../server/core/request-log'
import type { Lease, ModelSnapshot, Target } from '../../server/core/scheduler'
import { createUpstream, defaultUpstreams, type UpstreamsDoc } from '../../server/core/upstreams'

const local: ModelConfig = {
  id: 'm1', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null,
  activeProfile: 'main', profiles: { main: { overrides: {}, extraArgs: '' }, fast: { overrides: {}, extraArgs: '' } },
}
const MODELS: ModelsDoc = { version: 1, models: [local] }
const UPSTREAM_KEY = 'sk-upstream-own-key-0123456789' // pre-commit:allow fake test key
const CLIENT_KEY = 'sk-client-key-should-not-travel' // pre-commit:allow fake test key

/** Bytes that look like multipart syntax on purpose: CRLFs, dashes, a fake boundary, a NUL. */
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 13, 10, 45, 45, 13, 10, 13, 10, 0, 255, 45, 45, 120, 13, 10, 45, 45, 45, 45, 45, 45, 65, 66, 13, 10, 254])

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

interface Seen { path: string, headers: Headers, raw: Uint8Array }

/** A pretend server (external upstream or llama-server) that records the raw request. */
function fakeServer() {
  const seen: Seen[] = []
  const srv = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, headers: req.headers, raw: new Uint8Array(await req.arrayBuffer()) })
      return Response.json({ text: 'hello', usage: { prompt_tokens: 2, completion_tokens: 1 } })
    },
  })
  closers.push(() => srv.stop(true))
  return { seen, url: `http://127.0.0.1:${srv.port}/v1`, port: srv.port }
}

function setup(opts: { upstreamUrl?: string, localPort?: number, running?: ModelSnapshot[], maxBodyBytes?: number } = {}) {
  const doc: UpstreamsDoc = defaultUpstreams()
  createUpstream(doc, { name: 'MOSS', baseUrl: opts.upstreamUrl ?? 'http://127.0.0.1:9/v1', imageCompress: 'inherit', manualModels: ['Example-Team/Transcribe-X'] }, { localNames: [], selfPorts: [] })
  const id = doc.upstreams[0]!.id
  const records: RequestRecord[] = []
  const events: unknown[] = []
  const acquired: Target[] = []
  const proxy = createProxy({
    scheduler: {
      acquire: async (target: Target): Promise<Lease> => {
        acquired.push(target)
        if (!opts.localPort) throw new Error('no local server in this test')
        return { target, port: opts.localPort, signal: new AbortController().signal, release() {} }
      },
      snapshot: () => ({ models: opts.running ?? [], queue: [] }),
      stateOf: () => 'ready',
    },
    getModels: () => MODELS, getSettings: () => defaultSettings(), maxBodyBytes: opts.maxBodyBytes,
    getUpstreams: () => doc, getUpstreamKey: i => (i === id ? UPSTREAM_KEY : ''),
    onRequest: r => records.push(r), onEvent: e => events.push(e),
  })
  return { proxy, records, events, acquired, id }
}

function form(model: string | null, extra: Record<string, string> = {}): FormData {
  const f = new FormData()
  f.append('file', new File([AUDIO], 'clip-1.wav', { type: 'audio/wav' }))
  if (model !== null) f.append('model', model)
  for (const [k, v] of Object.entries(extra)) f.append(k, v)
  return f
}

const send = (body: FormData | Uint8Array, headers: Record<string, string> = {}, path = '/v1/audio/transcriptions') =>
  new Request(`http://127.0.0.1:3000${path}`, { method: 'POST', headers, body: body as BodyInit })

async function readForm(s: Seen): Promise<FormData> {
  return new Request('http://x/', { method: 'POST', headers: { 'content-type': s.headers.get('content-type')! }, body: s.raw as BodyInit }).formData()
}

describe('multipart module', () => {
  test('boundary from the content type', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc')
    expect(multipartBoundary('Multipart/Form-Data; charset=utf-8; boundary="a b:c"')).toBe('a b:c')
    expect(multipartBoundary('application/json')).toBeNull()
    expect(multipartBoundary('multipart/form-data')).toBeNull()
    expect(multipartBoundary('multipart/mixed; boundary=abc')).toBeNull()
  })

  test('parse, read the model field, rewrite it under a new boundary; other parts byte-exact', async () => {
    const req = new Request('http://x/', { method: 'POST', body: form('MOSS-a/b', { prompt: 'p', language: 'zh' }) })
    const ct = req.headers.get('content-type')!
    const raw = new Uint8Array(await req.arrayBuffer())
    const parts = parseMultipart(raw, multipartBoundary(ct)!)!
    expect(parts.map(p => [p.name, p.file])).toEqual([['file', true], ['model', false], ['prompt', false], ['language', false]])
    expect(multipartField(parts, 'model')).toBe('MOSS-a/b')
    expect(multipartField(parts, 'file')).toBeUndefined() // a file is not a text field
    const out = rewriteMultipartField(parts, 'model', 'a/b')
    expect(out.contentType).not.toBe(ct)
    const again = parseMultipart(out.body, multipartBoundary(out.contentType)!)!
    expect(again).toHaveLength(4)
    expect(multipartField(again, 'model')).toBe('a/b')
    for (const i of [0, 2, 3]) {
      expect(again[i]!.head).toEqual(parts[i]!.head)
      expect(again[i]!.body).toEqual(parts[i]!.body)
    }
    expect(again[0]!.body).toEqual(AUDIO)
  })

  test('hand-written bodies: preamble, part without headers, quoted names; malformed bodies are null', () => {
    const e = new TextEncoder()
    const ok = e.encode('preamble\r\n--XX\r\nContent-Disposition: form-data; name="model"\r\n\r\nAlpha:fast\r\n--XX\r\n\r\nheaderless\r\n--XX--\r\nepilogue')
    const parts = parseMultipart(ok, 'XX')!
    expect(parts).toHaveLength(2)
    expect(multipartField(parts, 'model')).toBe('Alpha:fast')
    expect(new TextDecoder().decode(parts[1]!.body)).toBe('headerless')
    const round = rewriteMultipartField(parts, 'model', 'x')
    const back = parseMultipart(round.body, multipartBoundary(round.contentType)!)!
    expect(new TextDecoder().decode(back[1]!.body)).toBe('headerless')
    expect(back[1]!.head.length).toBe(0)
    expect(parseMultipart(e.encode('--XX\r\nContent-Disposition: form-data; name="model"\r\n\r\nAlpha'), 'XX')).toBeNull()
    expect(parseMultipart(e.encode('nothing here'), 'XX')).toBeNull()
  })
})

describe('multipart routing on /v1', () => {
  test('<prefix>-<id> goes to the external upstream with the prefix stripped, other fields and the file intact, the upstream key', async () => {
    const up = fakeServer()
    const s = setup({ upstreamUrl: up.url })
    const res = await s.proxy.handleV1(send(form('MOSS-Example-Team/Transcribe-X', { prompt: 'secret words', response_format: 'json' }), { authorization: `Bearer ${CLIENT_KEY}` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: 'hello' })
    expect(up.seen).toHaveLength(1)
    const seen = up.seen[0]!
    expect(seen.path).toBe('/v1/audio/transcriptions')
    expect(seen.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(JSON.stringify(Object.fromEntries(seen.headers))).not.toContain(CLIENT_KEY)
    expect(seen.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=----llama-web-/)
    const f = await readForm(seen)
    expect(f.get('model')).toBe('Example-Team/Transcribe-X')
    expect(f.get('prompt')).toBe('secret words')
    expect(f.get('response_format')).toBe('json')
    const file = f.get('file') as File
    expect(file.name).toBe('clip-1.wav')
    // part headers byte-exact too (FormData parsing normalizes the type, so compare the raw head)
    const parts = parseMultipart(seen.raw, multipartBoundary(seen.headers.get('content-type')!)!)!
    expect(new TextDecoder().decode(parts[0]!.head)).toBe('Content-Disposition: form-data; name="file"; filename="clip-1.wav"\r\nContent-Type: audio/wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO)
    expect(s.acquired).toHaveLength(0)
  })

  test('the request record names the external model and has no file or form text; events have no key', async () => {
    const up = fakeServer()
    const s = setup({ upstreamUrl: up.url })
    await (await s.proxy.handleV1(send(form('MOSS-Example-Team/Transcribe-X', { prompt: 'secret words' })))).text()
    expect(s.records).toHaveLength(1)
    expect(s.records[0]).toMatchObject({ modelName: 'MOSS-Example-Team/Transcribe-X', modelId: `upstream:${s.id}`, status: 200, outcome: 'ok', params: {}, images: null, promptTokens: 2, completionTokens: 1 })
    const dump = JSON.stringify(s.records) + JSON.stringify(s.events)
    expect(dump).not.toContain('secret words')
    expect(dump).not.toContain('RIFF')
    expect(dump).not.toContain('clip')
    expect(dump).not.toContain(UPSTREAM_KEY)
  })

  test('a local model (name:profile) gets the body byte for byte, without any rewrite', async () => {
    const llama = fakeServer()
    const s = setup({ localPort: llama.port })
    const req = send(form('Alpha:fast', { prompt: 'p' }))
    const ct = req.headers.get('content-type')!
    const sent = new Uint8Array(await req.clone().arrayBuffer())
    const res = await s.proxy.handleV1(req)
    expect(res.status).toBe(200)
    await res.text()
    expect(s.acquired).toEqual([{ modelId: 'm1', profile: 'fast' }])
    expect(llama.seen[0]!.path).toBe('/v1/audio/transcriptions')
    expect(llama.seen[0]!.raw).toEqual(sent)
    expect(llama.seen[0]!.headers.get('content-type')).toBe(ct)
    expect(s.records[0]).toMatchObject({ modelName: 'Alpha', profile: 'fast' })
  })

  test('an unknown model name in the form is 404 like in JSON', async () => {
    const s = setup()
    const res = await s.proxy.handleV1(send(form('Nobody')))
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('model_not_found')
  })

  test('no model field: same as JSON without model (400 no_model, or the running model)', async () => {
    const s = setup()
    const multi = await s.proxy.handleV1(send(form(null)))
    const json = await s.proxy.handleV1(new Request('http://127.0.0.1:3000/v1/audio/transcriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    expect(multi.status).toBe(400)
    expect(await multi.json()).toEqual(await json.json())

    const llama = fakeServer()
    const running: ModelSnapshot[] = [{ modelId: 'm1', profile: 'main', state: 'ready', port: llama.port, inflight: 0, lastUsedAt: 1, error: null }]
    const r = setup({ localPort: llama.port, running })
    const res = await r.proxy.handleV1(send(form(null)))
    expect(res.status).toBe(200)
    expect(r.acquired).toEqual([{ modelId: 'm1', profile: 'main' }])
  })

  test('a malformed multipart body routes like one without a model', async () => {
    const s = setup()
    const body = new TextEncoder().encode('--XX\r\nContent-Disposition: form-data; name="model"\r\n\r\nMOSS-x')
    const res = await s.proxy.handleV1(send(body, { 'content-type': 'multipart/form-data; boundary=XX' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('no_model')
  })

  test('an oversize multipart body is 413 and never reaches the upstream', async () => {
    const up = fakeServer()
    const s = setup({ upstreamUrl: up.url, maxBodyBytes: 1024 })
    const big = new FormData()
    big.append('model', 'MOSS-Example-Team/Transcribe-X')
    big.append('file', new File([new Uint8Array(4096)], 'big.wav', { type: 'audio/wav' }))
    const res = await s.proxy.handleV1(send(big))
    expect(res.status).toBe(413)
    expect(((await res.json()) as any).error.code).toBe('body_too_large')
    expect(up.seen).toHaveLength(0)
  })

  test('from the public entry a multipart request needs llama-web\'s key; the upstream key replaces it', async () => {
    const up = fakeServer()
    const s = setup({ upstreamUrl: up.url })
    const secrets = defaultSecrets()
    const phone = createKey(secrets, '手机').key
    const deps = { authenticate: (h: string | null) => authenticate(secrets, h), handleV1: (r: Request, meta: any) => s.proxy.handleV1(r, meta) }
    const pub = (headers: Record<string, string>) => handlePublic(new Request('http://127.0.0.1:8080/v1/audio/transcriptions', {
      method: 'POST', headers, body: form('MOSS-Example-Team/Transcribe-X'),
    }), deps, '127.0.0.1')
    expect((await pub({})).status).toBe(401)
    expect((await pub({ authorization: `Bearer ${CLIENT_KEY}` })).status).toBe(401)
    expect(up.seen).toHaveLength(0)
    const ok = await pub({ authorization: `Bearer ${phone}` })
    expect(ok.status).toBe(200)
    await ok.text()
    expect(up.seen[0]!.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(JSON.stringify(Object.fromEntries(up.seen[0]!.headers))).not.toContain(phone)
    expect((await readForm(up.seen[0]!)).get('model')).toBe('Example-Team/Transcribe-X')
    expect(s.records.at(-1)).toMatchObject({ source: 'public', keyName: '手机' })
  })
})
