import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultModels, defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION } from '../../server/core/config'
import { applySettingsPatch } from '../../server/core/settings-admin'
import { DEFAULT_NETWORK, envProxy, macProxy, NetworkAccess, normalizeProxyUrl, officialFirst, windowsProxy, type NetworkSettings } from '../../server/core/net'
import { cleanupParts, download, getBody, type ReleaseAsset } from '../../server/core/llamacpp'
import { MIRRORS } from '../../server/core/mirrors'
import { resolveCloudflared } from '../../server/core/tunnel'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-net-')) })
afterEach(() => rmSync(dir, { force: true, recursive: true }))
const sha = (data: string) => createHash('sha256').update(data).digest('hex')
const url = 'https://github.com/example/project/releases/download/b1234/build.zip'
const asset = (data = 'abcdefghij'): ReleaseAsset => ({ name: 'build.zip', browser_download_url: url, size: data.length, digest: `sha256:${sha(data)}` })
const identity = (a: ReleaseAsset) => JSON.stringify({ sha256: a.digest!.slice(7), size: a.size ?? null, name: a.name })
function seed(a = asset(), contents = 'abc') {
  const file = join(dir, a.name)
  writeFileSync(`${file}.part`, contents)
  writeFileSync(`${file}.part.json`, identity(a))
  return file
}
const config = (downloadSource: NetworkSettings['downloadSource'] = 'ask'): NetworkSettings => ({ proxy: { mode: 'off', url: '' }, downloadSource, mirror: '' })

test('v12 -> v13 fills only missing defaults and preserves explicit network settings', () => {
  const old: any = { version: 12, llamacpp: { current: 'custom:r1' }, mirror: { custom: 'https://mirror.example.com/' } }
  const migrated = SETTINGS_MIGRATIONS[12]!(structuredClone(old))
  expect(migrated).toEqual({ ...old, network: DEFAULT_NETWORK })
  expect(SETTINGS_VERSION).toBe(13)
  const saved = { ...old, network: { proxy: { mode: 'off', url: '' }, downloadSource: 'mirror', mirror: 'gh-proxy' } }
  expect(SETTINGS_MIGRATIONS[12]!(structuredClone(saved))).toEqual(saved)
  expect(normalizeSettings(migrated).llamacpp.current).toBe('custom:r1')
})

test('proxy parsers: environment precedence, static Windows forms, scutil HTTPS and HTTP fallback; PAC is ignored', () => {
  expect(envProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7891' })).toBe('http://127.0.0.1:7890/')
  expect(envProxy({ ALL_PROXY: 'https://proxy.example.com:443' })).toBe('https://proxy.example.com/')
  expect(envProxy({ https_proxy: 'http://127.0.0.1:7890' })).toBe('http://127.0.0.1:7890/')
  expect(windowsProxy('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    127.0.0.1:7890')).toBe('http://127.0.0.1:7890/')
  const reg = ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ http=127.0.0.1:7891;https=127.0.0.1:7892;socks=127.0.0.1:7893'
  expect(windowsProxy(reg)).toBe('http://127.0.0.1:7892/')
  expect(windowsProxy(reg, false)).toBe('http://127.0.0.1:7891/')
  expect(windowsProxy(reg.replace('0x1', '0x0'))).toBeNull()
  expect(windowsProxy('AutoConfigURL REG_SZ https://example.com/proxy.pac')).toBeNull()
  const mac = '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7890\n HTTPEnable : 1\n HTTPProxy : proxy.example.com\n HTTPPort : 8080\n}'
  expect(macProxy(mac)).toBe('http://127.0.0.1:7890/')
  expect(macProxy(mac.replace('HTTPSEnable : 1', 'HTTPSEnable : 0'))).toBe('http://proxy.example.com:8080/')
  expect(macProxy('ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : https://example.com/pac')).toBeNull()
})

test('manual proxy rejects SOCKS, malformed URLs and unsafe input without echoing credentials', () => {
  const cfg = defaultSettings()
  for (const value of ['', 'socks5://127.0.0.1:1080', 'file:///tmp/proxy', 'http://proxy.example.com/path', 'http://a:99999', 'http://a/#x', 'http://a/?q=secret', 'http://u:password@']) {
    expect(normalizeProxyUrl(value)).toBeNull()
    try { applySettingsPatch(cfg, { network: { proxy: { mode: 'manual', url: value } } }, defaultModels()); throw new Error('accepted') }
    catch (e) { expect((e as Error).message).toBe('bad-proxy') }
  }
  applySettingsPatch(cfg, { network: { proxy: { mode: 'manual', url: 'http://u:password@127.0.0.1:7890' }, downloadSource: 'auto' } }, defaultModels())
  expect(cfg.network.proxy.url).toBe('http://u:password@127.0.0.1:7890/')
})

test('proxy is limited to management hosts, bypasses loopback, respects off and redacts native errors', async () => {
  const settings = config()
  settings.proxy = { mode: 'manual', url: 'http://u:password@127.0.0.1:7890' }
  const seen: Array<[string, string]> = []
  const access = new NetworkAccess({ settings: () => settings, fetch: async (url, init) => {
    seen.push([url, (init as RequestInit & { proxy: string }).proxy]); return new Response('ok')
  } })
  for (const target of ['https://api.github.com/x', 'https://ghfast.top/x', 'https://api.cloudflare.com/x', 'http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'https://upstream.example.com/v1']) await access.direct(target)
  expect(seen.map(x => x[1])).toEqual([settings.proxy.url + '/', settings.proxy.url + '/', settings.proxy.url + '/', '', '', '', ''])
  settings.proxy.mode = 'off'
  await access.direct('https://api.github.com/x')
  expect(seen.at(-1)![1]).toBe('')
  const bad = new NetworkAccess({ settings: () => settings, fetch: async () => { throw new Error('http://u:password@127.0.0.1:7890') } })
  await expect(getBody(bad.direct, 'https://api.github.com/x', 'text')).rejects.toMatchObject({ detail: 'Request failed or timed out' })
})

test('system proxy cache expires at 60s; env takes precedence and no OS query is made', async () => {
  let now = 0, runs = 0
  const values: unknown[] = []
  const access = new NetworkAccess({ settings: () => ({ ...config(), proxy: { mode: 'system', url: '' } }), platform: 'win32', env: {}, now: () => now,
    run: async (exe, args) => { runs++; expect(exe).toBe('reg'); expect(args).toEqual(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']); return 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7890' },
    fetch: async (_u, init) => { values.push((init as any).proxy); return new Response('ok') },
  })
  await Promise.all([access.direct(url), access.direct(url)])
  expect(runs).toBe(1)
  now = 60_001; await access.direct(url)
  expect(runs).toBe(2)
  expect(values).toEqual(Array(3).fill('http://127.0.0.1:7890/'))
  const env = new NetworkAccess({ settings: () => ({ ...config(), proxy: { mode: 'system', url: '' } }), platform: 'darwin', env: { HTTPS_PROXY: 'http://127.0.0.1:7899' }, run: async () => { throw new Error('must not query') }, fetch: async (_u, init) => { expect((init as any).proxy).toBe('http://127.0.0.1:7899/'); return new Response('ok') } })
  await env.direct(url)
})

test('auto falls back after direct failure; mirror mode uses selected mirror then other mirrors then direct; ask stays one action', async () => {
  const cfg = config('auto'), seen: string[] = []
  const access = new NetworkAccess({ settings: () => cfg, fetch: async (u, init) => {
    if (new Headers(init?.headers).has('range')) return new Response('x')
    seen.push(u)
    if (u === url) throw new Error('offline')
    return new Response('mirror')
  } })
  expect(await (await access.source()(url)).text()).toBe('mirror')
  expect(seen[0]).toBe(url)
  expect(MIRRORS.some(m => seen[1]!.startsWith(m.base))).toBe(true)
  cfg.downloadSource = 'ask'; seen.length = 0
  await expect(access.source()(url)).rejects.toThrow()
  expect(await (await access.source('gh-proxy')(url)).text()).toBe('mirror')
  expect(seen.at(-1)).toContain('https://gh-proxy.com/')
  seen.length = 0
  cfg.downloadSource = 'mirror'; cfg.mirror = 'gh-proxy'
  const mirrorFail = new NetworkAccess({ settings: () => cfg, fetch: async (u, init) => {
    if (new Headers(init?.headers).has('range')) return new Response('x')
    seen.push(u); return u === url ? new Response('direct') : new Response('', { status: 503 })
  } })
  expect(await (await mirrorFail.source()(url)).text()).toBe('direct')
  expect(seen[0]).toContain('gh-proxy.com')
  expect(seen.at(-1)).toBe(url)
})

test('mirror probes are concurrent, ordered by successful latency, cached 10min and bounded when a fetch ignores abort', async () => {
  let starts = 0, now = 0
  const access = new NetworkAccess({ settings: () => config('auto'), now: () => now, probeMs: 100, fetch: async u => {
    starts++
    const index = MIRRORS.findIndex(m => u.startsWith(m.base))
    await new Promise(resolve => setTimeout(resolve, [60, 10, 30][index]))
    now += [60, 10, 30][index]!
    return new Response('x')
  } })
  expect((await access.orderedMirrors(url)).map(x => x.id)).toEqual(['gh-proxy', 'ghproxy-net', 'ghfast'])
  expect(starts).toBe(3)
  await access.orderedMirrors(url); expect(starts).toBe(3)
  now += 600_001; await access.orderedMirrors(url); expect(starts).toBe(6)
  const stuck = new NetworkAccess({ settings: () => config('auto'), probeMs: 5, fetch: async () => new Promise<Response>(() => {}) })
  expect(await stuck.orderedMirrors(url)).toHaveLength(3)
})

test('official metadata takes precedence even with mirror policy; digestSource records mirror only when official paths fail', async () => {
  for (const direct of [true, false]) {
    const seen: string[] = []
    const access = new NetworkAccess({ settings: () => ({ ...config('mirror'), mirror: 'ghfast' }), fetch: async (u, init) => {
      if (new Headers(init?.headers).has('range')) return new Response('x')
      seen.push(u)
      if (u === url && !direct) throw new Error('offline')
      return new Response(u === url ? 'official' : 'mirrored')
    } })
    const meta = await officialFirst(access.source(), f => getBody(f, url, 'text'))
    expect(meta).toEqual({ value: direct ? 'official' : 'mirrored', digestSource: direct ? 'github' : 'mirror' })
    expect(seen[0]).toBe(url)
  }
})

test('206 resumes the previous part and hashes the complete file, progress includes the offset and disk precheck discounts it', async () => {
  const a = asset(), file = seed(a), progress: number[] = []
  const result = await download(async (_u, init) => {
    expect(new Headers(init?.headers).get('range')).toBe('bytes=3-')
    return new Response('defghij', { status: 206, headers: { 'Content-Range': 'bytes 3-9/10' } })
  }, a, file, { onProgress: n => progress.push(n) }, false, () => 27)
  expect(result).toBe(sha('abcdefghij'))
  expect(readFileSync(file, 'utf8')).toBe('abcdefghij')
  expect(progress[0]).toBe(3); expect(progress.at(-1)).toBe(10)
  expect(existsSync(`${file}.part.json`)).toBe(false)
})

test('200 restarts, a wrong digest discards both part and sidecar, and a changed digest invalidates an earlier part', async () => {
  const a = asset(), file = seed(a)
  await download(async () => new Response('abcdefghij'), a, file)
  expect(readFileSync(file, 'utf8')).toBe('abcdefghij')
  seed(a)
  await expect(download(async () => new Response('xxxxxxxxxx'), a, file)).rejects.toMatchObject({ code: 'digest-mismatch' })
  expect(existsSync(`${file}.part`)).toBe(false)
  expect(existsSync(`${file}.part.json`)).toBe(false)
  const changed = asset('klmnopqrst')
  seed(a)
  await download(async (_u, init) => { expect(new Headers(init?.headers).has('range')).toBe(false); return new Response('klmnopqrst') }, changed, file)
  expect(readFileSync(file, 'utf8')).toBe('klmnopqrst')
})

test('three retries use injected 2s/5s/10s backoff; 404 and cancellation never retry', async () => {
  let calls = 0
  const delays: number[] = []
  const file = join(dir, 'build.zip')
  await expect(download(async () => { calls++; return new Response('', { status: 503 }) }, asset(), file, { sleep: async ms => { delays.push(ms) } })).rejects.toMatchObject({ code: 'http' })
  expect(calls).toBe(4); expect(delays).toEqual([2000, 5000, 10000])
  calls = 0
  await expect(download(async () => { calls++; return new Response('', { status: 404 }) }, asset(), file)).rejects.toMatchObject({ code: 'http' })
  expect(calls).toBe(1)
  const abort = new AbortController()
  await expect(download(async () => { abort.abort(); throw new Error('cancelled') }, asset(), file, { signal: abort.signal, sleep: async () => { throw new Error('must not sleep') } })).rejects.toMatchObject({ code: 'network' })
  expect(existsSync(`${file}.part.json`)).toBe(true)
})

test('a truncated stream retries from the persisted offset and an invalid 206 range cannot corrupt the file', async () => {
  const file = join(dir, 'build.zip')
  let calls = 0
  await download(async (_u, init) => {
    if (++calls === 1) return new Response('abc')
    expect(new Headers(init?.headers).get('range')).toBe('bytes=3-')
    return new Response('defghij', { status: 206, headers: { 'content-range': 'bytes 3-9/10' } })
  }, asset(), file, { sleep: async () => {} })
  expect(calls).toBe(2)
  seed()
  await expect(download(async () => new Response('wrong', { status: 206, headers: { 'content-range': 'bytes 0-4/10' } }), asset(), file)).rejects.toMatchObject({ code: 'http' })
  expect(readFileSync(`${file}.part`, 'utf8')).toBe('abc')
})

test('old parts and orphan sidecars are cleaned; fresh resumable files stay', () => {
  const file = seed()
  const old = join(dir, 'old.zip.part')
  writeFileSync(old, 'x'); writeFileSync(`${old}.json`, '{}')
  utimesSync(old, new Date(0), new Date(0))
  writeFileSync(join(dir, 'orphan.part.json'), '{}')
  cleanupParts(dir)
  expect(existsSync(old)).toBe(false); expect(existsSync(`${old}.json`)).toBe(false)
  expect(existsSync(join(dir, 'orphan.part.json'))).toBe(false)
  expect(existsSync(`${file}.part`)).toBe(true)
})

test('cloudflared metadata goes through the same mirror layer and exposes its digest source', async () => {
  const calls: string[] = []
  const access = new NetworkAccess({ settings: () => config('mirror'), fetch: async (u, init) => {
    calls.push(u)
    if (new Headers(init?.headers).has('range')) return new Response('x')
    if (!u.startsWith('https://ghfast.top/')) throw new Error('offline')
    return Response.json({ assets: [{ name: 'cloudflared-windows-amd64.exe', digest: `sha256:${sha('binary')}`, browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/1/cloudflared-windows-amd64.exe' }] })
  } })
  const a = await resolveCloudflared(access.source(), 'win32', {}, 'x64')
  expect(a.digestSource).toBe('mirror')
  expect(calls.some(u => u.startsWith('https://ghfast.top/https://api.github.com/'))).toBe(true)
})

test('an asset fetched through a mirror is checked against the direct official digest and error status supplies offline links', async () => {
  const { Updater } = await import('../../server/core/updater')
  const name = 'llama-b1234-bin-win-cpu-x64.zip', fileUrl = `https://github.com/ggml-org/llama.cpp/releases/download/b1234/${name}`
  const pointer = 'https://github.com/ggml-org/llama.cpp/releases/latest/download/nightly-tag.txt'
  const network = new NetworkAccess({ settings: () => config('mirror'), fetch: async (u, init) => {
    if (new Headers(init?.headers).get('range') === 'bytes=0-0') return new Response('x')
    if (u.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: pointer }] })
    if (u === pointer) return new Response('b1234')
    if (u.endsWith('/releases/tags/b1234')) return Response.json({ assets: [{ name, browser_download_url: fileUrl, size: 8, digest: `sha256:${sha('ORIGINAL')}` }] })
    if (u.startsWith('https://ghfast.top/')) return new Response('TAMPERED')
    throw new Error('unexpected')
  } })
  const cfg = { current: '', cudaRuntime: '', autoUpdate: false, keepVersions: 2 }
  const updater = new Updater({ dataDir: dir, target: { os: 'win32', arch: 'x64', acceleration: 'cpu' }, network, llamacpp: () => cfg, setCurrent: value => { cfg.current = value }, usedExes: () => [] })
  try {
    const status = await updater.run({ force: true })
    expect(status).toMatchObject({ state: 'error', code: 'digest-mismatch', digestSource: 'github', assets: [{ name, url: fileUrl }] })
    expect(cfg.current).toBe('')
  } finally { await updater.stop() }
})

test('mirror download policies keep the GitHub host allowlist', async () => {
  let calls = 0
  for (const mode of ['auto', 'mirror'] as const) {
    const access = new NetworkAccess({ settings: () => config(mode), fetch: async () => { calls++; return new Response('bad') } })
    await expect(access.source()('http://127.0.0.1/private')).rejects.toThrow('non-GitHub')
    await expect(access.source()('https://evil.example.com/private')).rejects.toThrow('non-GitHub')
  }
  expect(calls).toBe(0)
})

test('all retry endpoints accept remember:true and persist automatic source consent', async () => {
  const globals = globalThis as Record<string | symbol, unknown>, key = Symbol.for('llama-web.context')
  const cfg = defaultSettings(), requests: unknown[] = []
  const updater = { refresh: () => [], versions: () => [], getStatus: () => ({ state: 'idle' }), getUpdateCheck: () => ({ state: 'idle' }), rollbackTarget: () => null, run: async (v: unknown) => { requests.push(v) } }
  const bindings = { defineEventHandler: (f: unknown) => f, readBody: async (e: { body: unknown }) => e.body, createError: (info: unknown) => Object.assign(new Error('API error'), info) }
  const previous = [...Object.keys(bindings).map(k => [k, globals[k]] as const), [key, globals[key]] as const]
  Object.assign(globals, bindings)
  globals[key] = {
    getSettings: () => cfg, updateSettings: (fn: (draft: typeof cfg) => void) => fn(cfg), getSystem: async () => ({}),
    runtimeTarget: { os: 'win32', arch: 'x64', acceleration: 'cpu' }, platform: { os: 'win32', arch: 'x64' }, updater, secondary: null, runtimes: { list: () => ({ rows: [], hiddenOtherPlatform: 0 }) },
    appUpdate: { check: async (v: unknown) => { requests.push(v) }, startDownload: (v: unknown) => { requests.push(v) }, view: () => ({}) },
    tunnel: { retry: (v: unknown) => { requests.push(v) } }, runtimeAdd: { preview: async (v: unknown) => { requests.push(v); return {} } },
  }
  try {
    const routes = [
      (await import('../../server/api/llamacpp/check.post')).default,
      (await import('../../server/api/llamacpp/download.post')).default,
      (await import('../../server/api/app-update/check.post')).default,
      (await import('../../server/api/app-update/download.post')).default,
      (await import('../../server/api/tunnel/retry.post')).default,
      (await import('../../server/api/llamacpp/add/preview.post')).default,
    ]
    for (const route of routes) {
      cfg.network.downloadSource = 'ask'
      await route({ body: { mirror: 'ghfast', remember: true, kind: 'github', url: 'https://github.com/example/fork' } } as never)
      expect(cfg.network.downloadSource).toBe('auto')
    }
    expect(requests).toHaveLength(routes.length)
    expect(requests.every(v => (v as { mirror: string }).mirror === 'ghfast')).toBe(true)
  } finally { for (const [k, v] of previous) { if (v === undefined) delete globals[k]; else globals[k] = v } }
})

test('settings v13 is saved with an unchanged v12 backup by the atomic store migration', async () => {
  const { JsonStore } = await import('../../server/core/store')
  const old: any = defaultSettings()
  old.version = 12; delete old.network
  const bytes = JSON.stringify(old)
  writeFileSync(join(dir, 'settings.json'), bytes)
  const store = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, migrations: SETTINGS_MIGRATIONS, validate: normalizeSettings })
  try {
    expect(store.load().network).toEqual(DEFAULT_NETWORK)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).version).toBe(13)
    const { readdirSync } = await import('node:fs')
    expect(readFileSync(join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]!), 'utf8')).toBe(bytes)
  } finally { store.close() }
})


test('a complete part with no published size is verified locally instead of getting stuck on a 416 response', async () => {
  const a = { ...asset(), size: undefined }
  const file = seed(a, 'abcdefghij')
  let calls = 0
  expect(await download(async () => { calls++; return new Response('', { status: 416 }) }, a, file)).toBe(sha('abcdefghij'))
  expect(calls).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe('abcdefghij')
  expect(existsSync(`${file}.part.json`)).toBe(false)
})
