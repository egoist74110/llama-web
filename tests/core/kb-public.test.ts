// The external knowledge base API through the public entry (AGENTS.md: authentication changes need tests): no key is 401,
// a key sees only its knowledge bases, a key without the write switch cannot write, the key id reaches the handler,
// and the chat `knowledge` field is limited by the same list.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { JsonStore } from '../../server/core/store'
import { KbManager } from '../../server/core/kb/manager'
import type { Embedder } from '../../server/core/kb/embed'
import { defaultKnowledge, KNOWLEDGE_MIGRATIONS, KNOWLEDGE_VERSION, normalizeKnowledge, type KnowledgeDoc } from '../../server/core/kb/registry'
import { kbAccessOf } from '../../server/core/kb/access'
import { createKbApi } from '../../server/core/kb/http'
import { authenticate, createKey, defaultSecrets, revokeKey, setKeyKnowledge } from '../../server/core/keys'
import { createProxy } from '../../server/core/proxy'
import { handlePublic } from '../../server/core/public-entry'
import type { RequestMeta } from '../../server/core/request-log'

const dirs: string[] = []
const managers: KbManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const keywordOnly: Embedder = { name: () => null, embed: async () => [] }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'llama-web-kb-public-'))
  dirs.push(dir)
  const store = new JsonStore<KnowledgeDoc>({
    dataDir: dir, name: 'knowledge.json', version: KNOWLEDGE_VERSION, defaults: defaultKnowledge, validate: normalizeKnowledge, migrations: KNOWLEDGE_MIGRATIONS,
  })
  store.load()
  const kb = new KbManager({ dataDir: dir, store, embedder: keywordOnly })
  managers.push(kb)
  const a = (await kb.create({ name: 'Alpha' })).id
  const b = (await kb.create({ name: 'Beta' })).id
  const secrets = defaultSecrets()
  const reader = createKey(secrets, 'reader')
  setKeyKnowledge(secrets, reader.id, { kbs: [a], kbWrite: false }, [a, b])
  const writer = createKey(secrets, 'writer')
  setKeyKnowledge(secrets, writer.id, { kbs: [a], kbWrite: true }, [a, b])
  const open = createKey(secrets, 'open')
  const old = createKey(secrets, 'old')
  revokeKey(secrets, old.id)
  const metas: RequestMeta[] = []
  const proxy = createProxy({
    scheduler: { acquire: async () => { throw new Error('no model in this test') }, snapshot: () => ({ models: [], queue: [] }), stateOf: () => 'stopped' } as any,
    getModels: () => ({ version: 1, models: [{ id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' } } }] }),
    getSettings: defaultSettings,
    knowledge: { search: (ids, q, o) => kb.search(ids, q, o), list: () => store.get().bases, allowedKbs: meta => kbAccessOf(meta, secrets).allowed },
    kbApi: createKbApi({ deps: { kb, bases: () => store.get().bases }, secrets: () => secrets }),
  })
  const deps = {
    authenticate: (h: string | null) => authenticate(secrets, h),
    handleV1: (r: Request, meta: RequestMeta) => { metas.push(meta); return proxy.handleV1(r, meta) },
  }
  const send = async (key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers }
    if (key) h.authorization = `Bearer ${key}`
    if (body !== undefined) h['content-type'] = 'application/json'
    const res = await handlePublic(new Request(`http://127.0.0.1:8080${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), deps, '127.0.0.1')
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }
  return { kb, store, a, b, secrets, keys: { reader, writer, open, old }, metas, send }
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const toolText = (r: { json: any }) => JSON.parse(r.json.result.content[0].text)

describe('public entry: knowledge base API', () => {
  test('no key, a wrong key and a revoked key are 401 on /v1/kb and /v1/mcp; nothing is written', async () => {
    const s = await setup()
    for (const key of [null, 'sk-not-a-real-key-at-all-0000', s.keys.old.key]) { // pre-commit:allow (fake)
      expect((await s.send(key, 'GET', '/v1/kb')).status).toBe(401)
      expect((await s.send(key, 'POST', '/v1/kb/search', { query: 'x' })).status).toBe(401)
      expect((await s.send(key, 'POST', `/v1/kb/${s.a}/entries`, { guide_rev: s.kb.guide(s.a).rev, title: 'x', body: 'y' })).status).toBe(401)
      expect((await s.send(key, 'POST', '/v1/mcp', rpc(1, 'tools/list'))).status).toBe(401)
    }
    expect(s.metas).toEqual([])
    expect((await s.kb.listEntries(s.a)).total).toBe(0)
  })

  test('the key id and name reach the handler in the request meta', async () => {
    const s = await setup()
    await s.send(s.keys.reader.key, 'GET', '/v1/kb')
    expect(s.metas).toEqual([{ ip: '127.0.0.1', keyName: 'reader', keyId: s.keys.reader.id }])
  })

  test('a key with a list sees only those knowledge bases over REST', async () => {
    const s = await setup()
    await s.kb.addEntry(s.b, { title: 'secret', body: 'needle in beta' }, 'admin')
    await s.kb.addEntry(s.a, { title: 'public', body: 'needle in alpha' }, 'admin')
    const key = s.keys.reader.key
    expect((await s.send(key, 'GET', '/v1/kb')).json.knowledge_bases.map((k: any) => k.id)).toEqual([s.a])
    const guide = await s.send(key, 'GET', `/v1/kb/${s.b}/guide`)
    expect(guide.status).toBe(403)
    expect(guide.json.error.code).toBe('kb_forbidden')
    expect((await s.send(key, 'GET', `/v1/kb/${s.b}/entries`)).status).toBe(403)
    expect((await s.send(key, 'GET', '/v1/kb/kb-doesnotexist/guide')).status).toBe(403)
    const found = await s.send(key, 'POST', '/v1/kb/search', { query: 'needle' })
    expect(found.json.results.map((r: any) => r.kb_id)).toEqual([s.a])
    const asked = await s.send(key, 'POST', '/v1/kb/search', { query: 'needle', kb_ids: [s.b] })
    expect(asked.status).toBe(403)
    // The key without a list (open) sees both.
    expect((await s.send(s.keys.open.key, 'POST', '/v1/kb/search', { query: 'needle' })).json.results).toHaveLength(2)
  })

  test('and over MCP: tools/call on a knowledge base outside the list is a kb_forbidden tool error', async () => {
    const s = await setup()
    const key = s.keys.reader.key
    const r = await s.send(key, 'POST', '/v1/mcp', rpc(1, 'tools/call', { name: 'kb_guide', arguments: { kb_id: s.b } }))
    expect(r.status).toBe(200)
    expect(r.json.result.isError).toBe(true)
    expect(toolText(r).error.code).toBe('kb_forbidden')
    const search = await s.send(key, 'POST', '/v1/mcp', rpc(2, 'tools/call', { name: 'search_knowledge', arguments: { query: 'x', kb_ids: [s.b] } }))
    expect(toolText(search).error.code).toBe('kb_forbidden')
    const list = await s.send(key, 'POST', '/v1/mcp', rpc(3, 'tools/call', { name: 'list_knowledge_bases', arguments: {} }))
    expect(toolText(list).knowledge_bases.map((k: any) => k.id)).toEqual([s.a])
  })

  test('a key without the write switch cannot write (REST and MCP); the one with it can, and is named in the change log', async () => {
    const s = await setup()
    const rev = s.kb.guide(s.a).rev
    const body = { guide_rev: rev, title: 'T', body: 'text' }
    const denied = await s.send(s.keys.reader.key, 'POST', `/v1/kb/${s.a}/entries`, body)
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('kb_read_only')
    const tools = await s.send(s.keys.reader.key, 'POST', '/v1/mcp', rpc(1, 'tools/list'))
    expect(tools.json.result.tools.map((x: any) => x.name)).not.toContain('add_entry')
    const viaMcp = await s.send(s.keys.reader.key, 'POST', '/v1/mcp', rpc(2, 'tools/call', { name: 'add_entry', arguments: { kb_id: s.a, ...body } }))
    expect(toolText(viaMcp).error.code).toBe('kb_read_only')
    expect((await s.kb.listEntries(s.a)).total).toBe(0)

    // The writer may write its own knowledge base, not another one.
    expect((await s.send(s.keys.writer.key, 'POST', `/v1/kb/${s.a}/entries`, body)).status).toBe(201)
    const other = await s.send(s.keys.writer.key, 'POST', `/v1/kb/${s.b}/entries`, { ...body, guide_rev: s.kb.guide(s.b).rev })
    expect(other.status).toBe(403)
    expect(other.json.error.code).toBe('kb_forbidden')
    const mcpAdd = await s.send(s.keys.writer.key, 'POST', '/v1/mcp', rpc(3, 'tools/call', { name: 'add_entry', arguments: { kb_id: s.a, ...body, title: 'T2' } }))
    expect(mcpAdd.json.result.isError).toBe(false)
    expect((await s.kb.changes(s.a)).map(c => `${c.op}:${c.actor}`)).toEqual(['create:key:writer', 'create:key:writer'])
    expect((await s.kb.listEntries(s.b)).total).toBe(0)
  })

  test('permission edits apply to the next request without a new key', async () => {
    const s = await setup()
    const key = s.keys.reader.key
    expect((await s.send(key, 'GET', `/v1/kb/${s.b}/guide`)).status).toBe(403)
    setKeyKnowledge(s.secrets, s.keys.reader.id, { kbs: [s.a, s.b], kbWrite: false }, [s.a, s.b])
    expect((await s.send(key, 'GET', `/v1/kb/${s.b}/guide`)).status).toBe(200)
    revokeKey(s.secrets, s.keys.reader.id)
    expect((await s.send(key, 'GET', `/v1/kb/${s.b}/guide`)).status).toBe(401)
  })

  test('cross-site writes are refused on the public entry too', async () => {
    const s = await setup()
    const res = await s.send(s.keys.writer.key, 'POST', `/v1/kb/${s.a}/entries`, { guide_rev: s.kb.guide(s.a).rev, title: 'x', body: 'y' }, { origin: 'https://evil.example', host: '127.0.0.1:8080' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('cross_origin')
    expect((await s.kb.listEntries(s.a)).total).toBe(0)
  })

  test('the knowledge field of a chat request is limited by the key list: another knowledge base is 403 kb_forbidden', async () => {
    const s = await setup()
    const chat = (kbs: string[]) => ({ model: 'Alpha', messages: [{ role: 'user', content: 'hi' }], knowledge: { kbs } })
    const forbidden = await s.send(s.keys.reader.key, 'POST', '/v1/chat/completions', chat([s.b]))
    expect(forbidden.status).toBe(403)
    expect(forbidden.json.error.code).toBe('kb_forbidden')
    // A key without a list is not stopped by the permission check (the model is not running here, so it fails later).
    const open = await s.send(s.keys.open.key, 'POST', '/v1/chat/completions', chat([s.b]))
    expect(open.json.error.code).not.toBe('kb_forbidden')
  })
})
