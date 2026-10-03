import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { isAlive, PidRegistry } from '../../server/core/runner'
import {
  candidatePaths, cloudflaredEnv, cloudflaredPath, ensureQuickConfig, extractToken, ingressHostnames, tunnelIdOf, findCloudflared, maskToken, prepareCloudflared,
  quickConfigPath, quickTunnelHost, redact, releaseAssetName, tunnelArgs, TunnelError, TunnelManager, type PrepareOptions, type TunnelConfig, type TunnelInfo, type TunnelStatus,
} from '../../server/core/tunnel'

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'fake-cloudflared.ts')
const SECRET = 'supersecretvalue1234567890'
const TOKEN = Buffer.from(JSON.stringify({ a: 'acct0123456789', t: '11111111-2222-3333-4444-555555555555', s: SECRET })).toString('base64')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-tunnel-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sha = (b: string) => createHash('sha256').update(b).digest('hex')
const codeOf = (fn: () => unknown) => {
  try { fn() } catch (e) { return e instanceof TunnelError ? e.code : `other:${(e as Error).message}` }
  return 'none'
}

describe('token', () => {
  test('bare token, whole command, surrounding whitespace', () => {
    expect(extractToken(TOKEN)).toBe(TOKEN)
    expect(extractToken(`  ${TOKEN}\n`)).toBe(TOKEN)
    expect(extractToken(`cloudflared.exe service install ${TOKEN}`)).toBe(TOKEN)
    expect(extractToken(`cloudflared tunnel run --token ${TOKEN}`)).toBe(TOKEN)
  })

  test('anything else is refused, and the error never echoes the input', () => {
    const notJson = Buffer.from('not json at all, definitely').toString('base64')
    const noSecret = Buffer.from(JSON.stringify({ a: 'x', t: 'y' })).toString('base64')
    for (const bad of ['', 'hello', 'eyJ', notJson, noSecret, 'x'.repeat(5000), 42, null, undefined, {}]) {
      expect(codeOf(() => extractToken(bad))).toBe('bad-token')
    }
    try { extractToken(`xx ${noSecret} xx`) } catch (e) { expect(String(e)).not.toContain(noSecret.slice(0, 12)) }
  })

  test('tunnel id comes out of the token; junk gives null', () => {
    expect(tunnelIdOf(TOKEN)).toBe('11111111-2222-3333-4444-555555555555')
    expect(tunnelIdOf('')).toBeNull()
    expect(tunnelIdOf(Buffer.from(JSON.stringify({ a: 'x', t: '../x', s: 'y' })).toString('base64'))).toBeNull()
  })

  test('mask keeps only the end', () => {
    const m = maskToken(TOKEN)
    expect(m).toBe(`${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`)
    expect(m).not.toContain(SECRET)
    expect(maskToken('short')).toBe('…')
  })

  test('redact removes the token, its secret part, token-shaped text and --token / TUNNEL_TOKEN values', () => {
    const line = `a ${TOKEN} b ${SECRET} c eyJhIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAifQ d --token abc123 e TUNNEL_TOKEN=zzz f`
    const out = redact(line, TOKEN)
    for (const leak of [TOKEN, SECRET, 'eyJhIjoi', 'abc123', 'zzz']) expect(out).not.toContain(leak)
    expect(out).toContain('--token [token]')
    expect(redact('plain line', TOKEN)).toBe('plain line')
    expect(redact(`x ${TOKEN}`)).not.toContain(TOKEN)
  })
})

describe('finding cloudflared', () => {
  const env = { PATH: 'C:\\tools;"C:\\Program Files\\bin"', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }

  test('PATH entries come first, then the common install locations', () => {
    const list = candidatePaths(env, 'win32')
    expect(list[0]).toBe('C:\\tools\\cloudflared.exe')
    expect(list[1]).toBe('C:\\Program Files\\bin\\cloudflared.exe')
    expect(list).toContain('C:\\Program Files\\cloudflared\\cloudflared.exe')
    expect(list).toContain('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe')
    expect(new Set(list).size).toBe(list.length)
  })

  test('first existing candidate wins; our own copy is skipped; none gives null', () => {
    const have = new Set(['C:\\Program Files\\cloudflared\\cloudflared.exe', 'C:\\tools\\cloudflared.exe'])
    expect(findCloudflared({ env, platform: 'win32', exists: f => have.has(f) })).toBe('C:\\tools\\cloudflared.exe')
    expect(findCloudflared({ env, platform: 'win32', exists: f => have.has(f), skip: ['c:\\TOOLS\\cloudflared.exe'] })).toBe('C:\\Program Files\\cloudflared\\cloudflared.exe')
    expect(findCloudflared({ env, platform: 'win32', exists: () => false })).toBeNull()
  })
})

describe('prepareCloudflared', () => {
  const noEnv = { PATH: '' }

  function release(body: string, opts: { digest?: string | null, omit?: boolean } = {}) {
    const name = releaseAssetName()!
    const calls: string[] = []
    const fetchFn = async (url: string) => {
      calls.push(url)
      if (url.endsWith('/releases/latest')) {
        const digest = opts.digest === undefined ? `sha256:${sha(body)}` : opts.digest
        return Response.json({ assets: opts.omit ? [] : [{ name, browser_download_url: `https://dl.test/${name}`, digest }] })
      }
      if (url === `https://dl.test/${name}`) return new Response(body)
      return new Response('nope', { status: 404 })
    }
    return { fetchFn, calls }
  }

  test('an installed cloudflared is copied under data/runtime/cloudflared and used from there', async () => {
    const sys = join(dir, 'sys', 'cloudflared.exe')
    mkdirSync(join(dir, 'sys'))
    writeFileSync(sys, 'SYSTEM-BUILD')
    const r = await prepareCloudflared({ dataDir: dir, env: { PATH: join(dir, 'sys') }, platform: 'win32', fetch: release('x').fetchFn })
    expect(r).toEqual({ exe: cloudflaredPath(dir, 'win32'), source: 'system' })
    expect(readFileSync(r.exe, 'utf8')).toBe('SYSTEM-BUILD')
  })

  test('the copy is refreshed only when the installed one changed', async () => {
    const sysDir = join(dir, 'sys')
    mkdirSync(sysDir)
    const sys = join(sysDir, 'cloudflared.exe')
    writeFileSync(sys, 'V1')
    const o: PrepareOptions = { dataDir: dir, env: { PATH: sysDir }, platform: 'win32' }
    const first = await prepareCloudflared(o)
    // Same content: the copy stays untouched (an old mtime on ours would be replaced by a re-copy).
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(first.exe, old, old)
    utimesSync(sys, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000))
    await prepareCloudflared(o)
    expect(statSync(first.exe).mtimeMs).toBeLessThan(Date.now() - 3_000_000)
    writeFileSync(sys, 'V2-longer')
    await prepareCloudflared(o)
    expect(readFileSync(first.exe, 'utf8')).toBe('V2-longer')
  })

  test('nothing installed: downloads the official build and verifies SHA-256', async () => {
    const rel = release('OFFICIAL-BINARY')
    const steps: string[] = []
    const r = await prepareCloudflared({ dataDir: dir, env: noEnv, platform: 'win32', fetch: rel.fetchFn, exists: () => false, onStep: s => steps.push(s) })
    expect(r.source).toBe('downloaded')
    expect(readFileSync(r.exe, 'utf8')).toBe('OFFICIAL-BINARY')
    expect(steps).toEqual(['find', 'download'])
    // Already there: no second download.
    const before = rel.calls.length
    expect((await prepareCloudflared({ dataDir: dir, env: noEnv, platform: 'win32', fetch: rel.fetchFn, exists: () => false })).source).toBe('downloaded')
    expect(rel.calls.length).toBe(before)
  })

  test('a download that fails verification leaves nothing behind', async () => {
    for (const rel of [release('BAD', { digest: `sha256:${sha('other')}` }), release('x', { digest: null }), release('x', { omit: true })]) {
      const err = await prepareCloudflared({ dataDir: dir, env: noEnv, platform: 'win32', fetch: rel.fetchFn, exists: () => false }).catch(e => e)
      expect(err).toBeInstanceOf(TunnelError)
      expect((err as TunnelError).code).toBe('download-failed')
      expect(existsSync(cloudflaredPath(dir, 'win32'))).toBe(false)
      const d = join(cloudflaredPath(dir, 'win32'), '..')
      expect(existsSync(d) ? readdirSync(d).length : 0).toBe(0)
    }
  })

  test('offline gives download-failed, not a crash', async () => {
    const err = await prepareCloudflared({ dataDir: dir, env: noEnv, platform: 'win32', exists: () => false, fetch: async () => { throw new Error('offline') } }).catch(e => e)
    expect((err as TunnelError).code).toBe('download-failed')
  })
})

// ---------------------------------------------------------------------------------------
// Manager, with a real child process (the fixture run by bun)

async function until<T>(fn: () => T | undefined | false | null, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 25))
  }
}

const baseCfg = (over: Partial<TunnelConfig> = {}): TunnelConfig => ({
  tunnelEnabled: true, mode: 'token', protocol: 'http2', publicEnabled: true, publicState: 'listening', token: TOKEN, port: 8080, ...over,
})

function makeManager(mode: () => string, over: Partial<ConstructorParameters<typeof TunnelManager>[0]> = {}) {
  const statuses: TunnelStatus[] = []
  const infos: TunnelInfo[] = []
  const lines: string[] = []
  const launches: Array<{ mode: string, port: number, protocol: string }> = []
  const registry = new PidRegistry(join(dir, 'run', 'pids.json'))
  let spawns = 0
  const m = new TunnelManager({
    dataDir: dir,
    registry,
    prepare: async () => ({ exe: process.execPath, source: 'system' }),
    version: async () => '2099.1.0',
    buildArgs: (l) => { spawns++; launches.push(l); return [FIXTURE, mode()] },
    retryDelaysMs: [30, 30],
    onStatus: (i: TunnelInfo) => { statuses.push(i.status); infos.push(i) },
    onLine: l => lines.push(l),
    ...over,
  })
  return { m, statuses, infos, lines, launches, registry, spawns: () => spawns }
}

const errorOf = (m: TunnelManager) => { const s = m.status().status; return s.state === 'error' ? s : null }

describe('ingressHostnames', () => {
  const line = (cfg: unknown) => `2026-10-01T00:00:01Z INF Updated to new configuration config=${JSON.stringify(JSON.stringify(cfg))} version=3`

  test('host names whose service is this public entry port, lower-cased, no duplicates', () => {
    const l = line({ ingress: [
      { hostname: 'LLM.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'b.example.net', service: 'https://localhost:8080/' },
      { hostname: 'c.example.org', service: 'http://[::1]:8080' },
      { hostname: 'other.example.com', service: 'http://127.0.0.1:3000' },
      { hostname: '*.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'far.example.com', service: 'http://192.168.1.5:8080' },
      { service: 'http_status:404' },
    ] })
    expect(ingressHostnames(l, 8080)).toEqual(['llm.example.com', 'b.example.net', 'c.example.org'])
    expect(ingressHostnames(l, 3000)).toEqual(['other.example.com'])
  })

  test('an update without our port is an empty list; other lines and junk are null', () => {
    expect(ingressHostnames(line({ ingress: [{ service: 'http_status:404' }] }), 8080)).toEqual([])
    expect(ingressHostnames('INF Registered tunnel connection connIndex=0', 8080)).toBeNull()
    expect(ingressHostnames('INF Updated to new configuration config="{not json" version=1', 8080)).toBeNull()
    expect(ingressHostnames('INF Updated to new configuration version=1', 8080)).toBeNull()
  })
})

describe('quick tunnel helpers', () => {
  const at = (m: string) => `2026-10-01T00:00:00Z INF ${m}`

  test('the address comes from the banner line, lower-cased', () => {
    expect(quickTunnelHost(at('|  https://Some-Random-Words.trycloudflare.com                    |'))).toBe('some-random-words.trycloudflare.com')
    expect(quickTunnelHost('https://abc-1.trycloudflare.com')).toBe('abc-1.trycloudflare.com')
  })

  test('words in the address are not log levels', () => {
    for (const label of ['some-error-words', 'some-err-words', 'some-wrn-words', 'ftl-warning-x'])
      expect(quickTunnelHost(at(`|  https://${label}.trycloudflare.com  |`))).toBe(`${label}.trycloudflare.com`)
  })

  test('not an address: the API host, error / warning lines, deeper or longer names, other text', () => {
    for (const line of [
      at('Requesting new quick Tunnel on trycloudflare.com...'),
      at('POST https://api.trycloudflare.com/tunnel'),
      '2026-10-01T00:00:00Z ERR failed to request quick Tunnel: Post "https://abc.trycloudflare.com/tunnel"',
      '2026-10-01T00:00:00Z WRN https://abc.trycloudflare.com is slow',
      '2026-10-01T00:00:00Z FTL https://abc.trycloudflare.com',
      'ERR https://abc.trycloudflare.com',
      at('request failed error="https://abc.trycloudflare.com"'),
      at('POST https://abc.trycloudflare.com/tunnel'),
      at('https://a.b.trycloudflare.com'),
      at('https://abc.trycloudflare.com.example.com'),
      at('https://-abc.trycloudflare.com'),
      at('http://abc.trycloudflare.com'),
      at('Registered tunnel connection connIndex=0'),
    ]) expect(quickTunnelHost(line)).toBeNull()
  })

  test('the environment has no inherited TUNNEL_* variable in any letter case; token mode gets only the saved one', () => {
    const base = { PATH: 'X:\bin', TUNNEL_NAME: 'n', tunnel_token: 'a', Tunnel_Hostname: 'h.example.com', TUNNEL_LOGLEVEL: 'error', HTTPS_PROXY: 'http://proxy.example.com' }
    expect(cloudflaredEnv(base, null)).toEqual({ PATH: 'X:\bin', HTTPS_PROXY: 'http://proxy.example.com' })
    expect(cloudflaredEnv(base, 'saved')).toEqual({ PATH: 'X:\bin', HTTPS_PROXY: 'http://proxy.example.com', TUNNEL_TOKEN: 'saved' })
    expect(base.tunnel_token).toBe('a')
  })

  test('arguments are an array: quick points at the loopback entry port with our own config file; both carry the protocol', () => {
    expect(tunnelArgs('quick', 8081, 'X:\\data\\q.yml', 'http2')).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--config', 'X:\\data\\q.yml', '--url', 'http://127.0.0.1:8081'])
    expect(tunnelArgs('token', 8081, 'ignored', 'quic')).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'quic', 'run'])
  })

  test('the config file lives under data/runtime/cloudflared and is rewritten only when changed', () => {
    const file = ensureQuickConfig(dir)
    expect(file).toBe(quickConfigPath(dir))
    expect(file.startsWith(join(dir, 'runtime', 'cloudflared'))).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('{}')
    expect(text).not.toMatch(/^\s*tunnel:/m)
    utimesSync(file, new Date(1_000_000), new Date(1_000_000))
    ensureQuickConfig(dir)
    expect(statSync(file).mtimeMs).toBe(1_000_000)
    writeFileSync(file, 'tunnel: someone-else\n')
    ensureQuickConfig(dir)
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(readdirSync(join(dir, 'runtime', 'cloudflared'))).toEqual(['quick-tunnel.yml'])
  })
})

describe('TunnelManager quick mode', () => {
  const quickCfg = (over: Partial<TunnelConfig> = {}) => baseCfg({ mode: 'quick', ...over })
  const hostOf = (m: TunnelManager) => m.status().quickHost

  test('needs no token, never passes one (not even an inherited one), and reads the address from the output', async () => {
    const inherited = process.env.TUNNEL_TOKEN
    const inheritedName = process.env.TUNNEL_NAME
    process.env.TUNNEL_TOKEN = TOKEN
    process.env.TUNNEL_NAME = 'someone-elses-tunnel'
    try {
      const envs: Array<NodeJS.ProcessEnv | undefined> = []
      const { m, registry, launches } = makeManager(() => 'quick', {
        spawn: ((exe: string, args: string[], o: Parameters<typeof spawn>[2]) => { envs.push(o?.env); return spawn(exe, args, o) }) as typeof spawn,
      })
      m.apply(quickCfg({ token: '' }))
      await until(() => m.status().status.state === 'connected' && hostOf(m))
      expect(m.status()).toMatchObject({ mode: 'quick', hostnames: null, status: { state: 'connected', connections: 1 } })
      expect(hostOf(m)).toMatch(/^fake-words-\d+\.trycloudflare\.com$/)
      expect(launches).toEqual([{ mode: 'quick', port: 8080, protocol: 'http2' }])
      expect(m.tail(50).join('\n')).toContain('token-length=0')
      expect(envs).toHaveLength(1)
      expect(Object.keys(envs[0]!).filter(k => k.toUpperCase().startsWith('TUNNEL_'))).toEqual([])
      const rec = registry.list()
      expect(rec).toHaveLength(1)
      expect(rec[0]).toMatchObject({ tag: 'tunnel', port: 8080 })
      // A saved token is ignored in quick mode as well.
      m.apply(quickCfg())
      await new Promise(r => setTimeout(r, 100))
      expect(launches).toHaveLength(1)
      const pid = rec[0]!.pid
      m.apply(quickCfg({ publicEnabled: false }))
      await until(() => m.status().status.state === 'off')
      expect(m.status().status).toEqual({ state: 'off', reason: 'public-off' })
      expect(hostOf(m)).toBeNull()
      await until(() => !isAlive(pid))
      expect(registry.list()).toEqual([])
      await m.shutdown()
    } finally {
      if (inherited === undefined) delete process.env.TUNNEL_TOKEN
      else process.env.TUNNEL_TOKEN = inherited
      if (inheritedName === undefined) delete process.env.TUNNEL_NAME
      else process.env.TUNNEL_NAME = inheritedName
    }
  })

  test('the address is cleared when the process ends and a restart prints a new one', async () => {
    const { m, infos, spawns } = makeManager(() => 'quick-crash', { retryDelaysMs: [150, 60_000] })
    m.apply(quickCfg())
    const first = await until(() => hostOf(m))
    await until(() => spawns() === 2 && hostOf(m) && hostOf(m) !== first)
    const second = hostOf(m)!
    const seq = infos.map(i => i.quickHost).filter((h, i, a) => i === 0 || h !== a[i - 1])
    // Never the old address once the process is gone: first -> none -> second.
    expect(seq.slice(seq.indexOf(first), seq.indexOf(second) + 1)).toEqual([first, null, second])
    expect(infos.find(i => i.status.state === 'error')?.quickHost).toBeNull()
    await m.shutdown()
    expect(hostOf(m)).toBeNull()
  })

  test('a different port restarts the quick tunnel at the new port', async () => {
    const { m, launches, registry } = makeManager(() => 'quick')
    m.apply(quickCfg())
    const first = await until(() => hostOf(m))
    m.apply(quickCfg({ port: 8099 }))
    await until(() => launches.length === 2 && hostOf(m) && hostOf(m) !== first)
    expect(launches).toEqual([{ mode: 'quick', port: 8080, protocol: 'http2' }, { mode: 'quick', port: 8099, protocol: 'http2' }])
    await until(() => registry.list().length === 1 && registry.list()[0]!.port === 8099)
    await m.shutdown()
  })

  test('switching modes restarts; the own tunnel host names are not shown while the quick one runs', async () => {
    let mode = 'config'
    const { m, launches } = makeManager(() => mode)
    m.apply(baseCfg())
    await until(() => m.status().hostnames?.length)
    mode = 'quick'
    m.apply(quickCfg())
    await until(() => hostOf(m) && m.status().status.state === 'connected')
    expect(m.status()).toMatchObject({ mode: 'quick', hostnames: null })
    mode = 'config'
    m.apply(baseCfg())
    await until(() => m.status().hostnames?.length)
    expect(m.status()).toMatchObject({ mode: 'token', quickHost: null, hostnames: ['llm.example.com', 'b.example.net'] })
    expect(launches.map(l => l.mode)).toEqual(['token', 'quick', 'token'])
    await m.shutdown()
  })

  test('a different protocol restarts either kind of tunnel; the same settings do not', async () => {
    let mode = 'connect'
    const { m, launches } = makeManager(() => mode)
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'connected')
    m.apply(baseCfg({ protocol: 'quic' }))
    await until(() => launches.length === 2 && m.status().status.state === 'connected')
    mode = 'quick'
    m.apply(quickCfg({ protocol: 'quic' }))
    await until(() => launches.length === 3 && hostOf(m))
    m.apply(quickCfg({ protocol: 'quic' }))
    m.apply(quickCfg({ protocol: 'http2' }))
    await until(() => launches.length === 4 && hostOf(m))
    await new Promise(r => setTimeout(r, 100))
    expect(launches.map(l => `${l.mode}/${l.protocol}`)).toEqual(['token/http2', 'token/quic', 'quick/quic', 'quick/http2'])
    await m.shutdown()
  })

  test('stopping kills the whole process tree and leaves pids.json clean', async () => {
    const { m, registry } = makeManager(() => 'quick-child')
    m.apply(quickCfg())
    await until(() => m.status().status.state === 'connected' && /child=\d+/.test(m.tail(50).join('\n')))
    const child = Number(/child=(\d+)/.exec(m.tail(50).join('\n'))![1])
    expect(isAlive(child)).toBe(true)
    await m.shutdown()
    await until(() => !isAlive(child))
    expect(registry.list()).toEqual([])
  })

  test('the quick config file is written before the start, next to the cloudflared copy', async () => {
    const { m } = makeManager(() => 'quick')
    expect(existsSync(quickConfigPath(dir))).toBe(false)
    m.apply(quickCfg())
    await until(() => hostOf(m))
    expect(existsSync(quickConfigPath(dir))).toBe(true)
    await m.shutdown()
  })
})

describe('TunnelManager', () => {
  test('host names come from the configuration cloudflared receives, and are forgotten with the token', async () => {
    const { m } = makeManager(() => 'config')
    m.apply(baseCfg())
    await until(() => m.status().hostnames?.length)
    expect(m.status().hostnames).toEqual(['llm.example.com', 'b.example.net'])
    m.apply(baseCfg({ tunnelEnabled: false }))
    await until(() => m.status().status.state === 'off')
    expect(m.status().hostnames).toEqual(['llm.example.com', 'b.example.net'])
    m.apply(baseCfg({ token: '' }))
    await new Promise(r => setTimeout(r, 50))
    expect(m.status().hostnames).toBeNull()
    await m.shutdown()
  })

  test('a port change in token mode keeps the process and filters the received host names for the new port', async () => {
    const { m, spawns } = makeManager(() => 'config')
    m.apply(baseCfg())
    await until(() => m.status().hostnames?.length)
    m.apply(baseCfg({ port: 3000 }))
    await until(() => m.status().hostnames?.[0] === 'other.example.com')
    expect(m.status().hostnames).toEqual(['other.example.com'])
    m.apply(baseCfg({ port: 8099 }))
    await until(() => m.status().hostnames?.length === 0)
    m.apply(baseCfg())
    await until(() => m.status().hostnames?.length === 2)
    expect(spawns()).toBe(1)
    await m.shutdown()
  })

  test('reasons for staying off', async () => {
    const { m } = makeManager(() => 'connect')
    const reasonOf = async (c: Partial<TunnelConfig>) => {
      m.apply(baseCfg(c))
      await new Promise(r => setTimeout(r, 30))
      const s = m.status().status
      return s.state === 'off' ? s.reason : s.state
    }
    expect(await reasonOf({ tunnelEnabled: false })).toBe('disabled')
    expect(await reasonOf({ token: '' })).toBe('no-token')
    expect(await reasonOf({ publicEnabled: false })).toBe('public-off')
    expect(await reasonOf({ publicState: 'unavailable' })).toBe('public-unavailable')
    expect(await reasonOf({ publicState: 'error' })).toBe('public-error')
    await m.shutdown()
  })

  test('connects: token in the environment (not argv), pid recorded, then removed on stop', async () => {
    const { m, registry, statuses } = makeManager(() => 'connect')
    m.apply(baseCfg())
    await until(() => { const s = m.status().status; return s.state === 'connected' && s.connections === 2 })
    expect(m.status().status).toEqual({ state: 'connected', connections: 2 })
    expect(m.status().cloudflared).toEqual({ source: 'system', version: '2099.1.0' })
    expect(statuses.map(s => s.state)).toContain('preparing')
    const rec = registry.list()
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({ tag: 'tunnel', port: 8080 })
    expect(m.tail().join('\n')).toContain(`token-length=${TOKEN.length}`)
    const pid = rec[0]!.pid
    m.apply(baseCfg({ tunnelEnabled: false }))
    await until(() => m.status().status.state === 'off')
    await until(() => !isAlive(pid))
    expect(registry.list()).toEqual([])
    await m.shutdown()
  })

  test('the token never shows up in status, output lines, tail or errors', async () => {
    const { m, statuses, lines } = makeManager(() => 'leak')
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'connected')
    await m.shutdown()
    const everything = JSON.stringify([statuses, lines, m.tail(200), m.status()])
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(SECRET)
    expect(lines.some(l => l.includes('debug token=[token] secret=[secret]'))).toBe(true)
  })

  test('an invalid token is an error that is not retried', async () => {
    const { m, spawns } = makeManager(() => 'badtoken')
    m.apply(baseCfg())
    const st = await until(() => errorOf(m))
    expect(st).toMatchObject({ code: 'bad-token', retryAt: null })
    await new Promise(r => setTimeout(r, 200))
    expect(spawns()).toBe(1)
    expect(m.status().status.state).toBe('error')
    await m.shutdown()
  })

  test('an unexpected exit is retried after a delay; retry() starts at once', async () => {
    const { m, spawns } = makeManager(() => 'crash', { retryDelaysMs: [40, 10_000] })
    m.apply(baseCfg())
    const first = await until(() => errorOf(m))
    expect(first).toMatchObject({ code: 'exited', detail: 'exit code 2' })
    expect(first.tail.join('\n')).toContain('something broke')
    await until(() => spawns() >= 2)
    // The wait after the second failure is 10 s: retry() skips it.
    await until(() => { const s = errorOf(m); return s !== null && s.retryAt !== null && s.retryAt - Date.now() > 5000 })
    const n = spawns()
    m.retry()
    await until(() => spawns() > n)
    await m.shutdown()
  })

  test('only an error line while connecting is shown as starting with the last error', async () => {
    const { m } = makeManager(() => 'quiet')
    m.apply(baseCfg())
    const st = await until(() => { const s = m.status().status; return s.state === 'starting' && s.lastError ? s : null })
    expect(st.lastError).toContain('Unable to establish connection')
    await m.shutdown()
  })

  test('a changed token restarts with the new one; the same token does not', async () => {
    const { m, spawns } = makeManager(() => 'connect')
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'connected')
    m.apply(baseCfg({ port: 8099 }))
    await new Promise(r => setTimeout(r, 150))
    expect(spawns()).toBe(1)
    const other = Buffer.from(JSON.stringify({ a: 'a', t: 't', s: 'another-secret-value' })).toString('base64')
    m.apply(baseCfg({ token: other }))
    await until(() => spawns() === 2)
    await until(() => m.status().status.state === 'connected' && m.tail(50).join('\n').includes(`token-length=${other.length}`))
    await m.shutdown()
  })

  test('stopping kills the whole process tree', async () => {
    const { m } = makeManager(() => 'child')
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'connected')
    const child = Number(/child=(\d+)/.exec(m.tail(50).join('\n'))![1])
    expect(isAlive(child)).toBe(true)
    await m.shutdown()
    await until(() => !isAlive(child))
  })

  test('turning it off while cloudflared is still being prepared starts nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { m, spawns } = makeManager(() => 'connect', { prepare: async () => { await gate; return { exe: process.execPath, source: 'system' } } })
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'preparing')
    // Turning off waits for the preparation: let it finish a moment later.
    setTimeout(() => release(), 50)
    m.apply(baseCfg({ tunnelEnabled: false }))
    await until(() => m.status().status.state === 'off')
    await new Promise(r => setTimeout(r, 200))
    expect(spawns()).toBe(0)
    expect(m.status().status.state).toBe('off')
    await m.shutdown()
  })

  test('a failed preparation is an error with the reason, and is retried', async () => {
    let tries = 0
    const { m } = makeManager(() => 'connect', {
      prepare: async () => {
        tries++
        if (tries === 1) throw new TunnelError('download-failed', `network: ${TOKEN}`)
        return { exe: process.execPath, source: 'downloaded' }
      },
    })
    m.apply(baseCfg())
    const st = await until(() => errorOf(m))
    expect(st).toMatchObject({ code: 'download-failed' })
    expect(JSON.stringify(st)).not.toContain(TOKEN)
    await until(() => m.status().status.state === 'connected')
    expect(m.status().cloudflared?.source).toBe('downloaded')
    await m.shutdown()
  })

  test('connection count follows connIndex: an Unregistered line is not a new connection', async () => {
    const { m, statuses } = makeManager(() => 'flap')
    m.apply(baseCfg())
    await until(() => { const s = m.status().status; return s.state === 'connected' && s.connections === 1 && statuses.some(x => x.state === 'starting') })
    const seen = statuses.flatMap(s => (s.state === 'connected' ? [s.connections] : s.state === 'starting' ? ['starting'] : []))
    expect(seen).toEqual(['starting', 1, 2, 1, 'starting', 1])
    await m.shutdown()
  })

  test('changing the token while cloudflared is downloading cancels and waits for the first preparation', async () => {
    let active = 0
    let maxActive = 0
    let started = 0
    const aborted: boolean[] = []
    const prepare = async (o: { net?: { signal?: AbortSignal } }) => {
      started++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (started === 1) {
          // The first one hangs until it is cancelled, then needs a moment to clean up.
          await new Promise<void>((_res, rej) => o.net!.signal!.addEventListener('abort', () => rej(new Error('stopped'))))
        }
        return { exe: process.execPath, source: 'system' as const }
      } finally {
        if (started === 1) await new Promise(r => setTimeout(r, 60))
        aborted.push(!!o.net?.signal?.aborted)
        active--
      }
    }
    const { m } = makeManager(() => 'connect', { prepare: prepare as never })
    m.apply(baseCfg())
    await until(() => started === 1)
    const other = Buffer.from(JSON.stringify({ a: 'a', t: 't', s: 'another-secret-value' })).toString('base64')
    m.apply(baseCfg({ token: other }))
    await until(() => m.status().status.state === 'connected')
    expect(started).toBe(2)
    expect(maxActive).toBe(1)
    expect(aborted).toEqual([true, false])
    await m.shutdown()
  })

  test('shutdown waits for a preparation in progress', async () => {
    let finished = false
    const prepare = async (o: { net?: { signal?: AbortSignal } }) => {
      await new Promise<void>((_res, rej) => o.net!.signal!.addEventListener('abort', () => rej(new Error('stopped'))))
      return { exe: process.execPath, source: 'system' as const }
    }
    const wrapped = async (o: never) => { try { return await prepare(o) } finally { await new Promise(r => setTimeout(r, 50)); finished = true } }
    const { m } = makeManager(() => 'connect', { prepare: wrapped as never })
    m.apply(baseCfg())
    await until(() => m.status().status.state === 'preparing')
    await m.shutdown()
    expect(finished).toBe(true)
  })

  test('a pid that cannot be recorded: the process is stopped, nothing stale is kept, a retry works', async () => {
    class Flaky extends PidRegistry {
      broken = true
      override add(r: Parameters<PidRegistry['add']>[0]) {
        if (this.broken) throw new Error('disk full')
        super.add(r)
      }
    }
    const registry = new Flaky(join(dir, 'run', 'pids.json'))
    const pids: number[] = []
    const { spawn } = await import('node:child_process')
    const { m } = makeManager(() => 'connect', {
      registry,
      retryDelaysMs: [60_000],
      spawn: ((...a: Parameters<typeof spawn>) => { const c = spawn(...a); if (c.pid) pids.push(c.pid); return c }) as never,
    })
    m.apply(baseCfg())
    const st = await until(() => errorOf(m))
    expect(st).toMatchObject({ code: 'spawn-failed' })
    expect(st.detail).toContain('Cannot record pid')
    await until(() => !isAlive(pids[0]!))
    registry.broken = false
    m.retry()
    await until(() => m.status().status.state === 'connected')
    expect(pids).toHaveLength(2)
    expect(registry.list()).toHaveLength(1)
    await m.shutdown()
  })

  test('waits for the startup cleanup before starting anything', async () => {
    let done!: () => void
    const ready = new Promise<void>((r) => { done = r })
    const { m, spawns } = makeManager(() => 'connect', { ready })
    m.apply(baseCfg())
    await new Promise(r => setTimeout(r, 150))
    expect(spawns()).toBe(0)
    done()
    await until(() => m.status().status.state === 'connected')
    await m.shutdown()
  })
})
