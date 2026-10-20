// Knowledge for the chat models (decision 65 ⑨–⑫): binding resolution, inject mode, tool mode (buffered and streaming,
// local lease and external upstream), the request record. Fakes only: a scripted upstream server, a fake scheduler.
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultSettings, normalizeModels, type ModelsDoc } from '../../server/core/config'
import { setLocale, t } from '../../server/core/i18n'
import { normalizeBinding, parseBinding, resolveKnowledge, type KnowledgeBinding } from '../../server/core/kb/binding'
import { createProxy, type KnowledgeDeps, type ProxyEvent } from '../../server/core/proxy'
import { ProfileError, sanitizeForm, saveProfile } from '../../server/core/models-admin'
import type { RequestRecord } from '../../server/core/request-log'
import type { Lease, Target } from '../../server/core/scheduler'
import { cleanKnowledge, createUpstream, defaultUpstreams, normalizeUpstreams, UPSTREAMS_MIGRATIONS, UPSTREAMS_VERSION, updateUpstream, UpstreamError, type UpstreamsDoc } from '../../server/core/upstreams'

setLocale('zh-CN')

const BASES = [{ id: 'kb-aaaa1111', name: 'Manual' }, { id: 'kb-bbbb2222', name: '手册' }]
const HIT = { docName: '手册.txt', startLine: 12, headingPath: '第一章 > 安装', text: '步骤一：先装驱动。' }
const bind = (over: Partial<KnowledgeBinding> = {}): KnowledgeBinding => ({ enabled: true, kbs: ['kb-aaaa1111'], mode: 'inject', topK: 5, ...over })
const UPSTREAM_KEY = 'sk-upstream-own-key-0123456789' // pre-commit:allow fake test key

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

// ---------------------------------------------------------------------------------------
// Binding resolution (pure)

describe('resolveKnowledge', () => {
  const resolve = (raw: unknown, binding: KnowledgeBinding | null = bind(), allowed: string[] | null = null, bases = BASES) => resolveKnowledge({ binding, raw, bases, allowed })

  test('the binding applies when the request says nothing; off or empty means none', () => {
    expect(resolve(undefined)).toEqual({ ok: true, effective: { mode: 'inject', kbs: ['kb-aaaa1111'], topK: 5 }, skipped: [] })
    expect(resolve(undefined, bind({ enabled: false }))).toMatchObject({ ok: true, effective: null })
    expect(resolve(undefined, null)).toMatchObject({ ok: true, effective: null })
    expect(resolve(undefined, bind({ kbs: [] }))).toMatchObject({ ok: true, effective: null })
  })

  test('knowledge: false turns it off for the request', () => {
    expect(resolve(false)).toMatchObject({ ok: true, effective: null })
  })

  test('the request overrides the fields it carries; kbs given are used even when the binding is off; names are case-insensitive', () => {
    expect(resolve({ mode: 'tool', top_k: 9 })).toMatchObject({ effective: { mode: 'tool', kbs: ['kb-aaaa1111'], topK: 9 } })
    expect(resolve({ kbs: ['manual', 'kb-bbbb2222'] }, bind({ enabled: false }))).toMatchObject({ effective: { kbs: ['kb-aaaa1111', 'kb-bbbb2222'] } })
    expect(resolve({ top_k: 99 })).toMatchObject({ effective: { topK: 20 } })
    expect(resolve({ mode: 'tool' }, bind({ enabled: false }))).toMatchObject({ effective: null }) // options without knowledge bases
    expect(resolve({ kbs: [] })).toMatchObject({ effective: null })
  })

  test('an unknown knowledge base is 400 kb_not_found, wrong types are 400 invalid_knowledge', () => {
    expect(resolve({ kbs: ['nope'] })).toEqual({ ok: false, status: 400, code: 'kb_not_found', name: 'nope' })
    for (const raw of [true, 'x', 5, [], { kbs: 'a' }, { kbs: [1] }, { mode: 'rag' }, { top_k: 'five' }]) {
      expect(resolve(raw)).toMatchObject({ ok: false, status: 400, code: 'invalid_knowledge' })
    }
  })

  test('a knowledge base outside the allowed list is 403 kb_forbidden', () => {
    expect(resolve(undefined, bind(), ['kb-bbbb2222'])).toMatchObject({ ok: false, status: 403, code: 'kb_forbidden' })
    expect(resolve({ kbs: ['手册'] }, bind(), ['kb-bbbb2222'])).toMatchObject({ ok: true })
    expect(resolve(undefined, bind(), [])).toMatchObject({ ok: false, code: 'kb_forbidden' })
  })

  test('a bound knowledge base that was deleted is skipped', () => {
    expect(resolve(undefined, bind({ kbs: ['kb-gone0000', 'kb-aaaa1111'] }))).toMatchObject({ effective: { kbs: ['kb-aaaa1111'] }, skipped: ['kb-gone0000'] })
    expect(resolve(undefined, bind({ kbs: ['kb-gone0000'] }))).toEqual({ ok: true, effective: null, skipped: ['kb-gone0000'] })
  })
})

describe('configuration', () => {
  test('normalizeBinding repairs hand edits; parseBinding refuses wrong types', () => {
    expect(normalizeBinding({ enabled: 'yes', kbs: ['a', 3, 'a'], mode: 'x', topK: 99 })).toEqual({ enabled: false, kbs: ['a'], mode: 'inject', topK: 20 })
    expect(normalizeBinding(null)).toEqual({ enabled: false, kbs: [], mode: 'inject', topK: 5 })
    expect(parseBinding({ enabled: true, kbs: ['a'] })).toEqual({ enabled: true, kbs: ['a'], mode: 'inject', topK: 5 })
    for (const bad of [null, 'x', { enabled: 1 }, { kbs: 'a' }, { mode: 'rag' }, { topK: 'x' }]) expect(() => parseBinding(bad)).toThrow()
  })

  test('models.json: a profile with or without knowledge normalizes (no version bump)', () => {
    const doc = normalizeModels({
      version: 1,
      models: [{
        id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'a',
        profiles: { a: { overrides: {}, extraArgs: '' }, b: { overrides: {}, extraArgs: '', knowledge: { enabled: true, kbs: ['x'], mode: 'tool', topK: 3 } }, c: { overrides: {}, extraArgs: '', knowledge: 'junk' as any } },
      }],
    } as ModelsDoc)
    expect(doc.models[0]!.profiles.a!.knowledge).toBeUndefined()
    expect(doc.models[0]!.profiles.b!.knowledge).toEqual({ enabled: true, kbs: ['x'], mode: 'tool', topK: 3 })
    expect(doc.models[0]!.profiles.c!.knowledge).toBeUndefined()
  })

  test('the profile editor saves, keeps and clears the binding, and refuses a knowledge base that does not exist', () => {
    const doc: ModelsDoc = { version: 1, models: [{ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'a', profiles: { a: { overrides: {}, extraArgs: '' } } }] }
    const form = (knowledge?: unknown) => sanitizeForm({ overrides: {}, extraArgs: '', ...(knowledge === undefined ? {} : { knowledge }) })
    saveProfile(doc, 'm', 'a', form(bind()), [], undefined, undefined, [], ['kb-aaaa1111'])
    expect(doc.models[0]!.profiles.a!.knowledge).toEqual(bind())
    saveProfile(doc, 'm', 'a', form(), [], undefined, undefined, [], ['kb-aaaa1111'])
    expect(doc.models[0]!.profiles.a!.knowledge).toEqual(bind()) // left alone
    expect(() => saveProfile(doc, 'm', 'a', form(bind({ kbs: ['kb-zzzz'] })), [], undefined, undefined, [], ['kb-aaaa1111'])).toThrow(ProfileError)
    expect(() => form('junk')).toThrow(ProfileError)
    saveProfile(doc, 'm', 'a', form(null), [], undefined, undefined, [], [])
    expect(doc.models[0]!.profiles.a!.knowledge).toBeUndefined()
  })

  test('upstreams.json v1 -> v2 adds the default binding; new upstreams carry it; edits validate it', () => {
    expect(UPSTREAMS_VERSION).toBe(2)
    const migrated = UPSTREAMS_MIGRATIONS[1]!({ version: 1, upstreams: [{ id: 'u-1', name: 'A', baseUrl: 'http://x/v1' }, { id: 'u-2', name: 'B', baseUrl: 'http://x/v1', knowledge: bind() }] })
    expect(migrated.upstreams[0].knowledge).toEqual({ enabled: false, kbs: [], mode: 'inject', topK: 5 })
    expect(migrated.upstreams[1].knowledge).toEqual(bind())
    expect(normalizeUpstreams({ version: 1, upstreams: [{ id: 'u1', name: 'A', baseUrl: 'http://x/v1' } as any] }).upstreams[0]!.knowledge).toEqual({ enabled: false, kbs: [], mode: 'inject', topK: 5 })

    const ctx = { localNames: [], selfPorts: [], kbIds: ['kb-aaaa1111'] }
    const doc: UpstreamsDoc = defaultUpstreams()
    const u = createUpstream(doc, { name: 'Strata', baseUrl: 'http://x/v1', knowledge: bind({ mode: 'tool' }) }, ctx)
    expect(u.knowledge).toEqual(bind({ mode: 'tool' }))
    updateUpstream(doc, u.id, { knowledge: bind({ enabled: false }) }, ctx)
    expect(u.knowledge.enabled).toBe(false)
    updateUpstream(doc, u.id, { name: 'Strata2' }, ctx)
    expect(u.knowledge.enabled).toBe(false) // untouched when absent
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as UpstreamError).code } }
    expect(code(() => cleanKnowledge(bind({ kbs: ['kb-zzzz'] }), ctx))).toBe('kb-not-found')
    expect(code(() => cleanKnowledge('x', ctx))).toBe('bad-knowledge')
  })
})

// ---------------------------------------------------------------------------------------
// Harness

type Round = (body: any, n: number, signal: AbortSignal) => Response | Promise<Response>

/** A scripted OpenAI-style server: round n is answered by `rounds[min(n, last)]`. */
function scriptedServer(rounds: Round[]) {
  const seen: any[] = []
  const aborted: boolean[] = []
  const srv = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text()
      const body = text ? JSON.parse(text) : null
      const n = seen.push({ body, headers: req.headers, path: new URL(req.url).pathname }) - 1
      const idx = aborted.push(false) - 1
      req.signal.addEventListener('abort', () => { aborted[idx] = true })
      return rounds[Math.min(n, rounds.length - 1)]!(body, n, req.signal)
    },
  })
  closers.push(() => srv.stop(true))
  return { seen, aborted, port: srv.port!, url: `http://127.0.0.1:${srv.port}/v1` }
}

const sseEvent = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const sseResponse = (events: string[], opts: { hang?: boolean } = {}) => new Response(new ReadableStream({
  start(c) {
    for (const e of events) c.enqueue(new TextEncoder().encode(e))
    if (!opts.hang) c.close()
  },
}), { headers: { 'content-type': 'text/event-stream' } })

const chunk = (delta: any, extra: any = {}) => sseEvent({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })
const finish = (reason: string) => sseEvent({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const usageChunk = (p: number, c: number) => sseEvent({ id: 'c', choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }, timings: { predicted_per_second: 20 } })
const DONE = 'data: [DONE]\n\n'

/** A round that calls our tool, arguments cut over several events (index-based reassembly). */
function toolCallRound(query: string, id = 'call_1', name = 'search_knowledge', usage = [10, 5]): string[] {
  const args = JSON.stringify({ query })
  return [
    chunk({ role: 'assistant', content: null }),
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 4) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(4) } }] }),
    finish('tool_calls'),
    usageChunk(usage[0]!, usage[1]!),
    DONE,
  ]
}

const answerRound = (text: string, usage = [20, 8]): string[] => [
  chunk({ role: 'assistant', content: null }), chunk({ content: text.slice(0, 2) }), chunk({ content: text.slice(2) }), finish('stop'), usageChunk(usage[0]!, usage[1]!), DONE,
]

const jsonCall = (query: string, id = 'call_1', name = 'search_knowledge', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) => Response.json({
  id: 'r', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify({ query }) } }] } }], usage,
})
const jsonAnswer = (text: string, usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }) => Response.json({ id: 'r', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage })

interface LeaseRec { released: number, acquired: Target | null, ac: AbortController }

function setup(opts: {
  rounds: Round[]
  profile?: KnowledgeBinding
  upstream?: KnowledgeBinding
  hits?: Array<typeof HIT> | ((q: string) => Array<typeof HIT>)
  searchError?: boolean
  allowed?: string[] | null
  ready?: boolean
  knowledge?: boolean
}) {
  const srv = scriptedServer(opts.rounds)
  const models: ModelsDoc = {
    version: 1,
    models: [{ id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'default',
      profiles: { default: { overrides: {}, extraArgs: '' }, KB: { overrides: {}, extraArgs: '', ...(opts.profile ? { knowledge: opts.profile } : {}) } } }],
  }
  const upstreams: UpstreamsDoc = defaultUpstreams()
  createUpstream(upstreams, { name: 'Strata', baseUrl: srv.url, manualModels: ['qwen-x'], ...(opts.upstream ? { knowledge: opts.upstream } : {}) }, { localNames: [], selfPorts: [] })
  const leases: LeaseRec[] = []
  const searches: Array<{ ids: string[], q: string, topK: number }> = []
  const records: RequestRecord[] = []
  const events: ProxyEvent[] = []
  const knowledge: KnowledgeDeps = {
    search: async (ids, q, o) => {
      searches.push({ ids, q, topK: o.topK })
      if (opts.searchError) throw new Error('index broken')
      const hits = typeof opts.hits === 'function' ? opts.hits(q) : opts.hits ?? [HIT]
      return { hits }
    },
    list: () => BASES,
    allowedKbs: () => opts.allowed ?? null,
  }
  let state: 'ready' | 'loading' = opts.ready === false ? 'loading' : 'ready'
  const proxy = createProxy({
    scheduler: {
      acquire: async (target: Target) => {
        if (opts.ready === false) await new Promise(r => setTimeout(r, 40))
        state = 'ready'
        const rec: LeaseRec = { released: 0, acquired: target, ac: new AbortController() }
        leases.push(rec)
        const lease: Lease = { target, port: srv.port, signal: rec.ac.signal, release: () => { rec.released++ } }
        return lease
      },
      snapshot: () => ({ models: [], queue: [] }),
      stateOf: () => state,
    } as any,
    getModels: () => models, getSettings: () => defaultSettings(), heartbeatMs: 10,
    getUpstreams: () => upstreams, getUpstreamKey: () => UPSTREAM_KEY,
    onRequest: r => records.push(r), onEvent: e => events.push(e),
    ...(opts.knowledge === false ? {} : { knowledge }),
  })
  const post = (body: unknown, init: { signal?: AbortSignal, path?: string } = {}) =>
    proxy.handleV1(new Request(`http://localhost${init.path ?? '/v1/chat/completions'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: init.signal }))
  return { srv, post, leases, searches, records, events, proxy }
}

const chat = (over: Record<string, unknown> = {}) => ({ model: 'Alpha:KB', messages: [{ role: 'user', content: '怎么安装？' }], ...over })
const recordsSettled = async (r: RequestRecord[], n = 1) => { for (let i = 0; i < 100 && r.length < n; i++) await new Promise(x => setTimeout(x, 10)) }

/** The data payloads of an SSE text, `[DONE]` kept as a string. */
function sseData(text: string): any[] {
  return text.split('\n\n').map(e => e.split('\n').find(l => l.startsWith('data:'))).filter((l): l is string => !!l).map((l) => { const d = l.slice(5).trim(); return d === '[DONE]' ? d : JSON.parse(d) })
}
const contentOf = (events: any[]) => events.filter(e => e !== '[DONE]').map(e => e.choices?.[0]?.delta?.content ?? '').join('')

// ---------------------------------------------------------------------------------------
// Field strip and requests without knowledge

describe('the knowledge field', () => {
  test('is always removed before forwarding, also when no knowledge applies', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')] })
    expect((await s.post(chat({ model: 'Alpha', knowledge: false }))).status).toBe(200)
    expect(s.srv.seen[0].body).not.toHaveProperty('knowledge')
    expect(s.srv.seen[0].body.messages).toHaveLength(1)
    expect(s.searches).toHaveLength(0)
  })

  test('is removed when the proxy has no knowledge dependency at all; other paths keep it', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], knowledge: false })
    await s.post(chat({ knowledge: { kbs: ['Manual'] } }))
    expect(s.srv.seen[0].body).not.toHaveProperty('knowledge')
    await s.post({ model: 'Alpha', input: 'x', knowledge: 1 }, { path: '/v1/embeddings' })
    expect(s.srv.seen[1].body.knowledge).toBe(1)
  })

  test('a request without knowledge is forwarded byte for byte', async () => {
    const raw = '{"model":"Alpha","messages":[{"role":"user","content":"hi"}],"temperature":0.5}'
    let got = ''
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { got = await req.text(); return jsonAnswer('ok') } })
    closers.push(() => srv.stop(true))
    const proxy = createProxy({
      scheduler: { acquire: async (target: Target) => ({ target, port: srv.port, signal: new AbortController().signal, release() {} }), snapshot: () => ({ models: [], queue: [] }), stateOf: () => 'ready' } as any,
      getModels: () => ({ version: 1, models: [{ id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' } } }] }),
      getSettings: () => defaultSettings(), knowledge: { search: async () => ({ hits: [HIT] }), list: () => BASES },
    })
    await proxy.handleV1(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }))
    expect(got).toBe(raw)
  })

  test('errors: unknown knowledge base 400, wrong type 400, forbidden 403; nothing reaches the model', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], allowed: ['kb-bbbb2222'] })
    const unknown = await s.post(chat({ knowledge: { kbs: ['nope'] } }))
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as any).error.code).toBe('kb_not_found')
    const bad = await s.post(chat({ knowledge: 'yes' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as any).error.code).toBe('invalid_knowledge')
    const forbidden = await s.post(chat({ knowledge: { kbs: ['Manual'] } }))
    expect(forbidden.status).toBe(403)
    const body = (await forbidden.json()) as any
    expect(body.error.code).toBe('kb_forbidden')
    expect(body.error.message).toContain('Manual')
    expect(s.srv.seen).toHaveLength(0)
    expect(s.leases).toHaveLength(0)
  })

  test('the plain model name and a profile without a binding use no knowledge', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind() })
    await s.post(chat({ model: 'Alpha' }))
    expect(s.searches).toHaveLength(0)
    await s.post(chat({ model: 'Alpha:default' }))
    expect(s.searches).toHaveLength(0)
    await s.post(chat({ model: 'Alpha:KB' }))
    expect(s.searches).toHaveLength(1)
  })

  test('a bound knowledge base that was deleted is skipped and an event says so', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind({ kbs: ['kb-gone0000', 'kb-aaaa1111'] }) })
    expect((await s.post(chat())).status).toBe(200)
    expect(s.searches[0]!.ids).toEqual(['kb-aaaa1111'])
    expect(s.events.find(e => e.type === 'kb-skipped')).toMatchObject({ ids: ['kb-gone0000'] })
  })
})

// ---------------------------------------------------------------------------------------
// Inject mode

describe('inject mode', () => {
  test('creates a system message with numbered hits and their source; searches with the last user message', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind({ topK: 3 }) })
    const res = await s.post(chat({ messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: 'a' }, { role: 'user', content: [{ type: 'text', text: '怎么' }, { type: 'text', text: '安装？' }] }] }))
    expect(res.status).toBe(200)
    expect(s.searches).toEqual([{ ids: ['kb-aaaa1111'], q: '怎么\n安装？', topK: 3 }])
    const msgs = s.srv.seen[0].body.messages
    expect(msgs).toHaveLength(4)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain(t.kbPrompt.injectHeader)
    expect(msgs[0].content).toContain('[1] 《手册.txt》 第 12 行 · 第一章 > 安装\n步骤一：先装驱动。')
  })

  test('appends to an existing system message (string and array content, developer role)', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind() })
    await s.post(chat({ messages: [{ role: 'system', content: '你是助手。' }, { role: 'user', content: 'q' }] }))
    expect(s.srv.seen[0].body.messages).toHaveLength(2)
    expect(s.srv.seen[0].body.messages[0].content).toMatch(/^你是助手。\n\n/)
    await s.post(chat({ messages: [{ role: 'system', content: [{ type: 'text', text: 'A' }] }, { role: 'user', content: 'q' }] }))
    const parts = s.srv.seen[1].body.messages[0].content
    expect(parts).toHaveLength(2)
    expect(parts[1].type).toBe('text')
    expect(parts[1].text).toContain('[1]')
    await s.post(chat({ messages: [{ role: 'developer', content: 'D' }, { role: 'user', content: 'q' }] }))
    expect(s.srv.seen[2].body.messages[0].content).toMatch(/^D\n\n/)
  })

  test('no hits: the body is forwarded unchanged (apart from the field); no user text: no search', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind(), hits: [] })
    await s.post(chat({ knowledge: { top_k: 2 } }))
    expect(s.srv.seen[0].body).toEqual({ model: 'Alpha:KB', messages: [{ role: 'user', content: '怎么安装？' }] })
    await s.post(chat({ messages: [{ role: 'system', content: 's' }] }))
    expect(s.searches).toHaveLength(1)
  })

  test('a search failure: the chat is answered without knowledge and an event is logged', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind(), searchError: true })
    const res = await s.post(chat())
    expect(res.status).toBe(200)
    expect(s.srv.seen[0].body.messages).toHaveLength(1)
    expect(s.events.some(e => e.type === 'kb-error')).toBe(true)
  })

  test('the request override wins over the binding (kbs by name, mode, top_k)', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind() })
    await s.post(chat({ knowledge: { kbs: ['手册'], top_k: 2 } }))
    expect(s.searches[0]).toMatchObject({ ids: ['kb-bbbb2222'], topK: 2 })
    await s.post(chat({ knowledge: false }))
    expect(s.searches).toHaveLength(1)
  })

  test('the request record carries the summary and nothing of the query or the hits', async () => {
    const s = setup({ rounds: [() => jsonAnswer('ok')], profile: bind() })
    await (await s.post(chat())).text()
    await recordsSettled(s.records)
    expect(s.records[0]!.knowledge).toEqual({ mode: 'inject', kbs: ['kb-aaaa1111'], hits: 1, rounds: 1 })
    const text = JSON.stringify(s.records[0])
    expect(text).not.toContain('安装')
    expect(text).not.toContain('先装驱动')
  })

  test('works with a streaming request while the model is still loading, and for an external upstream', async () => {
    const loading = setup({ rounds: [() => sseResponse(answerRound('好的。'))], profile: bind(), ready: false })
    const res = await loading.post(chat({ stream: true }))
    const text = await res.text()
    expect(text).toContain(': loading')
    expect(contentOf(sseData(text))).toBe('好的。')
    expect(loading.srv.seen[0].body.messages[0].role).toBe('system')

    const ext = setup({ rounds: [() => jsonAnswer('ok')], upstream: bind() })
    await ext.post(chat({ model: 'Strata-qwen-x' }))
    expect(ext.searches).toHaveLength(1)
    expect(ext.srv.seen[0].body.model).toBe('qwen-x')
    expect(ext.srv.seen[0].body.messages[0].content).toContain('[1]')
    expect(ext.srv.seen[0].body).not.toHaveProperty('knowledge')
    await ext.post(chat({ model: 'Strata-qwen-x', knowledge: false }))
    expect(ext.searches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------
// Tool mode, not streaming

describe('tool mode (buffered)', () => {
  const tool = bind({ mode: 'tool' })

  test('adds the tool, runs one search, continues with the tool message and returns the final answer; usage is summed', async () => {
    const s = setup({ rounds: [() => jsonCall('安装'), () => jsonAnswer('先装驱动 [1]')], profile: tool })
    const res = await s.post(chat({ tools: [{ type: 'function', function: { name: 'client_tool', parameters: {} } }], tool_choice: 'auto' }))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.choices[0].message.content).toBe('先装驱动 [1]')
    expect(body.usage).toEqual({ prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 })
    expect(s.searches).toEqual([{ ids: ['kb-aaaa1111'], q: '安装', topK: 5 }])

    const first = s.srv.seen[0].body
    expect(first.tools.map((x: any) => x.function.name)).toEqual(['client_tool', 'search_knowledge'])
    expect(first.tool_choice).toBe('auto')
    const def = first.tools[1].function
    expect(def.description).toContain('Manual')
    expect(def.parameters.required).toEqual(['query'])
    expect(def.parameters.properties.top_k).toMatchObject({ type: 'integer', minimum: 1, maximum: 20 })

    const second = s.srv.seen[1].body.messages
    expect(second).toHaveLength(3)
    expect(second[1]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge' } }] })
    expect(second[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(second[2].content).toContain('[1] 《手册.txt》 第 12 行 · 第一章 > 安装')

    expect(s.leases).toHaveLength(1)
    expect(s.leases[0]!.released).toBe(1)
    await recordsSettled(s.records)
    expect(s.records[0]).toMatchObject({ promptTokens: 30, completionTokens: 13, status: 200, outcome: 'ok', knowledge: { mode: 'tool', kbs: ['kb-aaaa1111'], hits: 1, rounds: 1 } })
  })

  test('bad arguments and a failing search become text for the model, never an error', async () => {
    const badArgs = () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'search_knowledge', arguments: '{oops' } }] } }] })
    const s = setup({ rounds: [badArgs, () => jsonAnswer('ok')], profile: tool })
    expect((await s.post(chat())).status).toBe(200)
    expect(s.srv.seen[1].body.messages[2].content).toBe(t.kbPrompt.invalidArguments)
    expect(s.searches).toHaveLength(0)

    const failing = setup({ rounds: [() => jsonCall('q'), () => jsonAnswer('ok')], profile: tool, searchError: true })
    expect((await failing.post(chat())).status).toBe(200)
    expect(failing.srv.seen[1].body.messages[2].content).toBe(t.kbPrompt.searchFailed)
    expect(failing.events.some(e => e.type === 'kb-error')).toBe(true)
  })

  test('top_k of the call is used (clamped); the model can search several times', async () => {
    const withTopK = () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"q","top_k":99}' } }] } }] })
    const s = setup({ rounds: [withTopK, () => jsonCall('second'), () => jsonAnswer('done')], profile: tool })
    await s.post(chat())
    expect(s.searches.map(x => x.topK)).toEqual([20, 5])
    await recordsSettled(s.records)
    expect(s.records[0]!.knowledge).toMatchObject({ rounds: 2, hits: 2 })
  })

  test('after three tool rounds the tool is removed so the model has to answer (and `tools` goes when it is empty)', async () => {
    const s = setup({ rounds: [() => jsonCall('a'), () => jsonCall('b'), () => jsonCall('c'), () => jsonAnswer('final')], profile: tool })
    const res = await s.post(chat())
    expect(((await res.json()) as any).choices[0].message.content).toBe('final')
    expect(s.srv.seen).toHaveLength(4)
    expect(s.srv.seen.slice(0, 3).every(x => x.body.tools.length === 1)).toBe(true)
    expect(s.srv.seen[3].body).not.toHaveProperty('tools')
    expect(s.searches).toHaveLength(3)

    const withClient = setup({ rounds: [() => jsonCall('a'), () => jsonCall('b'), () => jsonCall('c'), () => jsonAnswer('final')], profile: tool })
    await withClient.post(chat({ tools: [{ type: 'function', function: { name: 'client_tool' } }] }))
    expect(withClient.srv.seen[3].body.tools.map((x: any) => x.function.name)).toEqual(['client_tool'])
  })

  test('a model that still calls the tool after the cap gets that turn passed to the client', async () => {
    const s = setup({ rounds: [() => jsonCall('a'), () => jsonCall('b'), () => jsonCall('c'), () => jsonCall('d')], profile: tool })
    const body = await (await s.post(chat())).json() as any
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('search_knowledge')
    expect(s.searches).toHaveLength(3)
    expect(s.leases[0]!.released).toBe(1)
  })

  test('a client that already has search_knowledge: nothing is added and the request passes through', async () => {
    const s = setup({ rounds: [() => jsonCall('x')], profile: tool })
    const res = await s.post(chat({ tools: [{ type: 'function', function: { name: 'search_knowledge', parameters: {} } }] }))
    const body = await res.json() as any
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('search_knowledge') // the client's call, untouched
    expect(s.srv.seen).toHaveLength(1)
    expect(s.srv.seen[0].body.tools).toHaveLength(1)
    expect(s.searches).toHaveLength(0)
  })

  test('a turn that mixes our call with a client tool goes to the client as it is', async () => {
    const mixed = () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"q"}' } },
      { id: 'b', type: 'function', function: { name: 'client_tool', arguments: '{}' } },
    ] } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
    const s = setup({ rounds: [mixed], profile: tool })
    const body = await (await s.post(chat({ tools: [{ type: 'function', function: { name: 'client_tool' } }] }))).json() as any
    expect(body.choices[0].message.tool_calls.map((c: any) => c.id)).toEqual(['a', 'b'])
    expect(s.srv.seen).toHaveLength(1)
    expect(s.searches).toHaveLength(0)
  })

  test('a plain answer (no tool call) comes back byte for byte; an upstream error status is relayed', async () => {
    const answer = { id: 'r', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    const s = setup({ rounds: [() => new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } })], profile: tool })
    expect(await (await s.post(chat())).text()).toBe(JSON.stringify(answer))
    const err = setup({ rounds: [() => Response.json({ error: { message: 'bad' } }, { status: 400 })], profile: tool })
    const res = await err.post(chat())
    expect(res.status).toBe(400)
    expect(err.leases[0]!.released).toBe(1)
    await recordsSettled(err.records)
    expect(err.records[0]).toMatchObject({ status: 400, outcome: 'error' })
  })

  test('a client that leaves during the loop frees the lease once', async () => {
    // Answers (with an error nobody reads) once the proxy gives up on the request, so the server can shut down.
    const hang: Round = (_b, _n, signal) => new Promise<Response>((resolve) => { signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 }))) })
    const s = setup({ rounds: [() => jsonCall('q'), hang], profile: tool })
    const ac = new AbortController()
    const pending = s.post(chat(), { signal: ac.signal })
    for (let i = 0; i < 100 && s.srv.seen.length < 2; i++) await new Promise(r => setTimeout(r, 10))
    ac.abort()
    const res = await pending
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(s.leases[0]!.released).toBe(1)
    await recordsSettled(s.records)
    expect(s.records[0]!.outcome).toBe('aborted')
  })

  test('works for an external upstream: its key replaces the client key, and a key echoed back is masked', async () => {
    const echo = () => jsonAnswer(`你的 key 是 ${UPSTREAM_KEY}`)
    const s = setup({ rounds: [() => jsonCall('q'), echo], upstream: bind({ mode: 'tool' }) })
    const res = await s.post(chat({ model: 'Strata-qwen-x' }))
    const text = await res.text()
    expect(text).not.toContain(UPSTREAM_KEY)
    expect(text).toContain('***')
    expect(s.srv.seen).toHaveLength(2)
    expect(s.srv.seen.every(x => x.headers.get('authorization') === `Bearer ${UPSTREAM_KEY}`)).toBe(true)
    expect(s.srv.seen[1].body.model).toBe('qwen-x')
    expect(s.leases).toHaveLength(0)
    await recordsSettled(s.records)
    expect(s.records[0]).toMatchObject({ modelId: expect.stringMatching(/^upstream:/), knowledge: { mode: 'tool', rounds: 1 } })
  })
})

// ---------------------------------------------------------------------------------------
// Tool mode, streaming

describe('tool mode (streaming)', () => {
  const tool = bind({ mode: 'tool' })

  test('one stream with the content of both rounds, none of our tool-call events, exactly one [DONE]; one lease', async () => {
    const withPrefix = [chunk({ role: 'assistant', content: null }), chunk({ content: '我查一下。' }), ...toolCallRound('安装').slice(1)]
    const s = setup({ rounds: [() => sseResponse(withPrefix), () => sseResponse(answerRound('先装驱动 [1]'))], profile: tool })
    const res = await s.post(chat({ stream: true }))
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    const events = sseData(text)
    expect(contentOf(events)).toBe('我查一下。先装驱动 [1]')
    expect(text).not.toContain('tool_calls')
    expect(text).not.toContain('"finish_reason":"tool_calls"')
    expect(events.filter(e => e === '[DONE]')).toHaveLength(1)
    expect(events[events.length - 1]).toBe('[DONE]')
    expect(text).toContain(': knowledge search')
    // The second round's own bare role chunk is dropped; the usage chunk is the final round's, summed with the first.
    expect(events.filter(e => e !== '[DONE]' && e.choices?.[0]?.delta?.role === 'assistant')).toHaveLength(1)
    const usage = events.filter(e => e !== '[DONE]' && e.usage)
    expect(usage).toHaveLength(1)
    expect(usage[0].usage).toEqual({ prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 })

    expect(s.searches).toEqual([{ ids: ['kb-aaaa1111'], q: '安装', topK: 5 }])
    const call = s.srv.seen[1].body.messages
    expect(call[1]).toMatchObject({ role: 'assistant', content: '我查一下。', tool_calls: [{ id: 'call_1', function: { name: 'search_knowledge', arguments: '{"query":"安装"}' } }] })
    expect(call[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(s.leases).toHaveLength(1)
    expect(s.leases[0]!.released).toBe(1)
    await recordsSettled(s.records)
    expect(s.records[0]).toMatchObject({ promptTokens: 30, completionTokens: 13, outcome: 'ok', stream: true, knowledge: { mode: 'tool', hits: 1, rounds: 1 } })
  })

  test('the 3-round cap: the fourth request has no tool', async () => {
    const s = setup({ rounds: [() => sseResponse(toolCallRound('a')), () => sseResponse(toolCallRound('b')), () => sseResponse(toolCallRound('c')), () => sseResponse(answerRound('fin'))], profile: tool })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(contentOf(sseData(text))).toBe('fin')
    expect(s.srv.seen).toHaveLength(4)
    expect(s.srv.seen[3].body).not.toHaveProperty('tools')
    expect(s.leases[0]!.released).toBe(1)
  })

  test('a mixed turn is flushed as it came: tool-call events, finish, usage, [DONE]', async () => {
    const mixed = [
      chunk({ role: 'assistant', content: null }),
      chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"q"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'client_tool', arguments: '{}' } }] }),
      finish('tool_calls'), usageChunk(4, 2), DONE,
    ]
    const s = setup({ rounds: [() => sseResponse(mixed)], profile: tool })
    const text = await (await s.post(chat({ stream: true, tools: [{ type: 'function', function: { name: 'client_tool' } }] }))).text()
    expect(text).toBe(mixed.join(''))
    expect(s.searches).toHaveLength(0)
    expect(s.leases[0]!.released).toBe(1)
  })

  test('a plain answer streams through untouched, usage chunk and [DONE] included', async () => {
    const plain = answerRound('你好')
    const s = setup({ rounds: [() => sseResponse(plain)], profile: tool })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text).toBe(plain.join(''))
    await recordsSettled(s.records)
    expect(s.records[0]).toMatchObject({ promptTokens: 20, completionTokens: 8, knowledge: { mode: 'tool', rounds: 0 } })
  })

  test('events split across network chunks and CRLF separators are handled', async () => {
    const raw = [...toolCallRound('q')].join('')
    const cut = Math.floor(raw.length / 3)
    const pieces = [raw.slice(0, cut), raw.slice(cut, cut * 2), raw.slice(cut * 2)]
    const second = answerRound('好').join('').replace(/\n\n/g, '\r\n\r\n')
    const s = setup({ rounds: [() => sseResponse(pieces), () => sseResponse([second])], profile: tool })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(contentOf(sseData(text.replace(/\r\n/g, '\n')))).toBe('好')
    expect(s.searches).toHaveLength(1)
  })

  test('the model not ready yet: heartbeat while loading, then the loop on the same lease', async () => {
    const s = setup({ rounds: [() => sseResponse(toolCallRound('q')), () => sseResponse(answerRound('好的'))], profile: tool, ready: false })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text.startsWith(': loading')).toBe(true)
    expect(contentOf(sseData(text))).toBe('好的')
    expect(s.leases).toHaveLength(1)
    expect(s.leases[0]!.released).toBe(1)
    expect(s.searches).toHaveLength(1)
  })

  test('an upstream error in a later round is relayed as an event and the lease is released', async () => {
    const s = setup({ rounds: [() => sseResponse(toolCallRound('q')), () => Response.json({ error: { message: 'boom' } }, { status: 500 })], profile: tool })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text).toContain('boom')
    expect(s.leases[0]!.released).toBe(1)
    await recordsSettled(s.records)
    expect(s.records[0]!.outcome).toBe('error')
  })

  test('a client that disconnects mid-loop releases the lease exactly once and stops the upstream', async () => {
    const hangAfterOne = () => sseResponse([chunk({ role: 'assistant', content: null }), chunk({ content: '第二轮' })], { hang: true })
    const s = setup({ rounds: [() => sseResponse(toolCallRound('q')), hangAfterOne], profile: tool })
    const ac = new AbortController()
    const res = await s.post(chat({ stream: true }), { signal: ac.signal })
    const reader = res.body!.getReader()
    let seen = ''
    while (!seen.includes('第二轮')) {
      const { done, value } = await reader.read()
      if (done) break
      seen += new TextDecoder().decode(value)
    }
    expect(seen).toContain('第二轮')
    ac.abort()
    for (let i = 0; i < 100 && s.leases[0]!.released === 0; i++) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 50))
    expect(s.leases[0]!.released).toBe(1)
    await recordsSettled(s.records)
    expect(s.records).toHaveLength(1)
    expect(s.records[0]!.outcome).toBe('aborted')
    for (let i = 0; i < 100 && !s.srv.aborted[1]; i++) await new Promise(r => setTimeout(r, 10))
    expect(s.srv.aborted[1]).toBe(true)
  })

  test('the lease being aborted (model unloaded) mid-loop ends the stream and releases once', async () => {
    const hang = () => sseResponse([chunk({ content: 'x' })], { hang: true })
    const s = setup({ rounds: [() => sseResponse(toolCallRound('q')), hang], profile: tool })
    const res = await s.post(chat({ stream: true }))
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let seen = ''
    while (!seen.includes('"x"') && !seen.includes('model_interrupted')) {
      const { done, value } = await reader.read()
      if (done) break
      seen += dec.decode(value)
    }
    s.leases[0]!.ac.abort(new Error('unloaded'))
    for (let i = 0; i < 100; i++) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (value) seen += dec.decode(value)
      if (done) break
    }
    expect(seen).toContain('model_interrupted')
    expect(s.leases[0]!.released).toBe(1)
  })

  test('external upstream: the loop runs without a lease, with the upstream key, and the key is masked in what comes back', async () => {
    const leak = answerRound(`key ${UPSTREAM_KEY}`)
    const s = setup({ rounds: [() => sseResponse(toolCallRound('q')), () => sseResponse(leak)], upstream: bind({ mode: 'tool' }) })
    const text = await (await s.post(chat({ model: 'Strata-qwen-x', stream: true }))).text()
    expect(text).not.toContain(UPSTREAM_KEY)
    expect(s.srv.seen.every(x => x.headers.get('authorization') === `Bearer ${UPSTREAM_KEY}`)).toBe(true)
    expect(s.leases).toHaveLength(0)
    expect(s.searches).toHaveLength(1)
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})
