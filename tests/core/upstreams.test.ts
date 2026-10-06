// External upstreams (decision 56): names, addresses, prefix routing and the edits on the document.
import { describe, expect, test } from 'bun:test'
import {
  cleanBaseUrl, createUpstream, defaultUpstreams, findExternal, listExternalNames, localConflict, selfPortsOf, upstreamPrefixClash, modelIdsOf, normalizeUpstreams,
  parseModelList, recordTest, removeUpstream, updateUpstream, UpstreamError, viewUpstreams, type EditContext, type UpstreamsDoc,
} from '../../server/core/upstreams'
import { defaultSecrets, normalizeSecrets, SECRETS_MIGRATIONS, SECRETS_VERSION } from '../../server/core/keys'

const ctx: EditContext = { localNames: ['Qwen3-8B', 'Alpha'], selfPorts: [5001, 8080] }
const codeOf = (fn: () => unknown) => { try { fn() } catch (e) { return (e as UpstreamError).code } return null }

function doc(): UpstreamsDoc {
  const d = defaultUpstreams()
  createUpstream(d, { name: 'Strata', baseUrl: 'http://127.0.0.1:9000/v1/', manualModels: ['flash-next'] }, ctx)
  return d
}

describe('address', () => {
  test('trailing slashes go, credentials / query / other schemes are refused', () => {
    expect(cleanBaseUrl('http://127.0.0.1:9000/v1/')).toBe('http://127.0.0.1:9000/v1')
    expect(cleanBaseUrl('https://example.com')).toBe('https://example.com')
    for (const bad of ['', 'ftp://x/v1', 'http://u:p@x/v1', 'http://x/v1?a=1', 'http://x/v1#h', 'not a url', 5]) {
      expect(codeOf(() => cleanBaseUrl(bad))).toBe('bad-url')
    }
  })

  test('an address that points at llama-web itself is refused (forwarding loop)', () => {
    expect(codeOf(() => cleanBaseUrl('http://127.0.0.1:5001/v1', [5001]))).toBe('url-self')
    expect(codeOf(() => cleanBaseUrl('http://localhost:8080/v1', [5001, 8080]))).toBe('url-self')
    expect(codeOf(() => cleanBaseUrl('http://0.0.0.0:5001/v1', [5001]))).toBe('url-self')
    expect(cleanBaseUrl('http://127.0.0.1:9000/v1', [5001, 8080])).toBe('http://127.0.0.1:9000/v1')
    // The same port on another machine is another service.
    expect(cleanBaseUrl('http://192.168.1.5:5001/v1', [5001])).toBe('http://192.168.1.5:5001/v1')
  })
})

describe('names and routing', () => {
  test('a prefix has no dash, colon, slash or space', () => {
    for (const bad of ['', ' ', 'a-b', 'a:b', 'a/b', 'a b', 'x'.repeat(25)]) {
      expect(codeOf(() => createUpstream(defaultUpstreams(), { name: bad, baseUrl: 'http://x/v1' }, ctx))).toBe('bad-name')
    }
  })

  test('the prefix must be unique (case-insensitive) and must not shadow a local model', () => {
    const d = doc()
    expect(codeOf(() => createUpstream(d, { name: 'strata', baseUrl: 'http://x/v1' }, ctx))).toBe('name-taken')
    expect(codeOf(() => createUpstream(d, { name: 'qwen3', baseUrl: 'http://x/v1' }, ctx))).toBe('name-local-conflict')
    // A local model that only equals the prefix is no conflict: the client name always has a dash after it.
    expect(() => createUpstream(d, { name: 'Alpha', baseUrl: 'http://x/v1' }, ctx)).not.toThrow()
    expect(localConflict('Qwen3', ['Qwen3-8B'])).toBe('Qwen3-8B')
    expect(localConflict('Qwen', ['Qwen3-8B'])).toBeNull()
  })

  test('the public port is ours only while the public entry really listens', () => {
    expect(selfPortsOf(5001, 5001, { state: 'listening', port: 8080 })).toEqual([5001, 5001, 8080])
    // Switched on but the port is taken by another engine: not ours, an upstream there is fine.
    expect(selfPortsOf(5001, 5001, { state: 'error', port: 8080 })).toEqual([5001, 5001])
    expect(selfPortsOf(5001, 5001, { state: 'off' })).toEqual([5001, 5001])
  })

  test('a local model name is checked against the prefixes the other way round', () => {
    expect(upstreamPrefixClash('Strata-Local', ['strata'])).toBe('strata')
    expect(upstreamPrefixClash('Strata', ['strata'])).toBeNull()
    expect(upstreamPrefixClash('Stratagem-1', ['strata'])).toBeNull()
  })

  test('<prefix>-<id> finds the upstream and its own model id, with any dashes after the first', () => {
    const d = doc()
    const r = findExternal(d, 'Strata-flash-next-v2')
    expect(r?.upstream.name).toBe('Strata')
    expect(r?.modelId).toBe('flash-next-v2')
    expect(findExternal(d, 'strata-x')?.modelId).toBe('x')
    for (const no of ['Strata', 'Strata-', '-x', 'Other-x', '', 7, null, undefined]) expect(findExternal(d, no)).toBeNull()
    expect(findExternal(null, 'Strata-x')).toBeNull()
  })

  test('the model list shows tested and hand-typed ids once, with the prefix', () => {
    const d = doc()
    recordTest(d, d.upstreams[0]!.id, ['a', 'flash-next', 'b'])
    expect(modelIdsOf(d.upstreams[0]!)).toEqual(['a', 'flash-next', 'b'])
    expect(listExternalNames(d)).toEqual(['Strata-a', 'Strata-flash-next', 'Strata-b'])
  })

  test('parseModelList reads OpenAI answers and ignores anything else', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, {}, 'c'] })).toEqual(['a', 'b', 'c'])
    expect(parseModelList(['x', { id: 'y' }])).toEqual(['x', 'y'])
    expect(parseModelList({ error: 'nope' })).toEqual([])
    expect(parseModelList(null)).toEqual([])
  })
})

describe('edits', () => {
  test('defaults: runs here and exclusive; images follow the global switch', () => {
    const u = doc().upstreams[0]!
    expect(u).toMatchObject({ local: true, exclusive: true, imageCompress: 'inherit', models: [], baseUrl: 'http://127.0.0.1:9000/v1' })
    expect(u.id).toMatch(/^u-[0-9a-f]{8}$/)
  })

  test('a changed address drops the tested model list, other edits keep it', () => {
    const d = doc()
    const id = d.upstreams[0]!.id
    recordTest(d, id, ['a'])
    updateUpstream(d, id, { imageCompress: 'off', exclusive: false }, ctx)
    expect(d.upstreams[0]).toMatchObject({ models: ['a'], imageCompress: 'off', exclusive: false })
    updateUpstream(d, id, { baseUrl: 'http://127.0.0.1:9001/v1' }, ctx)
    expect(d.upstreams[0]).toMatchObject({ models: [], testedAt: '' })
    expect(codeOf(() => updateUpstream(d, id, { imageCompress: 'maybe' }, ctx))).toBe('bad-mode')
    expect(codeOf(() => updateUpstream(d, 'nope', {}, ctx))).toBe('not-found')
  })

  test('renaming keeps the same checks, and the old name is free again', () => {
    const d = doc()
    createUpstream(d, { name: 'Vllm', baseUrl: 'http://x/v1' }, ctx)
    const [a, b] = d.upstreams
    expect(codeOf(() => updateUpstream(d, b!.id, { name: 'STRATA' }, ctx))).toBe('name-taken')
    expect(() => updateUpstream(d, a!.id, { name: 'Strata' }, ctx)).not.toThrow()
    updateUpstream(d, a!.id, { name: 'Strata2' }, ctx)
    expect(() => updateUpstream(d, b!.id, { name: 'Strata' }, ctx)).not.toThrow()
  })

  test('remove', () => {
    const d = doc()
    expect(removeUpstream(d, d.upstreams[0]!.id).name).toBe('Strata')
    expect(d.upstreams).toEqual([])
    expect(codeOf(() => removeUpstream(d, 'x'))).toBe('not-found')
  })

  test('a view tells whether a key is saved, never the key', () => {
    const d = doc()
    const id = d.upstreams[0]!.id
    const views = viewUpstreams(d, { [id]: 'sk-secret-secret-secret' }) // pre-commit:allow fake test key
    expect(views[0]!.hasKey).toBe(true)
    expect(JSON.stringify(views)).not.toContain('sk-secret')
    expect(viewUpstreams(d, {})[0]!.hasKey).toBe(false)
  })
})

describe('upstreams.json and secrets.json', () => {
  test('a hand-edited file is normalised; a broken one is refused', () => {
    const d = normalizeUpstreams({ version: 1, upstreams: [{ id: 'u1', name: 'A', baseUrl: 'http://x/v1/' } as any] })
    expect(d.upstreams[0]).toMatchObject({ baseUrl: 'http://x/v1', local: true, exclusive: true, imageCompress: 'inherit', models: [], manualModels: [] })
    expect(() => normalizeUpstreams({ version: 1, upstreams: [{ id: 'u1', name: 'A-B', baseUrl: 'http://x/v1' } as any] })).toThrow()
    expect(() => normalizeUpstreams({ version: 1, upstreams: [{ id: 'u1', name: 'A', baseUrl: 'http://x/v1' }, { id: 'u2', name: 'a', baseUrl: 'http://x/v1' }] as any })).toThrow()
  })

  test('secrets version 4 adds upstreamKeys; version 3 files migrate without losing anything', () => {
    expect(SECRETS_VERSION).toBe(4)
    expect(defaultSecrets().upstreamKeys).toEqual({})
    const migrated = SECRETS_MIGRATIONS[3]!({ version: 3, apiKeys: [], tunnelToken: 't', cloudflareToken: 'c' })
    expect(migrated).toMatchObject({ tunnelToken: 't', cloudflareToken: 'c', upstreamKeys: {} })
    expect(() => normalizeSecrets({ ...defaultSecrets(), upstreamKeys: { u1: 5 as any } })).toThrow()
  })
})
