// External knowledge base API (decisions 65 ⑦⑧ / 69 ⑦⑧, work package 15-3): key permissions, the shared operations, the
// REST adapter and the MCP adapter. A real KbManager on a temp directory, keyword-only (no vector engine).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../../server/core/store'
import { KbManager } from '../../server/core/kb/manager'
import type { Embedder } from '../../server/core/kb/embed'
import { defaultKnowledge, KNOWLEDGE_MIGRATIONS, KNOWLEDGE_VERSION, normalizeKnowledge, type KnowledgeDoc } from '../../server/core/kb/registry'
import { kbAccessOf } from '../../server/core/kb/access'
import { KbApiError, runOp } from '../../server/core/kb/external'
import { createKbApi } from '../../server/core/kb/http'
import { mcpTools, TOOL_NAMES } from '../../server/core/kb/mcp'
import { createKey, defaultSecrets, revokeKey, setKeyKnowledge, type SecretsDoc } from '../../server/core/keys'
import type { RequestMeta } from '../../server/core/request-log'

const dirs: string[] = []
const managers: KbManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const keywordOnly: Embedder = { name: () => null, embed: async () => [] }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'llama-web-kb-external-'))
  dirs.push(dir)
  const store = new JsonStore<KnowledgeDoc>({
    dataDir: dir, name: 'knowledge.json', version: KNOWLEDGE_VERSION, defaults: defaultKnowledge, validate: normalizeKnowledge, migrations: KNOWLEDGE_MIGRATIONS,
  })
  store.load()
  const kb = new KbManager({ dataDir: dir, store, embedder: keywordOnly })
  managers.push(kb)
  const a = (await kb.create({ name: 'Alpha' })).id
  const b = (await kb.create({ name: 'Beta' })).id
  const secrets: SecretsDoc = defaultSecrets()
  const full = createKey(secrets, 'full')
  setKeyKnowledge(secrets, full.id, { kbs: null, kbWrite: true }, [a, b])
  const ro = createKey(secrets, 'ro')
  setKeyKnowledge(secrets, ro.id, { kbs: [a], kbWrite: false }, [a, b])
  const rwA = createKey(secrets, 'rwA')
  setKeyKnowledge(secrets, rwA.id, { kbs: [a], kbWrite: true }, [a, b])
  const gone = createKey(secrets, 'gone')
  setKeyKnowledge(secrets, gone.id, { kbs: null, kbWrite: true }, [a, b])
  revokeKey(secrets, gone.id)
  const deps = { kb, bases: () => store.get().bases }
  const api = createKbApi({ deps, secrets: () => secrets, version: '9.9.9' })
  const metaOf = (k: { id: string, name: string }): RequestMeta => ({ ip: '127.0.0.1', keyName: k.name, keyId: k.id })
  return { dir, kb, store, a, b, secrets, deps, api, keys: { full, ro, rwA, gone }, metaOf }
}
type Env = Awaited<ReturnType<typeof setup>>

const rev = (e: Env, id: string) => e.kb.guide(id).rev

async function call(e: Env, method: string, path: string, opts: { body?: unknown, meta?: RequestMeta, headers?: Record<string, string>, raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let body: string | undefined
  if (opts.raw !== undefined) body = opts.raw
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] ??= 'application/json' }
  const res = await e.api.handle(new Request(`http://127.0.0.1:3000${path}`, { method, headers, body }), opts.meta)
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, text }
}

async function mcp(e: Env, body: unknown, meta?: RequestMeta) {
  return call(e, 'POST', '/v1/mcp', { body, meta })
}

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const toolCall = (id: number, name: string, args: unknown) => rpc(id, 'tools/call', { name, arguments: args })
const toolResult = (r: { json: any }) => JSON.parse(r.json.result.content[0].text)

describe('keys: knowledge permissions', () => {
  test('access: local and LAN (no key id) may do everything', async () => {
    const e = await setup()
    expect(kbAccessOf(undefined, e.secrets)).toEqual({ actor: 'local', allowed: null, write: true })
    expect(kbAccessOf({ ip: '192.168.1.5' }, e.secrets)).toEqual({ actor: 'local', allowed: null, write: true })
  })

  test('access: a key decides; revoked or missing keys get nothing', async () => {
    const e = await setup()
    expect(kbAccessOf(e.metaOf(e.keys.full), e.secrets)).toEqual({ actor: 'key:full', allowed: null, write: true })
    expect(kbAccessOf(e.metaOf(e.keys.ro), e.secrets)).toEqual({ actor: 'key:ro', allowed: [e.a], write: false })
    expect(kbAccessOf(e.metaOf(e.keys.gone), e.secrets)).toEqual({ actor: 'key:gone', allowed: [], write: false })
    expect(kbAccessOf({ keyId: 'k-unknown', keyName: 'ghost' }, e.secrets)).toEqual({ actor: 'key:ghost', allowed: [], write: false })
  })

  test('access follows edits at once (looked up per request)', async () => {
    const e = await setup()
    expect(kbAccessOf(e.metaOf(e.keys.ro), e.secrets).write).toBe(false)
    setKeyKnowledge(e.secrets, e.keys.ro.id, { kbs: [e.a, e.b], kbWrite: true }, [e.a, e.b])
    expect(kbAccessOf(e.metaOf(e.keys.ro), e.secrets)).toEqual({ actor: 'key:ro', allowed: [e.a, e.b], write: true })
  })
})

describe('operations', () => {
  test('list shows only the allowed knowledge bases, with guide_rev and writable', async () => {
    const e = await setup()
    const all = await runOp(e.deps, kbAccessOf(undefined, e.secrets), 'list_knowledge_bases', {}) as any
    expect(all.knowledge_bases.map((k: any) => k.id).sort()).toEqual([e.a, e.b].sort())
    expect(all.knowledge_bases[0]).toMatchObject({ guide_rev: rev(e, all.knowledge_bases[0].id), writable: true, sources: 0, entries: 0 })
    const ro = await runOp(e.deps, kbAccessOf(e.metaOf(e.keys.ro), e.secrets), 'list_knowledge_bases', {}) as any
    expect(ro.knowledge_bases.map((k: any) => k.id)).toEqual([e.a])
    expect(ro.knowledge_bases[0].writable).toBe(false)
  })

  test('forbidden is answered before not-found, so ids cannot be probed', async () => {
    const e = await setup()
    const access = kbAccessOf(e.metaOf(e.keys.ro), e.secrets)
    const err = async (kbId: string) => { try { await runOp(e.deps, access, 'kb_guide', { kb_id: kbId }) } catch (x) { return x as KbApiError } throw new Error('no error') }
    expect(await err(e.b)).toMatchObject({ status: 403, code: 'kb_forbidden' })
    expect(await err('kb-doesnotexist')).toMatchObject({ status: 403, code: 'kb_forbidden' })
    const local = kbAccessOf(undefined, e.secrets)
    try { await runOp(e.deps, local, 'kb_guide', { kb_id: 'kb-doesnotexist' }) } catch (x) { expect(x).toMatchObject({ status: 404, code: 'kb_not_found' }) }
  })

  test('a read-only key cannot write: kb_read_only; a revoked key cannot even read', async () => {
    const e = await setup()
    const ro = kbAccessOf(e.metaOf(e.keys.ro), e.secrets)
    await expect(runOp(e.deps, ro, 'add_entry', { kb_id: e.a, guide_rev: rev(e, e.a), title: 'x', body: 'y' })).rejects.toMatchObject({ status: 403, code: 'kb_read_only' })
    const gone = kbAccessOf(e.metaOf(e.keys.gone), e.secrets)
    await expect(runOp(e.deps, gone, 'kb_guide', { kb_id: e.a })).rejects.toMatchObject({ status: 403, code: 'kb_forbidden' })
    expect(((await runOp(e.deps, gone, 'list_knowledge_bases', {})) as any).knowledge_bases).toEqual([])
  })

  test('writes need the current guide_rev: missing or stale is 412 guide_required without the revision in the message', async () => {
    const e = await setup()
    const access = kbAccessOf(undefined, e.secrets)
    for (const guide_rev of [undefined, 'stale', 42]) {
      const err = await runOp(e.deps, access, 'add_entry', { kb_id: e.a, guide_rev, title: 'x', body: 'y' }).catch(x => x as KbApiError)
      expect(err).toBeInstanceOf(KbApiError)
      expect(err).toMatchObject({ status: 412, code: 'guide_required' })
      expect((err as KbApiError).message).not.toContain(rev(e, e.a))
    }
    expect((await e.kb.listEntries(e.a)).total).toBe(0)
    // After the guide changed, the old revision no longer works.
    const old = rev(e, e.a)
    await e.kb.update(e.a, { guide: 'new rules' })
    await expect(runOp(e.deps, access, 'add_entry', { kb_id: e.a, guide_rev: old, title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'guide_required' })
    const ok = await runOp(e.deps, access, 'add_entry', { kb_id: e.a, guide_rev: rev(e, e.a), title: 'x', body: 'y' }) as any
    expect(ok).toMatchObject({ title: 'x', version: 1 })
  })

  test('add, update with a stale base_version (409 with the current entry), delete; actors are recorded', async () => {
    const e = await setup()
    const local = kbAccessOf(undefined, e.secrets)
    const keyed = kbAccessOf(e.metaOf(e.keys.rwA), e.secrets)
    const gr = rev(e, e.a)
    const added = await runOp(e.deps, local, 'add_entry', { kb_id: e.a, guide_rev: gr, title: 'Rule', body: 'use tabs', tags: ['style'] }) as any
    expect(added).toMatchObject({ id: 1, title: 'Rule', body: 'use tabs', tags: ['style'], version: 1 })
    const upd = await runOp(e.deps, keyed, 'update_entry', { kb_id: e.a, guide_rev: gr, entry_id: added.id, base_version: 1, body: 'use spaces' }) as any
    expect(upd).toMatchObject({ version: 2, body: 'use spaces' })
    // The alias baseVersion works too.
    const upd2 = await runOp(e.deps, keyed, 'update_entry', { kb_id: e.a, guide_rev: gr, entry_id: added.id, baseVersion: 2, title: 'Rule 2' }) as any
    expect(upd2.version).toBe(3)
    const conflict = await runOp(e.deps, keyed, 'update_entry', { kb_id: e.a, guide_rev: gr, entry_id: added.id, base_version: 1, body: 'x' }).catch(x => x as KbApiError)
    expect(conflict).toMatchObject({ status: 409, code: 'version_conflict', extra: { current: { id: added.id, version: 3, title: 'Rule 2' } } })
    // Reads work.
    expect(((await runOp(e.deps, keyed, 'get_entry', { kb_id: e.a, entry_id: added.id })) as any).body).toBe('use spaces')
    const list = await runOp(e.deps, keyed, 'list_entries', { kb_id: e.a }) as any
    expect(list.total).toBe(1)
    const hist = await runOp(e.deps, keyed, 'get_entry_history', { kb_id: e.a, entry_id: added.id }) as any
    expect(hist.versions.map((v: any) => [v.version, v.op, v.actor])).toEqual([[3, 'update', 'key:rwA'], [2, 'update', 'key:rwA'], [1, 'create', 'local']])
    expect(hist.versions[0]).not.toHaveProperty('body')
    expect(await runOp(e.deps, keyed, 'delete_entry', { kb_id: e.a, guide_rev: gr, entry_id: added.id, base_version: 3 })).toEqual({ deleted: true, entry_id: added.id })
    await expect(runOp(e.deps, keyed, 'get_entry', { kb_id: e.a, entry_id: added.id })).rejects.toMatchObject({ status: 404, code: 'entry_not_found' })
    expect(((await e.kb.changes(e.a)) as any[]).map(c => `${c.op}:${c.actor}`)).toEqual(['delete:key:rwA', 'update:key:rwA', 'update:key:rwA', 'create:local'])
  })

  test('add_source then read_source in pages; sources never show a path; entries are not sources', async () => {
    const e = await setup()
    const local = kbAccessOf(undefined, e.secrets)
    const gr = rev(e, e.a)
    const text = `第一章\n${'故事。'.repeat(30)}\n`.repeat(3)
    const src = await runOp(e.deps, local, 'add_source', { kb_id: e.a, guide_rev: gr, name: 'novel', text, tags: ['book'] }) as any
    expect(src).toMatchObject({ name: 'novel.txt', size: expect.any(Number), readable: true })
    expect(src).not.toHaveProperty('source')
    const listed = await runOp(e.deps, local, 'list_sources', { kb_id: e.a }) as any
    expect(listed.sources.map((s: any) => s.id)).toEqual([src.id])
    expect(JSON.stringify(listed)).not.toContain(dirs[0]!.slice(0, 12))
    const first = await runOp(e.deps, local, 'read_source', { kb_id: e.a, source_id: src.id, length: 50 }) as any
    expect(first).toMatchObject({ id: src.id, name: 'novel.txt', offset: 0, next_offset: 50 })
    expect(first.text.length).toBe(50)
    const second = await runOp(e.deps, local, 'read_source', { kb_id: e.a, source_id: src.id, offset: first.next_offset, length: 100000 }) as any
    expect(second.next_offset).toBeNull()
    // The stored text starts with the tag line made from `tags`.
    expect(first.text + second.text).toHaveLength(first.total_chars)
    const entry = await runOp(e.deps, local, 'add_entry', { kb_id: e.a, guide_rev: gr, title: 't', body: 'b' }) as any
    await expect(runOp(e.deps, local, 'read_source', { kb_id: e.a, source_id: entry.id })).rejects.toMatchObject({ status: 404, code: 'doc_not_found' })
    await expect(runOp(e.deps, local, 'read_source', { kb_id: e.a, source_id: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  test('search: allowlist, requested kb_ids, top_k clamp, tags and similarity validation', async () => {
    const e = await setup()
    const local = kbAccessOf(undefined, e.secrets)
    await runOp(e.deps, local, 'add_entry', { kb_id: e.a, guide_rev: rev(e, e.a), title: 'Needle one', body: 'needle in alpha', tags: ['x'] })
    await runOp(e.deps, local, 'add_entry', { kb_id: e.b, guide_rev: rev(e, e.b), title: 'Needle two', body: 'needle in beta' })
    const ro = kbAccessOf(e.metaOf(e.keys.ro), e.secrets)
    const mine = await runOp(e.deps, ro, 'search_knowledge', { query: 'needle' }) as any
    expect(mine.mode).toBe('keyword')
    expect(mine.results.map((r: any) => r.kb_id)).toEqual([e.a])
    expect(mine.results[0]).toMatchObject({ kind: 'entry', title_or_name: 'Needle one', version: 1, kb_name: 'Alpha', similarity: null })
    await expect(runOp(e.deps, ro, 'search_knowledge', { query: 'needle', kb_ids: [e.b] })).rejects.toMatchObject({ status: 403, code: 'kb_forbidden' })
    await expect(runOp(e.deps, ro, 'search_knowledge', { query: 'needle', kb_ids: [e.a, 'kb-nope'] })).rejects.toMatchObject({ status: 403 })
    await expect(runOp(e.deps, local, 'search_knowledge', { query: 'needle', kb_ids: ['kb-nope'] })).rejects.toMatchObject({ status: 404, code: 'kb_not_found' })
    expect(((await runOp(e.deps, local, 'search_knowledge', { query: 'needle' })) as any).results).toHaveLength(2)
    expect(((await runOp(e.deps, local, 'search_knowledge', { query: 'needle', tags: ['x'] })) as any).results).toHaveLength(1)
    // top_k is clamped to 1..20 (0 -> 1; 1000 -> 20, still only what exists).
    expect(((await runOp(e.deps, local, 'search_knowledge', { query: 'needle', top_k: 0 })) as any).results).toHaveLength(1)
    expect(((await runOp(e.deps, local, 'search_knowledge', { query: 'needle', top_k: 1000 })) as any).results).toHaveLength(2)
    await expect(runOp(e.deps, local, 'search_knowledge', { query: 'needle', min_similarity: 2 })).rejects.toMatchObject({ status: 400, code: 'bad_similarity' })
    await expect(runOp(e.deps, local, 'search_knowledge', { query: 'needle', tags: 'x' })).rejects.toMatchObject({ status: 400, code: 'bad_tags' })
    await expect(runOp(e.deps, local, 'search_knowledge', { query: 'needle', top_k: 'many' })).rejects.toMatchObject({ status: 400, code: 'invalid_parameter' })
    await expect(runOp(e.deps, local, 'search_knowledge', { query: '  ' })).rejects.toMatchObject({ status: 400, code: 'empty_query' })
    // A key that may use nothing finds nothing, and does not error.
    const gone = kbAccessOf(e.metaOf(e.keys.gone), e.secrets)
    expect(((await runOp(e.deps, gone, 'search_knowledge', { query: 'needle' })) as any).results).toEqual([])
  })

  test('the tool list covers every operation once', () => {
    expect(mcpTools(true).map(x => x.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(mcpTools(false).map(x => x.name).sort()).toEqual(['get_entry', 'get_entry_history', 'kb_guide', 'list_entries', 'list_knowledge_bases', 'list_sources', 'read_source', 'search_knowledge'])
  })
})

describe('REST adapter', () => {
  test('routes: list, guide, entries, sources, versions', async () => {
    const e = await setup()
    const list = await call(e, 'GET', '/v1/kb')
    expect(list.status).toBe(200)
    expect(list.json.knowledge_bases).toHaveLength(2)
    expect((await call(e, 'GET', '/v1/kb/')).status).toBe(200)
    const guide = await call(e, 'GET', `/v1/kb/${e.a}/guide`)
    expect(guide.json).toMatchObject({ kb_id: e.a, guide_rev: rev(e, e.a), is_default: true })
    const add = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body: { guide_rev: guide.json.guide_rev, title: 'T', body: 'hello world', tags: ['t'] } })
    expect(add.status).toBe(201)
    const id = add.json.id
    expect((await call(e, 'GET', `/v1/kb/${e.a}/entries?tag=t&limit=5`)).json.entries.map((x: any) => x.id)).toEqual([id])
    expect((await call(e, 'GET', `/v1/kb/${e.a}/entries?query=nothing`)).json.total).toBe(0)
    expect((await call(e, 'GET', `/v1/kb/${e.a}/entries/${id}`)).json.body).toBe('hello world')
    const patched = await call(e, 'PATCH', `/v1/kb/${e.a}/entries/${id}`, { body: { guide_rev: guide.json.guide_rev, base_version: 1, body: 'changed' } })
    expect(patched.json.version).toBe(2)
    expect((await call(e, 'GET', `/v1/kb/${e.a}/entries/${id}/versions`)).json.versions).toHaveLength(2)
    const src = await call(e, 'POST', `/v1/kb/${e.a}/sources`, { body: { guide_rev: guide.json.guide_rev, name: 'doc.md', text: '# Title\nsome text here' } })
    expect(src.status).toBe(201)
    expect((await call(e, 'GET', `/v1/kb/${e.a}/sources`)).json.sources).toHaveLength(1)
    const page = await call(e, 'GET', `/v1/kb/${e.a}/sources/${src.json.id}?offset=2&length=5`)
    expect(page.json).toMatchObject({ offset: 2, text: 'Title', next_offset: 7 })
    const search = await call(e, 'POST', '/v1/kb/search', { body: { query: 'changed' } })
    expect(search.json.results[0]).toMatchObject({ kind: 'entry', id })
    // DELETE: JSON body, or query parameters when there is no body.
    const del = await call(e, 'DELETE', `/v1/kb/${e.a}/entries/${id}?guide_rev=${guide.json.guide_rev}&base_version=2`)
    expect(del.json).toEqual({ deleted: true, entry_id: id })
    const second = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body: { guide_rev: guide.json.guide_rev, title: 'U', body: 'again' } })
    const del2 = await call(e, 'DELETE', `/v1/kb/${e.a}/entries/${second.json.id}`, { body: { guide_rev: guide.json.guide_rev, base_version: 1 } })
    expect(del2.status).toBe(200)
  })

  test('unknown paths are 404 not_found, wrong methods 405 with allow', async () => {
    const e = await setup()
    for (const p of ['/v1/kb/x/y/z', `/v1/kb/${e.a}/nothing`, `/v1/kb/${e.a}/entries/1/other`, `/v1/kb/${e.a}/entries/1/versions/2`]) {
      const r = await call(e, 'GET', p)
      expect({ p, status: r.status, code: r.json.error.code }).toEqual({ p, status: 404, code: 'not_found' })
    }
    const wrong = await call(e, 'PUT', `/v1/kb/${e.a}/entries/1`, { body: {} })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET, PATCH, DELETE')
    expect(wrong.json.error.code).toBe('method_not_allowed')
    expect((await call(e, 'GET', '/v1/kb/search')).status).toBe(405)
    expect((await call(e, 'POST', '/v1/kb', { body: {} })).status).toBe(405)
    expect((await call(e, 'GET', `/v1/kb/${e.a}/entries/abc`)).status).toBe(404)
  })

  test('error body has the OpenAI shape and the status of the rule', async () => {
    const e = await setup()
    const noRev = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body: { title: 'x', body: 'y' } })
    expect(noRev.status).toBe(412)
    expect(noRev.json).toEqual({ error: { message: expect.any(String), type: 'invalid_request_error', code: 'guide_required' } })
    const missing = await call(e, 'GET', '/v1/kb/kb-nope/guide')
    expect(missing.json.error).toMatchObject({ type: 'not_found_error', code: 'kb_not_found' })
    const conflict = await call(e, 'PATCH', `/v1/kb/${e.a}/entries/1`, { body: { guide_rev: rev(e, e.a), base_version: 1, body: 'x' } })
    expect(conflict.json.error.code).toBe('entry_not_found')
    await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body: { guide_rev: rev(e, e.a), title: 'x', body: 'y' } })
    await call(e, 'PATCH', `/v1/kb/${e.a}/entries/1`, { body: { guide_rev: rev(e, e.a), base_version: 1, body: 'z' } })
    const stale = await call(e, 'PATCH', `/v1/kb/${e.a}/entries/1`, { body: { guide_rev: rev(e, e.a), base_version: 1, body: 'w' } })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toMatchObject({ code: 'version_conflict', current: { id: 1, version: 2, body: 'z' } })
    const invalid = await call(e, 'POST', '/v1/kb/search', { raw: '{nope', headers: { 'content-type': 'application/json' } })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error.code).toBe('invalid_json')
    const array = await call(e, 'POST', '/v1/kb/search', { body: [1] })
    expect(array.json.error.code).toBe('invalid_json')
  })

  test('cross-site writes are refused, plain GET from another origin is not', async () => {
    const e = await setup()
    const body = { guide_rev: rev(e, e.a), title: 'x', body: 'y' }
    const evil = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body, headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } })
    expect(evil.status).toBe(403)
    expect(evil.json.error.code).toBe('cross_origin')
    const site = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body, headers: { 'sec-fetch-site': 'cross-site' } })
    expect(site.status).toBe(403)
    const plain = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })
    expect(plain.status).toBe(415)
    expect(plain.json.error.code).toBe('json_required')
    expect((await call(e, 'POST', '/v1/mcp', { raw: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call(e, 'POST', '/v1/mcp', { body: rpc(1, 'ping'), headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } })).status).toBe(403)
    expect((await e.kb.listEntries(e.a)).total).toBe(0)
    const read = await call(e, 'GET', '/v1/kb', { headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } })
    expect(read.status).toBe(200)
    const same = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body, headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } })
    expect(same.status).toBe(201)
    // Clients without Origin (curl, MCP clients) work.
    expect((await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body })).status).toBe(201)
  })

  test('body over the limit is 413', async () => {
    const e = await setup()
    const small = createKbApi({ deps: e.deps, secrets: () => e.secrets, maxBodyBytes: 100 })
    const res = await small.handle(new Request('http://127.0.0.1:3000/v1/kb/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(500) }) }), undefined)
    expect(res.status).toBe(413)
    expect(((await res.json()) as any).error.code).toBe('body_too_large')
  })

  test('a key without write cannot write over REST, and sees only its knowledge bases', async () => {
    const e = await setup()
    const meta = e.metaOf(e.keys.ro)
    expect((await call(e, 'GET', '/v1/kb', { meta })).json.knowledge_bases.map((k: any) => k.id)).toEqual([e.a])
    expect((await call(e, 'GET', `/v1/kb/${e.b}/guide`, { meta })).json.error.code).toBe('kb_forbidden')
    const w = await call(e, 'POST', `/v1/kb/${e.a}/entries`, { body: { guide_rev: rev(e, e.a), title: 'x', body: 'y' }, meta })
    expect(w.status).toBe(403)
    expect(w.json.error.code).toBe('kb_read_only')
  })
})

describe('MCP adapter', () => {
  test('initialize negotiates the protocol version and describes the server', async () => {
    const e = await setup()
    const r = await mcp(e, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(r.json.result).toMatchObject({
      protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'llama-web', version: '9.9.9' },
    })
    expect(r.json.result.instructions).toContain('kb_guide')
    expect((await mcp(e, rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))).json.result.protocolVersion).toBe('2025-11-25')
    expect((await mcp(e, rpc(3, 'initialize', { protocolVersion: '2024-11-05' }))).json.result.protocolVersion).toBe('2024-11-05')
    expect((await mcp(e, rpc('s', 'ping'))).json).toEqual({ jsonrpc: '2.0', id: 's', result: {} })
  })

  test('notifications are 202 with an empty body; a session id header is ignored and none is issued', async () => {
    const e = await setup()
    const n = await call(e, 'POST', '/v1/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { 'mcp-session-id': 'abc' } })
    expect(n.status).toBe(202)
    expect(n.text).toBe('')
    const r = await call(e, 'POST', '/v1/mcp', { body: rpc(1, 'ping'), headers: { 'mcp-session-id': 'abc' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('mcp-session-id')).toBeNull()
  })

  test('GET and DELETE are 405 with allow: POST', async () => {
    const e = await setup()
    for (const m of ['GET', 'DELETE']) {
      const r = await call(e, m, '/v1/mcp')
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('POST')
    }
  })

  test('tools/list: write tools are hidden from a read-only key', async () => {
    const e = await setup()
    const all = await mcp(e, rpc(1, 'tools/list'))
    expect(all.json.result.tools.map((x: any) => x.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(all.json.result.tools.find((x: any) => x.name === 'add_entry').inputSchema.required).toEqual(['kb_id', 'guide_rev', 'title', 'body'])
    const ro = await mcp(e, rpc(1, 'tools/list'), e.metaOf(e.keys.ro))
    expect(ro.json.result.tools).toHaveLength(8)
    expect(ro.json.result.tools.map((x: any) => x.name)).not.toContain('add_entry')
  })

  test('tools/call: success carries text and structuredContent; operation errors are isError, not JSON-RPC errors', async () => {
    const e = await setup()
    const list = await mcp(e, toolCall(1, 'list_knowledge_bases', {}))
    expect(list.json.result.isError).toBe(false)
    expect(list.json.result.structuredContent.knowledge_bases).toHaveLength(2)
    expect(toolResult(list)).toEqual(list.json.result.structuredContent)
    const noRev = await mcp(e, toolCall(2, 'add_entry', { kb_id: e.a, title: 'x', body: 'y' }))
    expect(noRev.json.error).toBeUndefined()
    expect(noRev.json.result.isError).toBe(true)
    expect(toolResult(noRev).error).toMatchObject({ code: 'guide_required' })
    const guide = toolResult(await mcp(e, toolCall(3, 'kb_guide', { kb_id: e.a })))
    const added = await mcp(e, toolCall(4, 'add_entry', { kb_id: e.a, guide_rev: guide.guide_rev, title: 'Via MCP', body: 'hello', tags: null }))
    expect(added.json.result.isError).toBe(false)
    expect(toolResult(added)).toMatchObject({ title: 'Via MCP', version: 1 })
    const conflict = await mcp(e, toolCall(5, 'update_entry', { kb_id: e.a, guide_rev: guide.guide_rev, entry_id: 1, base_version: 7, body: 'x' }))
    expect(toolResult(conflict).error).toMatchObject({ code: 'version_conflict', current: { id: 1, version: 1 } })
    const found = toolResult(await mcp(e, toolCall(6, 'search_knowledge', { query: 'hello' })))
    expect(found.results[0]).toMatchObject({ kind: 'entry', title_or_name: 'Via MCP' })
    const noArgs = await mcp(e, rpc(7, 'tools/call', { name: 'list_knowledge_bases' }))
    expect(noArgs.json.result.isError).toBe(false)
  })

  test('a read-only key calling a write tool anyway gets the kb_read_only tool error', async () => {
    const e = await setup()
    const r = await mcp(e, toolCall(1, 'add_entry', { kb_id: e.a, guide_rev: rev(e, e.a), title: 'x', body: 'y' }), e.metaOf(e.keys.ro))
    expect(r.json.result.isError).toBe(true)
    expect(toolResult(r).error.code).toBe('kb_read_only')
    expect((await e.kb.listEntries(e.a)).total).toBe(0)
  })

  test('errors: unknown method -32601, bad params / unknown tool -32602, parse error -32700, invalid request -32600', async () => {
    const e = await setup()
    expect((await mcp(e, rpc(1, 'resources/list'))).json.error.code).toBe(-32601)
    expect((await mcp(e, rpc(2, 'tools/call', { name: 'nope' }))).json.error.code).toBe(-32602)
    expect((await mcp(e, rpc(3, 'tools/call', {}))).json.error.code).toBe(-32602)
    expect((await mcp(e, rpc(4, 'tools/call', { name: 'kb_guide', arguments: 'x' }))).json.error.code).toBe(-32602)
    expect((await mcp(e, rpc(5, 'tools/list', 'x'))).json.error.code).toBe(-32602)
    const parse = await call(e, 'POST', '/v1/mcp', { raw: '{oops', headers: { 'content-type': 'application/json' } })
    expect(parse.status).toBe(400)
    expect(parse.json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
    expect((await mcp(e, { jsonrpc: '2.0', id: 1 })).json.error.code).toBe(-32600)
    expect((await mcp(e, 7)).json.error.code).toBe(-32600)
    expect((await mcp(e, [])).json.error.code).toBe(-32600)
  })

  test('batch: answers in order, skips notifications; all notifications = 202', async () => {
    const e = await setup()
    const r = await mcp(e, [rpc(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'nope'), rpc(3, 'tools/list')])
    expect(r.status).toBe(200)
    expect(r.json).toHaveLength(3)
    expect(r.json.map((x: any) => x.id)).toEqual([1, 2, 3])
    expect(r.json[1].error.code).toBe(-32601)
    expect((await mcp(e, [{ jsonrpc: '2.0', method: 'a' }, { jsonrpc: '2.0', method: 'b' }])).status).toBe(202)
  })

  test('a restricted key only reaches its knowledge bases through MCP', async () => {
    const e = await setup()
    const meta = e.metaOf(e.keys.ro)
    const forbidden = await mcp(e, toolCall(1, 'kb_guide', { kb_id: e.b }), meta)
    expect(toolResult(forbidden).error.code).toBe('kb_forbidden')
    expect(toolResult(await mcp(e, toolCall(2, 'list_knowledge_bases', {}), meta)).knowledge_bases.map((k: any) => k.id)).toEqual([e.a])
  })
})

describe('setKeyKnowledge', () => {
  test('validates ids, dedupes, accepts null, keeps the key otherwise unchanged', () => {
    const s = defaultSecrets()
    const k = createKey(s, 'k')
    expect(setKeyKnowledge(s, k.id, { kbs: ['a', 'b', 'a'], kbWrite: true }, ['a', 'b'])).toMatchObject({ kbs: ['a', 'b'], kbWrite: true })
    expect(setKeyKnowledge(s, k.id, { kbs: null, kbWrite: false }, [])).toMatchObject({ kbs: null, kbWrite: false })
    expect(setKeyKnowledge(s, k.id, { kbs: [], kbWrite: false }, [])).toMatchObject({ kbs: [] })
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as { code: string }).code } return 'none' }
    expect(code(() => setKeyKnowledge(s, k.id, { kbs: ['zz'], kbWrite: false }, ['a']))).toBe('kb-not-found')
    expect(code(() => setKeyKnowledge(s, k.id, { kbs: 'a', kbWrite: false }, ['a']))).toBe('bad-kbs')
    expect(code(() => setKeyKnowledge(s, k.id, { kbs: [1], kbWrite: false }, ['a']))).toBe('bad-kbs')
    expect(code(() => setKeyKnowledge(s, k.id, { kbs: null }, []))).toBe('bad-kbs')
    expect(code(() => setKeyKnowledge(s, k.id, null, []))).toBe('bad-kbs')
    const many = Array.from({ length: 101 }, (_, i) => `kb-${i}`)
    expect(code(() => setKeyKnowledge(s, k.id, { kbs: many, kbWrite: false }, many))).toBe('bad-kbs')
    expect(code(() => setKeyKnowledge(s, 'k-nope', { kbs: null, kbWrite: false }, []))).toBe('not-found')
    // A revoked key may still be edited (it cannot authenticate anyway).
    revokeKey(s, k.id)
    expect(setKeyKnowledge(s, k.id, { kbs: ['a'], kbWrite: true }, ['a']).kbs).toEqual(['a'])
  })
})

