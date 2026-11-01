// Gateway web search (decision 67): backend parsing, order / fallback / health, management patch, configuration
// migrations, and the proxy's tool loop (local model and external upstream; buffered and streaming). Fakes only.
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultSettings, normalizeModels, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION, type ModelsDoc } from '../../server/core/config'
import { setLocale, t } from '../../server/core/i18n'
import { defaultSecrets, normalizeSecrets, SECRETS_MIGRATIONS, SECRETS_VERSION } from '../../server/core/keys'
import { createProxy, type ProxyEvent } from '../../server/core/proxy'
import type { RequestRecord } from '../../server/core/request-log'
import type { Lease, Target } from '../../server/core/scheduler'
import { createUpstream, defaultUpstreams, normalizeUpstreams, UPSTREAMS_MIGRATIONS, UPSTREAMS_VERSION, updateUpstream, type UpstreamsDoc } from '../../server/core/upstreams'
import { bingTarget, ddgTarget, parseBing, parseDuckDuckGo, SearchError } from '../../server/core/web-search/backends'
import { applyKeys, describeWebSearch, parseWebSearchPatch, WebSearchAdminError } from '../../server/core/web-search/admin'
import { AllBackendsFailed, COOLDOWN_MS, createWebSearch, type BackendOption, type SearchOutcome } from '../../server/core/web-search/manager'
import { fetchFailureText, fetchPage, htmlToText, PageFetchError, parseFetchArguments } from '../../server/core/web-search/fetch'
import { addWebTools, backendLabel, FETCH_TOOL_NAME, fetchToolDefinition, formatPage, formatWebResults, GUIDE_TOOL_NAME, guideText, hasWebTool, MAX_WEB_ROUNDS, offerableBackends, parseWebArguments, removeWebTool, webToolDefinition, WEB_TOOL_NAME } from '../../server/core/web-search/tool'

setLocale('zh-CN')

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

// ---------------------------------------------------------------------------------------
// Parsing

const DDG_HTML = `
<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; <b>One</b></a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">The <b>first</b> snippet.</a></div>
<div class="result"><h2 class="result__title"><a class="result__a" href="https://example.org/b">Two</a></h2>
<a class="result__snippet" href="x">Second snippet</a></div>
<div class="result"><a class="result__a" href="javascript:alert(1)">Bad</a></div>`

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const BING_HTML = `
<ol><li class="b_algo"><h2><a href="https://example.com/one">One &amp; only</a></h2><div class="b_caption"><p>First <strong>snippet</strong></p></div></li>
<li class="b_algo" data-id=""><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=zzz&amp;u=a1${b64url('https://example.net/two')}&amp;ntb=1">Two</a></h2><p>Second</p></li>
<li class="b_ans"><h2><a href="https://ignored.example">Not an algo block</a></h2></li></ol>`

describe('result page parsing', () => {
  test('DuckDuckGo: unwraps the redirect, strips tags and entities, drops non-http links', () => {
    const hits = parseDuckDuckGo(DDG_HTML)
    expect(hits).toEqual([
      { title: 'Example & One', url: 'https://example.com/a?x=1', snippet: 'The first snippet.' },
      { title: 'Two', url: 'https://example.org/b', snippet: 'Second snippet' },
    ])
    expect(ddgTarget('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F')).toBe('https://a.example/')
    expect(ddgTarget('javascript:alert(1)')).toBeNull()
  })

  test('Bing: only b_algo blocks, tracking links are decoded', () => {
    const hits = parseBing(BING_HTML)
    expect(hits).toEqual([
      { title: 'One & only', url: 'https://example.com/one', snippet: 'First snippet' },
      { title: 'Two', url: 'https://example.net/two', snippet: 'Second' },
    ])
    expect(bingTarget('https://www.bing.com/ck/a?u=nothing')).toBeNull()
    expect(bingTarget('https://example.com/x')).toBe('https://example.com/x')
  })
})

// ---------------------------------------------------------------------------------------
// Order, fallback, health

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

/** A fetch that answers per host; `calls` lists the hosts in the order they were asked. */
function fakeNet(handlers: Partial<Record<string, Handler>>) {
  const calls: string[] = []
  const fetchImpl = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push(url.hostname)
    const h = handlers[url.hostname]
    if (!h) return new Response('no handler', { status: 500 })
    return h(url, init)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const tavilyOk: Handler = () => Response.json({ results: [{ title: 'T', url: 'https://t.example/', content: 'tavily text' }] })
const braveOk: Handler = () => Response.json({ web: { results: [{ title: '<b>B</b>', url: 'https://b.example/', description: 'brave <b>text</b>' }] } })
const ddgOk: Handler = () => new Response(DDG_HTML)
const bingOk: Handler = () => new Response(BING_HTML)
const fail = (status: number): Handler => () => new Response('x', { status })
const never = new AbortController().signal

describe('backend order and fallback', () => {
  test('without keys the keyless backends answer, DuckDuckGo first; the first answer wins', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': ddgOk, 'www.bing.com': bingOk })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl })
    const out = await ws.search('q', 5, never)
    expect(out.backend).toBe('duckduckgo')
    expect(out.hits).toHaveLength(2)
    expect(net.calls).toEqual(['html.duckduckgo.com'])
  })

  test('free-first (default): with keys saved the free backends still answer first and no paid call is made', async () => {
    const net = fakeNet({ 'api.tavily.com': tavilyOk, 'api.search.brave.com': braveOk, 'html.duckduckgo.com': ddgOk })
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'tv-key', brave: 'br-key' }), fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never)).backend).toBe('duckduckgo')
    expect(net.calls).toEqual(['html.duckduckgo.com'])
  })

  test('free-first: the paid ones are only the fallback, after both free backends failed or found nothing', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': fail(503), 'www.bing.com': () => new Response('<html></html>'), 'api.tavily.com': tavilyOk, 'api.search.brave.com': braveOk })
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'tv-key', brave: 'br-key' }), fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never)).backend).toBe('tavily')
    expect(net.calls).toEqual(['html.duckduckgo.com', 'www.bing.com', 'api.tavily.com']) // Brave is not spent once Tavily answered
  })

  test('keyed-first: backends with a key go first (Tavily, then Brave), and the key is sent as the API wants it', async () => {
    let tavilyAuth = ''
    let braveToken = ''
    const net = fakeNet({
      'api.tavily.com': (_u, init) => { tavilyAuth = new Headers(init.headers).get('authorization') ?? ''; return Response.json({ results: [] }) },
      'api.search.brave.com': (_u, init) => { braveToken = new Headers(init.headers).get('x-subscription-token') ?? ''; return braveOk(_u, init) },
      'html.duckduckgo.com': ddgOk,
    })
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'tv-key', brave: 'br-key' }), getOrder: () => 'keyed-first', fetchImpl: net.fetchImpl })
    const out = await ws.search('q', 3, never)
    expect(out).toEqual({ backend: 'brave', hits: [{ title: 'B', url: 'https://b.example/', snippet: 'brave text' }] })
    expect(tavilyAuth).toBe('Bearer tv-key')
    expect(braveToken).toBe('br-key')
    expect(net.calls).toEqual(['api.tavily.com', 'api.search.brave.com']) // an empty answer falls through; the keyless ones are not asked
  })

  test('a backend without its key is skipped; a failing one hands over to the next', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': fail(503), 'www.bing.com': bingOk })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never)).backend).toBe('bing')
    expect(net.calls).toEqual(['html.duckduckgo.com', 'www.bing.com'])
  })

  test('a rejected key (401) blocks the backend until the key changes', async () => {
    let key = 'bad'
    const net = fakeNet({ 'api.tavily.com': fail(401), 'html.duckduckgo.com': ddgOk })
    const ws = createWebSearch({ getKeys: () => ({ tavily: key }), getOrder: () => 'keyed-first', fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never)).backend).toBe('duckduckgo')
    expect(ws.status().find(s => s.id === 'tavily')!.state).toBe('blocked')
    net.calls.length = 0
    await ws.search('q', 5, never)
    expect(net.calls).toEqual(['html.duckduckgo.com']) // not tried again
    key = 'good'
    expect(ws.status().find(s => s.id === 'tavily')!.state).toBe('ready')
  })

  test('a transient failure (429) pauses the backend for a minute, then it is tried again', async () => {
    let at = 1_000
    const net = fakeNet({ 'html.duckduckgo.com': fail(429), 'www.bing.com': bingOk })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl, now: () => at })
    await ws.search('q', 5, never)
    expect(ws.status().find(s => s.id === 'duckduckgo')!.state).toBe('cooldown')
    net.calls.length = 0
    await ws.search('q', 5, never)
    expect(net.calls).toEqual(['www.bing.com'])
    at += COOLDOWN_MS + 1
    net.calls.length = 0
    await ws.search('q', 5, never)
    expect(net.calls[0]).toBe('html.duckduckgo.com')
  })

  test('an empty answer is no failure; a backend that answers nothing anywhere ends in AllBackendsFailed', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': () => new Response('<html>no results</html>'), 'www.bing.com': () => new Response('<html></html>') })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl })
    await expect(ws.search('q', 5, never)).rejects.toBeInstanceOf(AllBackendsFailed)
    expect(ws.status().every(s => s.state === 'ready' || s.state === 'no-key')).toBe(true)
  })

  test('a DuckDuckGo bot-check page is a pause, not an empty answer', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': () => new Response('<html>anomaly-modal challenge</html>'), 'www.bing.com': bingOk })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never)).backend).toBe('bing')
    expect(ws.status().find(s => s.id === 'duckduckgo')!.state).toBe('cooldown')
  })

  test('the caller leaving stops the search and rethrows (no state is recorded)', async () => {
    const ac = new AbortController()
    const net = fakeNet({ 'html.duckduckgo.com': (_u, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))) })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl })
    const p = ws.search('q', 5, ac.signal)
    setTimeout(() => ac.abort(new Error('client gone')), 10)
    await expect(p).rejects.toThrow('client gone')
    expect(ws.status().find(s => s.id === 'duckduckgo')!.state).toBe('ready')
  })

  test('a slow backend times out and hands over', async () => {
    const net = fakeNet({
      'html.duckduckgo.com': (_u, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('x')))),
      'www.bing.com': bingOk,
    })
    const ws = createWebSearch({ getKeys: () => ({}), fetchImpl: net.fetchImpl, timeoutMs: 30 })
    expect((await ws.search('q', 5, never)).backend).toBe('bing')
  })

  test('SearchError kinds are what the manager reads', () => {
    expect(new SearchError('auth', 'x').kind).toBe('auth')
  })
})

// ---------------------------------------------------------------------------------------
// Tool, arguments, management

describe('free only, naming a backend, what is available', () => {
  const keys = { tavily: 'tv-key', brave: 'br-key' }

  test('free-only (the default setting): the gateway never uses a paid backend by itself, even when every free one failed', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': fail(503), 'www.bing.com': fail(503), 'api.tavily.com': tavilyOk, 'api.search.brave.com': braveOk })
    const ws = createWebSearch({ getKeys: () => keys, getOrder: () => 'free-only', fetchImpl: net.fetchImpl })
    await expect(ws.search('q', 5, never)).rejects.toBeInstanceOf(AllBackendsFailed)
    expect(net.calls).toEqual(['html.duckduckgo.com', 'www.bing.com'])
  })

  test('naming a backend uses that one only, whatever the order setting is', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': ddgOk, 'api.tavily.com': tavilyOk })
    const ws = createWebSearch({ getKeys: () => keys, getOrder: () => 'free-only', fetchImpl: net.fetchImpl })
    expect((await ws.search('q', 5, never, 'tavily')).backend).toBe('tavily')
    expect(net.calls).toEqual(['api.tavily.com'])
  })

  test('a named backend that fails, has no key or is blocked ends in AllBackendsFailed and nothing else is tried', async () => {
    const net = fakeNet({ 'api.tavily.com': fail(401), 'html.duckduckgo.com': ddgOk })
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'bad' }), fetchImpl: net.fetchImpl })
    await expect(ws.search('q', 5, never, 'tavily')).rejects.toBeInstanceOf(AllBackendsFailed)
    await expect(ws.search('q', 5, never, 'tavily')).rejects.toBeInstanceOf(AllBackendsFailed) // blocked now: not asked again
    await expect(ws.search('q', 5, never, 'brave')).rejects.toBeInstanceOf(AllBackendsFailed) // no key
    expect(net.calls).toEqual(['api.tavily.com'])
  })

  test('available(): the backends that can answer now, free ones first, each marked paid or not', () => {
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'tv' }), fetchImpl: fakeNet({}).fetchImpl })
    expect(ws.available()).toEqual([{ id: 'duckduckgo', paid: false }, { id: 'bing', paid: false }, { id: 'tavily', paid: true }])
    expect(createWebSearch({ getKeys: () => ({}), fetchImpl: fakeNet({}).fetchImpl }).available().every(b => !b.paid)).toBe(true)
  })

  test('available() leaves out a backend that is blocked or cooling down', async () => {
    const net = fakeNet({ 'html.duckduckgo.com': fail(429), 'www.bing.com': bingOk, 'api.tavily.com': fail(401) })
    const ws = createWebSearch({ getKeys: () => ({ tavily: 'bad' }), getOrder: () => 'keyed-first', fetchImpl: net.fetchImpl })
    await ws.search('q', 5, never)
    expect(ws.available().map(b => b.id)).toEqual(['bing'])
  })
})

describe('the tool', () => {
  test('add / remove keep the client tools; tools goes when nothing is left; a client web_search is detected', () => {
    const json: any = { tools: [{ type: 'function', function: { name: 'client' } }] }
    expect(addWebTools(json)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(json.tools.map((x: any) => x.function.name)).toEqual(['client', WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(hasWebTool(json)).toBe(true)
    removeWebTool(json)
    expect(json.tools).toHaveLength(1) // both of ours are gone
    expect(hasWebTool(json)).toBe(false)
    const only: any = {}
    addWebTools(only)
    removeWebTool(only)
    expect('tools' in only).toBe(false)
    expect(hasWebTool({ tools: [{ name: 'web_search' }] })).toBe(true)
  })

  test('the definition tells the model what the tool returns and how to use it', () => {
    const d = webToolDefinition().function
    expect(d.description).toBe(t.webPrompt.toolDescription)
    expect(d.description).toBe('联网搜索，返回结果的标题、链接和摘要。') // a plain label; how to use it is for the user's own prompts
    expect(d.parameters.required).toEqual(['query'])
    expect(fetchToolDefinition().function.parameters.required).toEqual(['url'])
  })

  test('the description lists the backends that can be named, each marked free or paid; the parameter is an enum of them', () => {
    const backends: BackendOption[] = [{ id: 'duckduckgo', paid: false }, { id: 'tavily', paid: true }]
    const d = webToolDefinition({ backends }).function
    expect(d.description).toContain('可用后端：DuckDuckGo（免费）、Tavily（付费）')
    expect(d.description).toContain(t.webPrompt.autoFree)
    expect((d.parameters.properties as any).backend).toMatchObject({ type: 'string', enum: ['duckduckgo', 'tavily'], description: t.webPrompt.toolBackendPaid })
    expect(webToolDefinition({ backends, autoPaid: true }).function.description).toContain(t.webPrompt.autoMixed)
    expect((webToolDefinition({ backends: [{ id: 'bing', paid: false }] }).function.parameters.properties as any).backend.description).toBe(t.webPrompt.toolBackend)
    expect('backend' in (webToolDefinition().function.parameters.properties as object)).toBe(false)
    expect(backendLabel('brave')).toBe('Brave Search（付费）')
  })

  test('a paid backend is only offered together with the guide tool', () => {
    const offered: BackendOption[] = [{ id: 'bing', paid: false }, { id: 'tavily', paid: true }]
    expect(offerableBackends({}, offered)).toEqual(offered)
    expect(offerableBackends({ tools: [{ type: 'function', function: { name: GUIDE_TOOL_NAME } }] }, offered)).toEqual([{ id: 'bing', paid: false }])
  })

  test('arguments: query required, count clamped, backend lower-cased when given', () => {
    expect(parseWebArguments('{"query":"x","backend":" Tavily "}')).toEqual({ query: 'x', count: 5, backend: 'tavily' })
    expect(parseWebArguments('{"query":"x","backend":5}')).toEqual({ query: 'x', count: 5 })
    expect(parseWebArguments('{"query":"x","backend":""}')).toEqual({ query: 'x', count: 5 })
  })

  test('arguments: query required, count clamped, anything else is refused', () => {
    expect(parseWebArguments('{"query":" hi "}')).toEqual({ query: 'hi', count: 5 })
    expect(parseWebArguments('{"query":"x","count":99}')).toEqual({ query: 'x', count: 10 })
    expect(parseWebArguments('{"query":"x","count":"3"}')).toEqual({ query: 'x', count: 3 })
    for (const bad of ['{oops', '[]', '{}', '{"query":"  "}', '{"query":5}']) expect(parseWebArguments(bad)).toBeNull()
  })

  test('results come with the not-instructions header, numbered, and long text is cut', () => {
    const text = formatWebResults([{ title: 'T'.repeat(300), url: 'https://a.example/', snippet: 'S'.repeat(900) }, { title: 'Two', url: 'https://b.example/', snippet: '' }], 'brave')
    expect(text.startsWith('搜索后端：Brave Search（付费）')).toBe(true)
    expect(text).toContain('[1] ')
    expect(text).toContain('[2] Two\nhttps://b.example/')
    expect(text).not.toContain('T'.repeat(250))
    expect(text).not.toContain('S'.repeat(600))
  })
})

describe('management patch', () => {
  test('valid: switch and keys, trimmed; empty removes', () => {
    expect(parseWebSearchPatch({ order: 'free-only' })).toEqual({ order: 'free-only' })
    expect(parseWebSearchPatch({ guide: 'my rules', guideRequired: false })).toEqual({ guide: 'my rules', guideRequired: false })
    expect(parseWebSearchPatch({ guide: '' })).toEqual({ guide: '' })
    expect(parseWebSearchPatch({ enabled: false, order: 'keyed-first', keys: { tavily: ' tv-1 ', brave: '' } })).toEqual({ enabled: false, order: 'keyed-first', keys: { tavily: 'tv-1', brave: '' } })
    const doc = { searchKeys: { brave: 'old', tavily: 'keep' } as Record<string, string> }
    applyKeys(doc, { brave: '', tavily: 'new' })
    expect(doc.searchKeys).toEqual({ tavily: 'new' })
  })

  test('invalid: nothing is accepted', () => {
    const code = (b: unknown) => { try { parseWebSearchPatch(b) } catch (e) { return (e as WebSearchAdminError).code } return 'none' }
    expect(code(null)).toBe('bad-request')
    expect(code({ enabled: 'yes' })).toBe('bad-request')
    expect(code({ order: 'paid-first' })).toBe('bad-request')
    expect(code({ guide: 5 })).toBe('bad-request')
    expect(code({ guide: 'x'.repeat(8001) })).toBe('bad-guide')
    expect(code({ guideRequired: 'yes' })).toBe('bad-request')
    expect(code({ keys: { google: 'x' } })).toBe('bad-request')
    expect(code({ keys: { tavily: 5 } })).toBe('bad-key')
    expect(code({ keys: { tavily: 'has space' } })).toBe('bad-key')
    expect(code({ keys: { tavily: 'x'.repeat(301) } })).toBe('bad-key')
  })

  test('the view says whether a key is saved and never contains it', () => {
    const view = describeWebSearch({ enabled: true, order: 'free-first', guide: '', guideRequired: true }, 'DEFAULT GUIDE', { tavily: 'secret-value' }, [{ id: 'tavily', state: 'ready' }, { id: 'brave', state: 'no-key' }, { id: 'duckduckgo', state: 'ready' }])
    expect(view.backends).toEqual([
      { id: 'tavily', needsKey: true, hasKey: true, state: 'ready' },
      { id: 'brave', needsKey: true, hasKey: false, state: 'no-key' },
      { id: 'duckduckgo', needsKey: false, hasKey: false, state: 'ready' },
    ])
    expect(JSON.stringify(view)).not.toContain('secret-value')
    expect(view).toMatchObject({ guide: '', defaultGuide: 'DEFAULT GUIDE', guideRequired: true })
  })
})

describe('configuration migrations', () => {
  test('settings v13 -> v14 turns it on, keeps an existing value; defaults are on', () => {
    expect(SETTINGS_VERSION).toBe(14)
    expect(SETTINGS_MIGRATIONS[13]!({})).toEqual({ webSearch: { enabled: true, order: 'free-only', guide: '', guideRequired: true } })
    expect(SETTINGS_MIGRATIONS[13]!({ webSearch: { enabled: false } })).toEqual({ webSearch: { enabled: false, order: 'free-only', guide: '', guideRequired: true } })
    expect(defaultSettings().webSearch).toEqual({ enabled: true, order: 'free-only', guide: '', guideRequired: true })
    const doc = defaultSettings()
    ;(doc as any).webSearch = { enabled: 'x' }
    expect(normalizeSettings(doc).webSearch.enabled).toBe(true)
    ;(doc as any).webSearch = { enabled: true, order: 'x' }
    expect(normalizeSettings(doc).webSearch.order).toBe('free-only')
    ;(doc as any).webSearch = { enabled: true, order: 'free-first', guide: 5, guideRequired: 'x' }
    expect(normalizeSettings(doc).webSearch).toMatchObject({ guide: '', guideRequired: true })
    ;(doc as any).webSearch = { enabled: true, order: 'free-first', guide: 'x'.repeat(8001), guideRequired: false }
    expect(normalizeSettings(doc).webSearch).toMatchObject({ guide: '', guideRequired: false })
  })

  test('secrets v4 -> v5 adds searchKeys; a wrong shape is refused', () => {
    expect(SECRETS_VERSION).toBe(5)
    expect(SECRETS_MIGRATIONS[4]!({ version: 4 })).toMatchObject({ searchKeys: {} })
    expect(defaultSecrets().searchKeys).toEqual({})
    expect(normalizeSecrets({ version: 4, apiKeys: [] } as any).searchKeys).toEqual({})
    expect(() => normalizeSecrets({ version: 5, apiKeys: [], searchKeys: [] } as any)).toThrow()
    expect(() => normalizeSecrets({ version: 5, apiKeys: [], searchKeys: { tavily: 5 } } as any)).toThrow()
  })

  test('upstreams v2 -> v3 turns it on; new upstreams default on; edits can turn it off', () => {
    expect(UPSTREAMS_VERSION).toBe(3)
    const old = { version: 2, upstreams: [{ id: 'u-1' }] }
    expect(UPSTREAMS_MIGRATIONS[2]!(old).upstreams[0].webSearch).toBe(true)
    const doc = defaultUpstreams()
    const u = createUpstream(doc, { name: 'Strata', baseUrl: 'http://127.0.0.1:9/v1' }, { localNames: [], selfPorts: [] })
    expect(u.webSearch).toBe(true)
    updateUpstream(doc, u.id, { webSearch: false }, { localNames: [], selfPorts: [] })
    expect(doc.upstreams[0]!.webSearch).toBe(false)
    expect(normalizeUpstreams(JSON.parse(JSON.stringify(doc))).upstreams[0]!.webSearch).toBe(false)
    const legacy = JSON.parse(JSON.stringify(doc))
    delete legacy.upstreams[0].webSearch
    expect(normalizeUpstreams(legacy).upstreams[0]!.webSearch).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// Proxy: the tool loop

const UPSTREAM_KEY = 'sk-upstream-own-key-0123456789' // pre-commit:allow fake test key

type Round = (body: any, n: number) => Response | Promise<Response>

function scriptedServer(rounds: Round[]) {
  const seen: any[] = []
  const srv = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text()
      const n = seen.push({ body: text ? JSON.parse(text) : null }) - 1
      return rounds[Math.min(n, rounds.length - 1)]!(seen[n].body, n)
    },
  })
  closers.push(() => srv.stop(true))
  return { seen, port: srv.port!, url: `http://127.0.0.1:${srv.port}/v1` }
}

const callOf = (name: string, args: object, id = 'call_1') => Response.json({
  id: 'r', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})
const answer = (text: string) => Response.json({ id: 'r', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const sseResponse = (events: string[]) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
const streamCall = (name: string, args: object) => sseResponse([
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] }),
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  'data: [DONE]\n\n',
])
const streamAnswer = (text: string) => sseResponse([
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] }),
  sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }),
  'data: [DONE]\n\n',
])

const OUTCOME: SearchOutcome = { backend: 'duckduckgo', hits: [{ title: 'Result One', url: 'https://example.com/a', snippet: 'about the thing' }] }

function setup(opts: {
  rounds: Round[]
  enabled?: boolean
  upstreamSwitch?: boolean
  searchFails?: 'all' | 'other'
  withKnowledge?: boolean
  noWebDeps?: boolean
  fetchFails?: boolean
  /** The guide setting: `required` defaults to false in this harness; `custom` is the user's own text. */
  guide?: { required?: boolean, custom?: string }
  /** The backends the model may name (default: two free ones and Tavily, paid) and whether the gateway may use a paid one by itself. */
  backends?: BackendOption[]
  autoPaid?: boolean
}) {
  const srv = scriptedServer(opts.rounds)
  const models: ModelsDoc = normalizeModels({
    version: 1,
    models: [{ id: 'a', name: 'Alpha', backend: 'llama-server', file: { dirId: 'd', rel: 'a.gguf' }, mmproj: null, draft: null, activeProfile: 'default',
      ...(opts.withKnowledge ? { knowledge: { enabled: true, all: true, kbs: [], mode: 'tool', topK: 5 } } : {}),
      profiles: { default: { overrides: {}, extraArgs: '' } } }],
  })
  const upstreams: UpstreamsDoc = defaultUpstreams()
  createUpstream(upstreams, { name: 'Strata', baseUrl: srv.url, manualModels: ['qwen-x'], webSearch: opts.upstreamSwitch }, { localNames: [], selfPorts: [] })
  const queries: string[] = []
  const fetched: string[] = []
  const onlies: Array<string | undefined> = []
  const records: RequestRecord[] = []
  const events: ProxyEvent[] = []
  const leases = { released: 0 }
  const proxy = createProxy({
    scheduler: {
      acquire: async (target: Target) => ({ target, port: srv.port, signal: new AbortController().signal, release: () => { leases.released++ } }) as Lease,
      snapshot: () => ({ models: [], queue: [] }),
      stateOf: () => 'ready',
    } as any,
    getModels: () => models, getSettings: () => defaultSettings(), heartbeatMs: 10,
    getUpstreams: () => upstreams, getUpstreamKey: () => UPSTREAM_KEY,
    onRequest: r => records.push(r), onEvent: e => events.push(e),
    ...(opts.withKnowledge ? { knowledge: {
      search: async () => ({ hits: [{ docName: 'd.txt', startLine: 1, headingPath: '', text: 'kb text' }] }),
      list: () => [{ id: 'kb-aaaa1111', name: 'Manual' }],
    } } : {}),
    ...(opts.noWebDeps ? {} : { webSearch: {
      enabled: () => opts.enabled !== false,
      guide: () => ({ custom: opts.guide?.custom ?? '', required: opts.guide?.required === true }),
      offer: () => ({ backends: opts.backends ?? [{ id: 'duckduckgo', paid: false }, { id: 'bing', paid: false }, { id: 'tavily', paid: true }], autoPaid: opts.autoPaid === true }),
      search: async (q: string, _n: number, _signal: AbortSignal, only?: string) => {
        queries.push(q)
        onlies.push(only)
        if (opts.searchFails === 'all') throw new AllBackendsFailed()
        if (opts.searchFails === 'other') throw new Error('boom')
        return only ? { ...OUTCOME, backend: only as SearchOutcome['backend'] } : OUTCOME
      },
      fetchPage: async (url: string) => {
        fetched.push(url)
        if (opts.fetchFails) throw new PageFetchError('http', '404')
        return { url, title: 'A Page', text: 'page body text', truncated: false }
      },
    } }),
  })
  const post = (body: unknown) => proxy.handleV1(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { srv, post, queries, onlies, fetched, records, events, leases, proxy }
}

const chat = (over: Record<string, unknown> = {}) => ({ model: 'Alpha', messages: [{ role: 'user', content: 'what is new?' }], ...over })
const settled = async (r: RequestRecord[], n = 1) => { for (let i = 0; i < 100 && r.length < n; i++) await new Promise(x => setTimeout(x, 10)) }
const namesOf = (body: any) => (body.tools ?? []).map((x: any) => x.function.name)

describe('local model (buffered)', () => {
  test('the tool is added, the search runs in the gateway, the model continues with the results; usage is summed', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'news today' }), () => answer('here [1]')] })
    const res = await s.post(chat())
    const body = await res.json() as any
    expect(body.choices[0].message.content).toBe('here [1]')
    expect(body.usage).toEqual({ prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 })
    expect(s.queries).toEqual(['news today'])
    expect(namesOf(s.srv.seen[0].body)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    const second = s.srv.seen[1].body.messages
    expect(second[1]).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: WEB_TOOL_NAME } }] })
    expect(second[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(second[2].content).toContain('Result One')
    expect(second[2].content).toContain('https://example.com/a')
    expect(second[2].content).toContain('DuckDuckGo') // the model can say what it searched with
    expect(s.leases.released).toBe(1)
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ outcome: 'ok', webSearch: { searches: 1, backends: ['duckduckgo'] } })
    expect(s.records[0]!.knowledge ?? null).toBeNull()
    expect(JSON.stringify(s.records[0])).not.toContain('news today')
  })

  test('the global switch off: nothing is added and the request is forwarded as it came', async () => {
    const s = setup({ rounds: [() => answer('plain')], enabled: false })
    await s.post(chat())
    expect(s.srv.seen[0].body).toEqual(chat())
    await settled(s.records)
    expect(s.records[0]?.webSearch ?? null).toBeNull()
  })

  test('a proxy without the dependency does nothing', async () => {
    const s = setup({ rounds: [() => answer('plain')], noWebDeps: true })
    await s.post(chat())
    expect(s.srv.seen[0].body).toEqual(chat())
  })

  test('a client that has its own web_search keeps it: nothing is added, its call goes to the client', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'x' })] })
    const mine = [{ type: 'function', function: { name: WEB_TOOL_NAME, parameters: {} } }]
    const res = await s.post(chat({ tools: mine }))
    expect(s.srv.seen[0].body.tools).toEqual(mine)
    expect(s.queries).toEqual([])
    expect((await res.json() as any).choices[0].finish_reason).toBe('tool_calls')
  })

  test('other client tools stay; a turn that mixes ours with the client\'s goes to the client with ours cut out', async () => {
    const mixed = () => Response.json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: WEB_TOOL_NAME, arguments: '{"query":"x"}' } },
      { id: 'b', type: 'function', function: { name: 'client_tool', arguments: '{}' } },
    ] } }] })
    const s = setup({ rounds: [mixed] })
    const res = await s.post(chat({ tools: [{ type: 'function', function: { name: 'client_tool', parameters: {} } }] }))
    expect(namesOf(s.srv.seen[0].body)).toEqual(['client_tool', WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(s.queries).toEqual([])
    const msg = (await res.json() as any).choices[0]
    expect(msg.message.tool_calls.map((c: any) => c.function.name)).toEqual(['client_tool'])
    expect(msg.finish_reason).toBe('tool_calls')
  })

  test('bad arguments and a failing search become text for the model, never an error', async () => {
    const bad = () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: WEB_TOOL_NAME, arguments: '{oops' } }] } }] })
    const a = setup({ rounds: [bad, () => answer('ok')] })
    expect((await a.post(chat())).status).toBe(200)
    expect(a.srv.seen[1].body.messages[2].content).toBe(t.webPrompt.invalidArguments)

    const b = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'x' }), () => answer('no search')], searchFails: 'all' })
    expect((await b.post(chat())).status).toBe(200)
    expect(b.srv.seen[1].body.messages[2].content).toBe(t.webPrompt.searchFailed)
    expect(b.events).toEqual([]) // all backends failing is expected weather, not a server error

    const c = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'x' }), () => answer('no search')], searchFails: 'other' })
    expect((await c.post(chat())).status).toBe(200)
    expect(c.events.map(e => e.type)).toEqual(['web-search-error'])
  })

  test('search, read, read again: the cap is MAX_WEB_ROUNDS, after it the tools are taken out so the model has to answer', async () => {
    const rounds = Array.from({ length: MAX_WEB_ROUNDS }, (_, i) => () => callOf(WEB_TOOL_NAME, { query: `q${i}` }, `c${i}`))
    const s = setup({ rounds: [...rounds, () => answer('final')] })
    const res = await s.post(chat())
    expect((await res.json() as any).choices[0].message.content).toBe('final')
    expect(s.queries).toHaveLength(MAX_WEB_ROUNDS)
    expect(namesOf(s.srv.seen[MAX_WEB_ROUNDS - 1].body)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect('tools' in s.srv.seen[MAX_WEB_ROUNDS].body).toBe(false)
  })

  test('a model that still calls our tool after the cap is told the limit was reached, it is never handed to the client', async () => {
    const rounds = Array.from({ length: MAX_WEB_ROUNDS }, (_, i) => () => callOf(FETCH_TOOL_NAME, { url: `https://example.com/${i}` }, `c${i}`))
    const s = setup({ rounds: [...rounds, () => callOf(FETCH_TOOL_NAME, { url: 'https://example.com/late' }, 'late'), () => answer('after the limit')] })
    const res = await s.post(chat())
    const body = await res.json() as any
    expect(body.choices[0].message.content).toBe('after the limit')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(s.fetched).toHaveLength(MAX_WEB_ROUNDS) // the late call was not run
    const last = s.srv.seen[s.srv.seen.length - 1].body
    expect(last.messages[last.messages.length - 1]).toMatchObject({ role: 'tool', tool_call_id: 'late', content: t.webPrompt.limitReached })
    expect('tools' in last).toBe(false)
  })

  test('a model that keeps calling after the limit text is closed as plain text, not passed to the client', async () => {
    const late = (i: number) => () => callOf(FETCH_TOOL_NAME, { url: `https://example.com/late${i}` }, `late${i}`)
    const rounds = Array.from({ length: MAX_WEB_ROUNDS }, (_, i) => () => callOf(FETCH_TOOL_NAME, { url: `https://example.com/${i}` }, `c${i}`))
    const s = setup({ rounds: [...rounds, late(1), late(2), late(3)] })
    const res = await s.post(chat())
    const body = await res.json() as any
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].message.content).toBe(t.webPrompt.limitReached)
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBeGreaterThan(0)
    expect(s.fetched).toHaveLength(MAX_WEB_ROUNDS)
  })

  test('other paths and non-chat bodies are left alone', async () => {
    const s = setup({ rounds: [() => answer('x')] })
    await s.proxy.handleV1(new Request('http://localhost/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Alpha', input: 'x' }) }))
    expect(s.srv.seen[0].body).toEqual({ model: 'Alpha', input: 'x' })
  })
})

describe('fetch_url', () => {
  test('is offered with web_search; the call reads the page in the gateway and the model continues with its text', async () => {
    const s = setup({ rounds: [() => callOf(FETCH_TOOL_NAME, { url: 'https://example.com/post' }), () => answer('read it')] })
    const res = await s.post(chat())
    expect((await res.json() as any).choices[0].message.content).toBe('read it')
    expect(s.fetched).toEqual(['https://example.com/post'])
    expect(s.queries).toEqual([])
    const tool = s.srv.seen[1].body.messages[2]
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(tool.content).toBe('A Page\nhttps://example.com/post\n\npage body text')
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ webSearch: { searches: 0, fetches: 1 } })
    expect(JSON.stringify(s.records[0])).not.toContain('example.com/post')
  })

  test('a failed read and bad arguments become text for the model, never an error', async () => {
    const a = setup({ rounds: [() => callOf(FETCH_TOOL_NAME, { url: 'https://example.com/x' }), () => answer('ok')], fetchFails: true })
    expect((await a.post(chat())).status).toBe(200)
    expect(a.srv.seen[1].body.messages[2].content).toBe(fetchFailureText(new PageFetchError('http', '404')))
    const b = setup({ rounds: [() => callOf(FETCH_TOOL_NAME, { nope: 1 }), () => answer('ok')] })
    await b.post(chat())
    expect(b.srv.seen[1].body.messages[2].content).toBe(t.webPrompt.invalidFetchArguments)
    expect(b.fetched).toEqual([])
  })

  test('a client with its own fetch_url keeps it; ours is not added, web_search still is', async () => {
    const s = setup({ rounds: [() => answer('plain')] })
    await s.post(chat({ tools: [{ type: 'function', function: { name: FETCH_TOOL_NAME, parameters: {} } }] }))
    expect(namesOf(s.srv.seen[0].body)).toEqual([FETCH_TOOL_NAME, WEB_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(s.srv.seen[0].body.tools[0].function.parameters).toEqual({})
  })

  test('web_search and fetch_url calls of one turn are both answered by the gateway', async () => {
    const both = () => Response.json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: WEB_TOOL_NAME, arguments: '{"query":"q"}' } },
      { id: 'b', type: 'function', function: { name: FETCH_TOOL_NAME, arguments: '{"url":"https://example.com/p"}' } },
    ] } }] })
    const s = setup({ rounds: [both, () => answer('done')] })
    expect((await s.post(chat())).status).toBe(200)
    expect(s.queries).toEqual(['q'])
    expect(s.fetched).toEqual(['https://example.com/p'])
    expect(s.srv.seen[1].body.messages.filter((m: any) => m.role === 'tool')).toHaveLength(2)
  })
})

describe('page reading', () => {
  const page = (html: string, init: ResponseInit = {}) => (async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })) as unknown as typeof fetch
  const sig = new AbortController().signal

  test('htmlToText drops scripts, styles and chrome, keeps block structure and decodes entities', () => {
    const { title, text } = htmlToText('<html><head><title>My &amp; Page</title><style>p{}</style></head><body><nav>menu</nav><script>x()</script><h1>Head</h1><p>One <b>two</b> &lt;3</p><ul><li>a</li><li>b</li></ul><footer>foot</footer></body></html>')
    expect(title).toBe('My & Page')
    expect(text).toBe('Head\nOne two <3\na\nb')
  })

  test('fetchPage reads and cuts the text; the final address is reported', async () => {
    const long = `<p>${'x'.repeat(2000)}</p>`
    const r = await fetchPage('https://example.com/a', { maxChars: 500, signal: sig, fetchImpl: page(`<title>T</title>${long}`) })
    expect(r).toMatchObject({ title: 'T', truncated: true })
    expect(r.text).toHaveLength(500)
    expect(formatPage(r).endsWith('\n…')).toBe(true)
    const plain = await fetchPage('https://example.com/a.txt', { maxChars: 500, signal: sig, fetchImpl: (async () => new Response('just text', { headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch })
    expect(plain).toMatchObject({ text: 'just text', truncated: false })
  })

  test('failures are typed: bad address, HTTP status, binary content, network', async () => {
    const kind = async (url: string, f: typeof fetch) => { try { await fetchPage(url, { maxChars: 500, signal: sig, fetchImpl: f }) } catch (e) { return (e as PageFetchError).kind } return 'none' }
    expect(await kind('not a url', page(''))).toBe('bad-url')
    expect(await kind('file:///etc/passwd', page(''))).toBe('bad-url')
    expect(await kind('https://example.com/', page('x', { status: 404 }))).toBe('http')
    expect(await kind('https://example.com/', (async () => new Response('x', { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch)).toBe('type')
    expect(await kind('https://example.com/', (async () => { throw new Error('refused') }) as unknown as typeof fetch)).toBe('network')
  })

  test('the caller leaving rethrows its reason', async () => {
    const ac = new AbortController()
    const hang = ((_u: any, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch
    const p = fetchPage('https://example.com/', { maxChars: 500, signal: ac.signal, fetchImpl: hang })
    setTimeout(() => ac.abort(new Error('client gone')), 10)
    await expect(p).rejects.toThrow('client gone')
  })

  test('arguments: url required, max_chars clamped', () => {
    expect(parseFetchArguments('{"url":" https://a.example/ "}')).toEqual({ url: 'https://a.example/', maxChars: 8000 })
    expect(parseFetchArguments('{"url":"u","max_chars":999999}')).toEqual({ url: 'u', maxChars: 30000 })
    expect(parseFetchArguments('{"url":"u","max_chars":1}')).toEqual({ url: 'u', maxChars: 500 })
    for (const bad of ['{oops', '[]', '{}', '{"url":" "}', '{"url":5}']) expect(parseFetchArguments(bad)).toBeNull()
  })
})

describe('usage guide', () => {
  const read = () => callOf(GUIDE_TOOL_NAME, {})
  const toolTexts = (body: any) => body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)

  test('the guide tool returns the default text; a custom text replaces it; empty / blank means the default', async () => {
    const a = setup({ rounds: [read, () => answer('ok')] })
    await a.post(chat())
    expect(toolTexts(a.srv.seen[1].body)).toEqual([t.webPrompt.defaultGuide])
    const b = setup({ rounds: [read, () => answer('ok')], guide: { custom: 'MY RULES' } })
    await b.post(chat())
    expect(toolTexts(b.srv.seen[1].body)).toEqual(['MY RULES'])
    expect(guideText('   ')).toBe(t.webPrompt.defaultGuide)
  })

  test('the default guide is the router-derived one: when to search, how, checking, citing, data not instructions', () => {
    for (const part of ['fetch_url', '3', '官方', '来源链接', '指令']) expect(t.webPrompt.defaultGuide).toContain(part)
  })

  test('required: the descriptions point to the guide; not required: they do not', () => {
    expect(webToolDefinition({ needsGuide: true }).function.description).toBe(t.webPrompt.toolDescription + t.webPrompt.useGuide)
    expect(fetchToolDefinition(true).function.description).toBe(t.webPrompt.fetchDescription + t.webPrompt.useGuide)
    expect(webToolDefinition().function.description).toBe(t.webPrompt.toolDescription)
  })

  test('required: a search before the guide is read is not run; the model is told to read it, then it works', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'too early' }), read, () => callOf(WEB_TOOL_NAME, { query: 'now' }, 'call_2'), () => answer('done')], guide: { required: true } })
    const res = await s.post(chat())
    expect((await res.json() as any).choices[0].message.content).toBe('done')
    expect(s.queries).toEqual(['now'])
    expect(s.srv.seen[0].body.tools[0].function.description).toContain(t.webPrompt.useGuide)
    expect(toolTexts(s.srv.seen[1].body)).toEqual([t.webPrompt.guideFirst])
    expect(toolTexts(s.srv.seen[3].body)[2]).toContain('Result One')
  })

  test('required: fetch_url is held back the same way', async () => {
    const s = setup({ rounds: [() => callOf(FETCH_TOOL_NAME, { url: 'https://example.com/p' }), () => answer('ok')], guide: { required: true } })
    await s.post(chat())
    expect(s.fetched).toEqual([])
    expect(toolTexts(s.srv.seen[1].body)).toEqual([t.webPrompt.guideFirst])
  })

  test('not required: the tools work without reading the guide', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'direct' }), () => answer('ok')] })
    await s.post(chat())
    expect(s.queries).toEqual(['direct'])
  })

  test('the round that only reads the guide does not use up the rounds', async () => {
    const searches = Array.from({ length: MAX_WEB_ROUNDS }, (_, i) => () => callOf(WEB_TOOL_NAME, { query: `q${i}` }, `c${i}`))
    const s = setup({ guide: { required: true }, rounds: [read, ...searches, () => answer('final')] })
    const res = await s.post(chat())
    expect((await res.json() as any).choices[0].message.content).toBe('final')
    expect(s.queries).toHaveLength(MAX_WEB_ROUNDS)
    expect(namesOf(s.srv.seen[MAX_WEB_ROUNDS].body)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME]) // still offered for the last search
    expect('tools' in s.srv.seen[MAX_WEB_ROUNDS + 1].body).toBe(false)
  })

  test('only the first guide round is free: reading it over and over still runs out the cap', async () => {
    const reads = Array.from({ length: MAX_WEB_ROUNDS + 1 }, () => read)
    const s = setup({ guide: { required: true }, rounds: [...reads, () => answer('end')] })
    await s.post(chat())
    // The first read was free, the others count: the tools are still there for the request after MAX_WEB_ROUNDS reads and gone after one more.
    expect(namesOf(s.srv.seen[MAX_WEB_ROUNDS].body)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect('tools' in s.srv.seen[MAX_WEB_ROUNDS + 1].body).toBe(false)
    expect(s.srv.seen).toHaveLength(MAX_WEB_ROUNDS + 2)
  })

  test('streaming: the guide read and the search happen inside one stream', async () => {
    const s = setup({ guide: { required: true }, rounds: [() => streamCall(GUIDE_TOOL_NAME, {}), () => streamCall(WEB_TOOL_NAME, { query: 'sq' }), () => streamAnswer('streamed')] })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text).toContain('streamed')
    expect(text).not.toContain('tool_calls')
    expect(s.queries).toEqual(['sq'])
    expect(text.match(/\[DONE\]/g)).toHaveLength(1)
  })

  test('a client with its own web_search_guide keeps it; ours is not added', async () => {
    const s = setup({ rounds: [() => answer('plain')] })
    await s.post(chat({ tools: [{ type: 'function', function: { name: GUIDE_TOOL_NAME, parameters: {} } }] }))
    expect(namesOf(s.srv.seen[0].body)).toEqual([GUIDE_TOOL_NAME, WEB_TOOL_NAME, FETCH_TOOL_NAME])
  })
})

describe('naming a paid backend', () => {
  const guideRead = () => callOf(GUIDE_TOOL_NAME, {})
  const toolTexts = (body: any) => body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  const named = (backend: string, id = 'call_1') => callOf(WEB_TOOL_NAME, { query: 'q', backend }, id)

  test('the definition lists the available backends with free / paid and offers them as the backend enum', async () => {
    const s = setup({ rounds: [() => answer('x')] })
    await s.post(chat())
    const d = s.srv.seen[0].body.tools[0].function
    expect(d.description).toContain('可用后端：DuckDuckGo（免费）、Bing（免费）、Tavily（付费）')
    expect(d.description).toContain(t.webPrompt.autoFree)
    expect(d.parameters.properties.backend.enum).toEqual(['duckduckgo', 'bing', 'tavily'])
  })

  test('without a backend the gateway search is called with no `only` (it decides)', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'q' }), () => answer('x')] })
    await s.post(chat())
    expect(s.onlies).toEqual([undefined])
  })

  test('a paid backend named before the guide was read is not run, even when the guide is not required; the model is told to read it', async () => {
    const s = setup({ rounds: [() => named('tavily'), () => answer('x')] }) // guide.required = false in this harness
    await s.post(chat())
    expect(s.queries).toEqual([])
    expect(toolTexts(s.srv.seen[1].body)).toEqual([t.webPrompt.guideFirst])
  })

  test('after the guide is read the paid search runs on that backend; the result says paid; the record counts it', async () => {
    const s = setup({ rounds: [() => named('tavily'), guideRead, () => named('tavily', 'call_3'), () => answer('x')] })
    await s.post(chat())
    expect(s.queries).toEqual(['q'])
    expect(s.onlies).toEqual(['tavily'])
    const last = toolTexts(s.srv.seen[3].body)
    expect(last[2]).toContain('搜索后端：Tavily（付费）')
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ webSearch: { searches: 1, paid: 1, backends: ['tavily'] } })
  })

  test('a free backend can be named without reading the guide (when the guide is not required); it is not counted as paid', async () => {
    const s = setup({ rounds: [() => named('bing'), () => answer('x')] })
    await s.post(chat())
    expect(s.onlies).toEqual(['bing'])
    expect(toolTexts(s.srv.seen[1].body)[0]).toContain('搜索后端：Bing（免费）')
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ webSearch: { searches: 1, paid: 0 } })
  })

  test('a name that was not offered gets the list of the available ones, and no search runs', async () => {
    const s = setup({ rounds: [() => named('google'), () => answer('x')] })
    await s.post(chat())
    expect(s.queries).toEqual([])
    expect(toolTexts(s.srv.seen[1].body)).toEqual(['没有这个后端：可用后端是 DuckDuckGo（免费）、Bing（免费）、Tavily（付费）。'])
  })

  test('a backend with no key is not offered: the paid names are gone from the enum', async () => {
    const s = setup({ rounds: [() => answer('x')], backends: [{ id: 'duckduckgo', paid: false }, { id: 'bing', paid: false }] })
    await s.post(chat())
    expect(s.srv.seen[0].body.tools[0].function.parameters.properties.backend.enum).toEqual(['duckduckgo', 'bing'])
    expect(s.srv.seen[0].body.tools[0].function.description).not.toContain('付费')
  })

  test('a client that has its own web_search_guide cannot be made to read ours: no paid backend is offered', async () => {
    const s = setup({ rounds: [() => answer('x')] })
    await s.post(chat({ tools: [{ type: 'function', function: { name: GUIDE_TOOL_NAME, parameters: {} } }] }))
    expect(s.srv.seen[0].body.tools.find((x: any) => x.function.name === WEB_TOOL_NAME).function.parameters.properties.backend.enum).toEqual(['duckduckgo', 'bing'])
  })

  test('autoPaid (order is not free-only): the description says the gateway chooses', async () => {
    const s = setup({ rounds: [() => answer('x')], autoPaid: true })
    await s.post(chat())
    expect(s.srv.seen[0].body.tools[0].function.description).toContain(t.webPrompt.autoMixed)
  })

  test('a named backend that returns nothing says which one, and does not fall back to another', async () => {
    const s = setup({ rounds: [() => named('tavily'), guideRead, () => named('tavily', 'call_3'), () => answer('x')], searchFails: 'all' })
    await s.post(chat())
    expect(toolTexts(s.srv.seen[3].body)[2]).toBe('指定的后端 Tavily（付费） 没有返回结果，或暂时不可用。')
  })
})

describe('local model (streaming)', () => {
  test('one stream with the content of both rounds, none of our tool-call events, one [DONE]', async () => {
    const s = setup({ rounds: [() => streamCall(WEB_TOOL_NAME, { query: 'stream q' }), () => streamAnswer('streamed answer')] })
    const res = await s.post(chat({ stream: true }))
    const text = await res.text()
    expect(text).toContain('streamed answer')
    expect(text).not.toContain('tool_calls')
    expect(text.match(/\[DONE\]/g)).toHaveLength(1)
    expect(s.queries).toEqual(['stream q'])
    expect(s.srv.seen[1].body.messages[2].content).toContain('Result One')
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ outcome: 'ok', webSearch: { searches: 1, backends: ['duckduckgo'] } })
    expect(s.leases.released).toBe(1)
  })
})

describe('local model (streaming): our calls never reach the client', () => {
  const streamMixed = () => sseResponse([
    sse({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: FETCH_TOOL_NAME, arguments: '{"url":"https://example.com/p"}' } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'save_memory', arguments: '{"text":"x"}' } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    'data: [DONE]\n\n',
  ])
  const events = (text: string) => text.split('\n\n').map(e => e.split('\n').find(l => l.startsWith('data:'))).filter((l): l is string => !!l).map(l => l.slice(5).trim())

  test('a turn with our call and the client\'s: the client gets only its own, with the finish reason and the usage', async () => {
    const s = setup({ rounds: [streamMixed] })
    const text = await (await s.post(chat({ stream: true, tools: [{ type: 'function', function: { name: 'save_memory', parameters: {} } }] }))).text()
    expect(s.fetched).toEqual([])
    expect(text).not.toContain(FETCH_TOOL_NAME)
    expect(text).toContain('save_memory')
    const data = events(text)
    expect(data[data.length - 1]).toBe('[DONE]')
    expect(data.filter(d => d === '[DONE]')).toHaveLength(1)
    const parsed = data.filter(d => d !== '[DONE]').map(d => JSON.parse(d))
    expect(parsed.some(o => o.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true)
    expect(parsed.find(o => o.usage)?.usage).toMatchObject({ total_tokens: 15 })
    expect(parsed.find(o => o.choices?.[0]?.delta?.tool_calls).choices[0].delta.tool_calls).toEqual([
      { index: 0, id: 'b', type: 'function', function: { name: 'save_memory', arguments: '{"text":"x"}' } },
    ])
  })

  test('past the cap a late call of ours is answered with the limit text; the stream ends with the real answer', async () => {
    const rounds = Array.from({ length: MAX_WEB_ROUNDS }, (_, i) => () => streamCall(FETCH_TOOL_NAME, { url: `https://example.com/${i}` }))
    const s = setup({ rounds: [...rounds, () => streamCall(FETCH_TOOL_NAME, { url: 'https://example.com/late' }), () => streamAnswer('ended well')] })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text).toContain('ended well')
    expect(text).not.toContain('tool_calls')
    expect(s.fetched).toHaveLength(MAX_WEB_ROUNDS)
    expect(text.match(/\[DONE\]/g)).toHaveLength(1)
  })

  test('a model that never stops calling: the stream is closed with the limit text as content, no call, finish stop', async () => {
    const calls = Array.from({ length: MAX_WEB_ROUNDS + 3 }, (_, i) => () => streamCall(FETCH_TOOL_NAME, { url: `https://example.com/${i}` }))
    const s = setup({ rounds: calls })
    const text = await (await s.post(chat({ stream: true }))).text()
    expect(text).not.toContain('"tool_calls"')
    expect(text).toContain(t.webPrompt.limitReached.slice(0, 8))
    const parsed = events(text).filter(d => d !== '[DONE]').map(d => JSON.parse(d))
    expect(parsed.some(o => o.choices?.[0]?.finish_reason === 'stop')).toBe(true)
    expect(s.fetched).toHaveLength(MAX_WEB_ROUNDS)
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ outcome: 'ok' })
    expect(s.leases.released).toBe(1)
  })
})

describe('external upstream', () => {
  test('on by default: the loop runs without a lease and with the upstream key', async () => {
    const s = setup({ rounds: [() => callOf(WEB_TOOL_NAME, { query: 'up' }), () => answer('from upstream')] })
    const res = await s.post(chat({ model: 'Strata-qwen-x' }))
    expect((await res.json() as any).choices[0].message.content).toBe('from upstream')
    expect(s.queries).toEqual(['up'])
    expect(s.srv.seen[0].body.model).toBe('qwen-x')
    expect(namesOf(s.srv.seen[0].body)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(s.leases.released).toBe(0)
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ modelId: expect.stringMatching(/^upstream:/), webSearch: { searches: 1 } })
  })

  test('its own switch off: nothing is added even though the global switch is on', async () => {
    const s = setup({ rounds: [() => answer('plain')], upstreamSwitch: false })
    await s.post(chat({ model: 'Strata-qwen-x' }))
    expect(namesOf(s.srv.seen[0].body)).toEqual([])
    expect(s.queries).toEqual([])
  })

  test('the global switch off wins over an upstream that has it on', async () => {
    const s = setup({ rounds: [() => answer('plain')], enabled: false })
    await s.post(chat({ model: 'Strata-qwen-x' }))
    expect(namesOf(s.srv.seen[0].body)).toEqual([])
  })
})

describe('together with the knowledge tool', () => {
  test('both tools are offered; each call is answered by its own search; the record has both summaries', async () => {
    const s = setup({
      withKnowledge: true,
      rounds: [() => callOf('search_knowledge', { query: 'kb q' }), () => callOf(WEB_TOOL_NAME, { query: 'web q' }, 'call_2'), () => answer('both')],
    })
    const res = await s.post(chat())
    expect((await res.json() as any).choices[0].message.content).toBe('both')
    expect(namesOf(s.srv.seen[0].body)).toEqual(['search_knowledge', WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
    expect(s.queries).toEqual(['web q'])
    const last = s.srv.seen[2].body.messages
    expect(last.filter((m: any) => m.role === 'tool').map((m: any) => m.content.includes('kb text'))).toEqual([true, false])
    await settled(s.records)
    expect(s.records[0]).toMatchObject({ knowledge: { mode: 'tool', hits: 1, rounds: 2 }, webSearch: { searches: 1, backends: ['duckduckgo'] } })
    expect('tools' in s.srv.seen[2].body).toBe(true)
  })

  test('knowledge in inject mode and web search can both apply to one request', async () => {
    const s = setup({ rounds: [() => answer('x')], withKnowledge: true })
    await s.post(chat({ knowledge: { mode: 'inject' } }))
    const sent = s.srv.seen[0].body
    expect(sent.messages[0].role).toBe('system')
    expect(namesOf(sent)).toEqual([WEB_TOOL_NAME, FETCH_TOOL_NAME, GUIDE_TOOL_NAME])
  })
})
