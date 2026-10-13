// Async job follow-ups (decision 59): POST /v1/videos goes to an external upstream by its `model`; the job id in the
// response is remembered (data/jobs.json) with the upstream and the caller, so GET /v1/videos/{id}, GET
// /v1/videos/{id}/content and DELETE /v1/videos/{id} - which carry no model - reach the same upstream.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isJobId, JOB_TTL_MS, JobStore, matchJobCreate, matchJobFollowUp, pruneJobs, sameOwner, type JobEntry,
} from '../../server/core/async-jobs'
import { defaultSettings, type ModelsDoc } from '../../server/core/config'
import { authenticate, createKey, defaultSecrets } from '../../server/core/keys'
import { createProxy } from '../../server/core/proxy'
import { handlePublic } from '../../server/core/public-entry'
import type { RequestRecord } from '../../server/core/request-log'
import type { Lease, Target } from '../../server/core/scheduler'
import { createUpstream, defaultUpstreams, type UpstreamsDoc } from '../../server/core/upstreams'

const MODELS: ModelsDoc = { version: 1, models: [] }
const KEY_A = 'sk-upstream-a-key-0123456789abcdef' // pre-commit:allow fake test key
const KEY_B = 'sk-upstream-b-key-fedcba9876543210' // pre-commit:allow fake test key
const CLIENT_KEY = 'sk-client-key-should-not-travel' // pre-commit:allow fake test key

/** 3 MiB of every byte value, so a lost, reordered or re-encoded byte shows. */
const VIDEO = (() => {
  const b = new Uint8Array(3 * 1024 * 1024 + 7)
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + (i >> 8)) & 255
  return b
})()

let dir: string
const closers: Array<() => unknown> = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-jobs-')) })
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  rmSync(dir, { recursive: true, force: true })
})

interface Seen { method: string, path: string, headers: Headers, body: string }

/** A pretend video service: create, status, content (streamed in chunks), delete. */
function fakeVideoService(opts: { jobId?: string, echoKey?: string, gate?: Promise<void> } = {}) {
  const seen: Seen[] = []
  const jobId = opts.jobId ?? 'video_abc123'
  const srv = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({ method: req.method, path, headers: req.headers, body: await req.text() })
      if (req.method === 'POST' && path === '/v1/videos') {
        return Response.json({ id: jobId, object: 'video', status: 'queued', note: opts.echoKey ?? '' })
      }
      if (path === `/v1/videos/${jobId}/content`) {
        let off = 0
        return new Response(new ReadableStream({
          async pull(ctrl) {
            if (off >= VIDEO.length) return ctrl.close()
            // Hold back the second half until the test has seen the first one arrive.
            if (opts.gate && off >= VIDEO.length / 2) await opts.gate
            ctrl.enqueue(VIDEO.slice(off, off + 64 * 1024 + 3))
            off += 64 * 1024 + 3
          },
        }), { headers: { 'content-type': 'video/mp4' } })
      }
      if (path === `/v1/videos/${jobId}` && req.method === 'DELETE') return Response.json({ id: jobId, deleted: true })
      if (path === `/v1/videos/${jobId}`) return Response.json({ id: jobId, object: 'video', status: 'completed', echo: opts.echoKey ?? '' })
      return Response.json({ error: { message: 'nope' } }, { status: 404 })
    },
  })
  closers.push(() => srv.stop(true))
  return { seen, url: `http://127.0.0.1:${srv.port}/v1` }
}

function setup(opts: { urlA: string, urlB?: string, now?: () => number }) {
  const doc: UpstreamsDoc = defaultUpstreams()
  createUpstream(doc, { name: 'Comfy', baseUrl: opts.urlA, imageCompress: 'inherit', manualModels: ['wan-video'] }, { localNames: [], selfPorts: [] })
  createUpstream(doc, { name: 'Other', baseUrl: opts.urlB ?? 'http://127.0.0.1:9/v1', imageCompress: 'inherit', manualModels: ['v'] }, { localNames: [], selfPorts: [] })
  const [a, b] = doc.upstreams.map(u => u.id) as [string, string]
  const records: RequestRecord[] = []
  const acquired: Target[] = []
  const jobs = new JobStore({ dataDir: dir, now: opts.now })
  const proxy = createProxy({
    scheduler: {
      acquire: async (target: Target): Promise<Lease> => { acquired.push(target); throw new Error('no local server in this test') },
      snapshot: () => ({ models: [], queue: [] }),
      stateOf: () => 'ready',
    },
    getModels: () => MODELS, getSettings: () => defaultSettings(),
    getUpstreams: () => doc, getUpstreamKey: i => (i === a ? KEY_A : i === b ? KEY_B : ''),
    onRequest: r => records.push(r),
    jobs,
  })
  return { proxy, records, acquired, jobs, a, b, doc }
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const create = (s: ReturnType<typeof setup>, model = 'Comfy-wan-video', meta?: any) =>
  s.proxy.handleV1(req('POST', '/v1/videos', { model, prompt: 'a cat', seconds: 4 }, { authorization: `Bearer ${CLIENT_KEY}` }), meta)

describe('async-jobs module', () => {
  test('create and follow-up paths', () => {
    expect(matchJobCreate('POST', '/v1/videos')?.kind).toBe('videos')
    expect(matchJobCreate('POST', '/v1/videos/')?.kind).toBe('videos')
    expect(matchJobCreate('GET', '/v1/videos')).toBeNull()
    expect(matchJobCreate('POST', '/v1/videos/x')).toBeNull()
    expect(matchJobFollowUp('GET', '/v1/videos/video_1')).toMatchObject({ id: 'video_1' })
    expect(matchJobFollowUp('GET', '/v1/videos/video_1/content')).toMatchObject({ id: 'video_1' })
    expect(matchJobFollowUp('DELETE', '/v1/videos/video_1')).toMatchObject({ id: 'video_1' })
    expect(matchJobFollowUp('POST', '/v1/videos/video_1/remix')).toBeNull()
    expect(matchJobFollowUp('GET', '/v1/videos')).toBeNull()
    expect(matchJobFollowUp('GET', '/v1/videos/')).toBeNull()
    expect(matchJobFollowUp('GET', '/v1/videos/..')).toBeNull()
    expect(matchJobFollowUp('GET', '/v1/chat/completions')).toBeNull()
    expect(isJobId('video_68d7512d07848190b3e45da0ecbebcde')).toBe(true)
    expect(isJobId('a/b')).toBe(false)
    expect(isJobId('')).toBe(false)
    expect(isJobId(42)).toBe(false)
  })

  test('owners: same key for public callers, local and LAN together, never across', () => {
    const pub = (k: string) => ({ source: 'public' as const, keyName: k })
    const priv = { source: 'private' as const }
    expect(sameOwner(pub('phone'), pub('phone'))).toBe(true)
    expect(sameOwner(pub('phone'), pub('laptop'))).toBe(false)
    expect(sameOwner(pub('phone'), priv)).toBe(false)
    expect(sameOwner(priv, pub('phone'))).toBe(false)
    expect(sameOwner(priv, priv)).toBe(true)
  })

  test('pruning drops expired entries and keeps the newest when over the cap', () => {
    const e = (id: string, at: number): JobEntry => ({ kind: 'videos', id, upstreamId: 'u', model: 'm', owner: { source: 'private' }, at })
    const now = 10 * JOB_TTL_MS
    const kept = pruneJobs([e('old', now - JOB_TTL_MS - 1), e('a', now - 3), e('b', now - 2), e('c', now - 1)], now, JOB_TTL_MS, 2)
    expect(kept.map(j => j.id)).toEqual(['b', 'c'])
  })

  test('the store survives a reload, prunes on write, expires on lookup, and keeps a backup', () => {
    let now = 1_000_000
    const e = (id: string) => ({ kind: 'videos', id, upstreamId: 'u1', model: 'Comfy-wan', owner: { source: 'public', keyName: 'phone' } })
    const s1 = new JobStore({ dataDir: dir, now: () => now, max: 3 })
    s1.record(e('j1'))
    now += 1000
    s1.record(e('j2'))
    const disk = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8'))
    expect(disk.version).toBe(1)
    expect(disk.jobs.map((j: JobEntry) => j.id)).toEqual(['j1', 'j2'])
    expect(readdirSync(join(dir, 'backups')).some(f => f.startsWith('jobs.'))).toBe(true)

    const s2 = new JobStore({ dataDir: dir, now: () => now, max: 3 })
    expect(s2.lookup('videos', 'j1')).toMatchObject({ upstreamId: 'u1', owner: { keyName: 'phone' } })
    expect(s2.lookup('images', 'j1')).toBeNull()

    now += JOB_TTL_MS - 500 // j1 is now past the TTL, j2 is not
    expect(s2.lookup('videos', 'j1')).toBeNull()
    expect(s2.lookup('videos', 'j2')).not.toBeNull()
    s2.record(e('j3'))
    expect(JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')).jobs.map((j: JobEntry) => j.id)).toEqual(['j2', 'j3'])
    for (const id of ['j4', 'j5']) s2.record(e(id))
    expect(JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')).jobs.map((j: JobEntry) => j.id)).toEqual(['j3', 'j4', 'j5'])
  })

  test('a corrupt file starts empty, is replaced on the next write, and malformed entries are dropped', () => {
    writeFileSync(join(dir, 'jobs.json'), '{ not json')
    const errors: unknown[] = []
    const s = new JobStore({ dataDir: dir, onError: e => errors.push(e) })
    expect(errors).toHaveLength(1)
    expect(s.lookup('videos', 'x')).toBeNull()
    s.record({ kind: 'videos', id: 'x', upstreamId: 'u', model: 'm', owner: { source: 'private' } })
    expect(new JobStore({ dataDir: dir }).lookup('videos', 'x')).not.toBeNull()

    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [
      { kind: 'videos', id: '../etc', upstreamId: 'u', model: 'm', owner: { source: 'private' }, at: Date.now() },
      { kind: 'videos', id: 'ok', upstreamId: 'u', model: 'm', owner: { source: 'public' }, at: Date.now() },
      { kind: 'videos', id: 'good', upstreamId: 'u', model: 'm', owner: { source: 'private' }, at: Date.now() },
    ] }))
    const t = new JobStore({ dataDir: dir })
    expect(t.lookup('videos', '../etc')).toBeNull()
    expect(t.lookup('videos', 'ok')).toBeNull()
    expect(t.lookup('videos', 'good')).not.toBeNull()
  })
})

describe('/v1/videos follow-ups', () => {
  test('create -> stored; status, content and delete reach the same upstream without a model', async () => {
    const up = fakeVideoService()
    const other = fakeVideoService()
    const s = setup({ urlA: up.url, urlB: other.url })

    const res = await create(s)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'video_abc123', status: 'queued' })
    expect(JSON.parse(up.seen[0]!.body).model).toBe('wan-video')
    expect(s.jobs.lookup('videos', 'video_abc123')).toMatchObject({ upstreamId: s.a, model: 'Comfy-wan-video', owner: { source: 'private' } })

    const status = await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123?x=1'))
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ status: 'completed' })
    expect(up.seen[1]).toMatchObject({ method: 'GET', path: '/v1/videos/video_abc123' })

    const del = await s.proxy.handleV1(req('DELETE', '/v1/videos/video_abc123'))
    expect(await del.json()).toEqual({ id: 'video_abc123', deleted: true })
    expect(up.seen[2]).toMatchObject({ method: 'DELETE', path: '/v1/videos/video_abc123' })

    expect(other.seen).toHaveLength(0)
    expect(s.acquired).toHaveLength(0) // never the local scheduler
    // Request log: model name and path only; no body fields of a follow-up.
    expect(s.records.map(r => [r.method, r.path, r.modelName, r.modelId, r.status])).toEqual([
      ['POST', '/v1/videos', 'Comfy-wan-video', `upstream:${s.a}`, 200],
      ['GET', '/v1/videos/video_abc123', 'Comfy-wan-video', `upstream:${s.a}`, 200],
      ['DELETE', '/v1/videos/video_abc123', 'Comfy-wan-video', `upstream:${s.a}`, 200],
    ])
    expect(s.records[1]!.params).toEqual({})
    expect(JSON.stringify(s.records)).not.toContain('a cat')
  })

  test('the /content download is streamed through byte-exact, without image processing', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const up = fakeVideoService({ gate })
    const s = setup({ urlA: up.url })
    await (await create(s)).text()
    const res = await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123/content'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    // Streamed, not buffered: bytes reach the client while the upstream still holds back the second half.
    const reader = res.body!.getReader()
    const parts: Uint8Array[] = []
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value!.byteLength).toBeGreaterThan(0)
    expect(first.value!.byteLength).toBeLessThan(VIDEO.byteLength)
    parts.push(first.value!)
    open()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const got = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let off = 0
    for (const p of parts) { got.set(p, off); off += p.byteLength }
    expect(got.byteLength).toBe(VIDEO.byteLength)
    expect(Buffer.compare(Buffer.from(got), Buffer.from(VIDEO))).toBe(0)
    expect(up.seen[1]!.path).toBe('/v1/videos/video_abc123/content')
    expect(s.records.at(-1)).toMatchObject({ status: 200, outcome: 'ok', images: null })
  })

  test('unknown id -> 404 job_not_found, nothing forwarded, never the local model', async () => {
    const up = fakeVideoService()
    const s = setup({ urlA: up.url })
    const res = await s.proxy.handleV1(req('GET', '/v1/videos/video_unknown'))
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error.code).toBe('job_not_found')
    expect(body.error.message).toContain('video_unknown')
    expect(up.seen).toHaveLength(0)
    expect(s.acquired).toHaveLength(0)
    expect(s.records.at(-1)).toMatchObject({ status: 404, error: 'job_not_found' })
  })

  test('the mapping survives a restart (a new proxy and store over the same data directory)', async () => {
    const up = fakeVideoService()
    const s = setup({ urlA: up.url })
    await (await create(s)).text()
    const restarted = createProxy({
      scheduler: { acquire: async () => { throw new Error('no local server in this test') }, snapshot: () => ({ models: [], queue: [] }), stateOf: () => 'ready' },
      getModels: () => MODELS, getSettings: () => defaultSettings(),
      getUpstreams: () => s.doc, getUpstreamKey: i => (i === s.a ? KEY_A : ''),
      jobs: new JobStore({ dataDir: dir }),
    })
    const res = await restarted.handleV1(req('GET', '/v1/videos/video_abc123'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'completed' })
    expect(up.seen.at(-1)!.path).toBe('/v1/videos/video_abc123')
  })

  test('an expired mapping answers 404', async () => {
    let now = Date.now()
    const up = fakeVideoService()
    const s = setup({ urlA: up.url, now: () => now })
    await (await create(s)).text()
    now += JOB_TTL_MS + 1
    expect((await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'))).status).toBe(404)
    expect(up.seen).toHaveLength(1)
  })

  test('upstream Authorization replaces the client key; the key is masked in follow-up responses', async () => {
    const up = fakeVideoService({ echoKey: KEY_A })
    const s = setup({ urlA: up.url })
    const created = await (await create(s)).text()
    expect(created).not.toContain(KEY_A)
    const res = await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123', undefined, { authorization: `Bearer ${CLIENT_KEY}` }))
    const text = await res.text()
    expect(text).not.toContain(KEY_A)
    for (const seen of up.seen) {
      expect(seen.headers.get('authorization')).toBe(`Bearer ${KEY_A}`)
      expect(JSON.stringify(Object.fromEntries(seen.headers))).not.toContain(CLIENT_KEY)
    }
  })

  test('a failed or non-JSON create response records nothing', async () => {
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ id: 'video_x', error: { message: 'busy' } }, { status: 503 }) })
    closers.push(() => srv.stop(true))
    const s = setup({ urlA: `http://127.0.0.1:${srv.port}/v1` })
    expect((await create(s)).status).toBe(503)
    expect(s.jobs.lookup('videos', 'video_x')).toBeNull()
  })

  test('public entry: still needs llama-web\'s key; a job is visible only to the key that created it', async () => {
    const up = fakeVideoService()
    const s = setup({ urlA: up.url })
    const secrets = defaultSecrets()
    const phone = createKey(secrets, 'phone').key
    const laptop = createKey(secrets, 'laptop').key
    const deps = { authenticate: (h: string | null) => authenticate(secrets, h), handleV1: (r: Request, meta: any) => s.proxy.handleV1(r, meta) }
    const pub = (r: Request) => handlePublic(r, deps, '127.0.0.1')
    const at = (method: string, path: string, key?: string, body?: unknown) => new Request(`http://127.0.0.1:8080${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })

    expect((await pub(at('POST', '/v1/videos', undefined, { model: 'Comfy-wan-video' }))).status).toBe(401)
    expect(up.seen).toHaveLength(0)
    const made = await pub(at('POST', '/v1/videos', phone, { model: 'Comfy-wan-video' }))
    expect(made.status).toBe(200)
    await made.text()
    expect(s.jobs.lookup('videos', 'video_abc123')?.owner).toEqual({ source: 'public', keyName: 'phone' })

    // No key, a wrong key: 401 before any lookup.
    expect((await pub(at('GET', '/v1/videos/video_abc123'))).status).toBe(401)
    expect((await pub(at('GET', '/v1/videos/video_abc123', CLIENT_KEY))).status).toBe(401)
    // Another valid key: the same 404 as an unknown id.
    const foreign = await pub(at('GET', '/v1/videos/video_abc123/content', laptop))
    expect(foreign.status).toBe(404)
    expect(((await foreign.json()) as any).error.code).toBe('job_not_found')
    // Local / LAN callers do not see a public caller's job either.
    expect((await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'), { ip: '127.0.0.1' })).status).toBe(404)
    expect((await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'), { ip: '192.168.1.20' })).status).toBe(404)
    expect(up.seen).toHaveLength(1)

    const mine = await pub(at('GET', '/v1/videos/video_abc123', phone))
    expect(mine.status).toBe(200)
    await mine.text()
    expect(up.seen[1]!.headers.get('authorization')).toBe(`Bearer ${KEY_A}`)
    expect(JSON.stringify(Object.fromEntries(up.seen[1]!.headers))).not.toContain(phone)
    expect(s.records.at(-1)).toMatchObject({ source: 'public', keyName: 'phone', status: 200 })
  })

  test('a job created locally is not visible to a public caller; LAN and local share it', async () => {
    const up = fakeVideoService()
    const s = setup({ urlA: up.url })
    await (await create(s, 'Comfy-wan-video', { ip: '192.168.1.20' })).text()
    expect((await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'), { ip: '127.0.0.1', keyName: 'phone' })).status).toBe(404)
    const local = await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'), { ip: '127.0.0.1' })
    expect(local.status).toBe(200)
    await local.text()
  })

  test('a deleted upstream makes its jobs unreachable (404), not a fall-through to anything else', async () => {
    const up = fakeVideoService()
    const s = setup({ urlA: up.url })
    await (await create(s)).text()
    s.doc.upstreams = s.doc.upstreams.filter(u => u.id !== s.a)
    expect((await s.proxy.handleV1(req('GET', '/v1/videos/video_abc123'))).status).toBe(404)
    expect(up.seen).toHaveLength(1)
  })
})
