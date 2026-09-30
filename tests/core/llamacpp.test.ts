import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntime, extractZip, installLatest, listInstalled, RuntimeError, versionsDir, type RuntimeStatus } from '../../server/core/llamacpp'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-rt-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const EXE = 'llama-server.exe'
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

interface FakeOpts {
  tag?: string
  bodies?: Record<string, string>
  digests?: Record<string, string | null>
  omit?: string[]
  fail?: string
}

/** Fake GitHub: routes by URL, records requests. */
function fakeGithub(o: FakeOpts = {}) {
  const tag = o.tag ?? 'b1234'
  const binName = `llama-${tag}-bin-win-cuda-13.3-x64.zip`
  const dllName = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  const bodies: Record<string, string> = { [binName]: 'BIN-ZIP', [dllName]: 'DLL-ZIP', ...o.bodies }
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://dl.test/${name}`,
    digest: name in (o.digests ?? {}) ? o.digests![name] : `sha256:${sha(bodies[name] ?? '')}`,
  })
  const calls: string[] = []
  const fetchFn = async (url: string) => {
    calls.push(url)
    if (o.fail && url.includes(o.fail)) throw new Error('offline')
    if (url.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://dl.test/nightly-tag.txt' }] })
    if (url === 'https://dl.test/nightly-tag.txt') return new Response(`${tag}\n`)
    if (url.endsWith(`/releases/tags/${tag}`)) return Response.json({ assets: [binName, dllName].filter(n => !o.omit?.includes(n)).map(asset) })
    const name = url.replace('https://dl.test/', '')
    if (name in bodies) return new Response(bodies[name])
    return new Response('nope', { status: 404 })
  }
  return { fetchFn, calls, binName, dllName }
}

/** Extract stub: bin zip yields the exe, cudart zip yields a dll. */
const fakeExtract = (root = '') => async (zip: string, dest: string) => {
  const dir = join(dest, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, zip.includes('cudart') ? 'cudart64_13.dll' : EXE), 'x')
}

const opts = (f: ReturnType<typeof fakeGithub>, extra = {}) => ({
  dataDir: data, cudaRuntime: '13.3', fetch: f.fetchFn, extract: fakeExtract(), platform: 'win32' as const, ...extra,
})

test('listInstalled: only bNNNN directories that contain the exe, newest first', () => {
  const base = versionsDir(data)
  for (const [n, withExe] of [['b100', true], ['b2000', true], ['b300', false], ['.tmp-b9-1', true], ['notes', true]] as const) {
    mkdirSync(join(base, n), { recursive: true })
    if (withExe) writeFileSync(join(base, n, EXE), '')
  }
  expect(listInstalled(data, 'win32')).toEqual(['b2000', 'b100'])
})

test('installLatest downloads, verifies and installs both archives into the version directory', async () => {
  const f = fakeGithub()
  const tag = await installLatest(opts(f))
  expect(tag).toBe('b1234')
  const dir = join(versionsDir(data), 'b1234')
  expect(existsSync(join(dir, EXE))).toBe(true)
  expect(existsSync(join(dir, 'cudart64_13.dll'))).toBe(true)
  expect(readdirSync(versionsDir(data))).toEqual(['b1234']) // temp work directory removed
})

test('archive with a single top-level folder is flattened', async () => {
  const tag = await installLatest(opts(fakeGithub(), { extract: fakeExtract('llama-b1234') }))
  expect(existsSync(join(versionsDir(data), tag, EXE))).toBe(true)
})

test('digest mismatch: nothing installed, work directory removed', async () => {
  const f = fakeGithub({ bodies: { 'llama-b1234-bin-win-cuda-13.3-x64.zip': 'TAMPERED' }, digests: { 'llama-b1234-bin-win-cuda-13.3-x64.zip': `sha256:${sha('BIN-ZIP')}` } })
  await expect(installLatest(opts(f))).rejects.toMatchObject({ code: 'digest-mismatch' })
  expect(readdirSync(versionsDir(data))).toEqual([])
})

test('missing digest is refused', async () => {
  const f = fakeGithub({ digests: { 'cudart-llama-bin-win-cuda-13.3-x64.zip': null } })
  await expect(installLatest(opts(f))).rejects.toMatchObject({ code: 'no-digest' })
  expect(readdirSync(versionsDir(data))).toEqual([])
})

test('missing asset, network failure, bad tag and extract failure are reported by code', async () => {
  await expect(installLatest(opts(fakeGithub({ omit: ['cudart-llama-bin-win-cuda-13.3-x64.zip'] })))).rejects.toMatchObject({ code: 'asset-missing' })
  await expect(installLatest(opts(fakeGithub({ fail: 'api.github.com' })))).rejects.toMatchObject({ code: 'network' })
  await expect(installLatest(opts(fakeGithub({ tag: 'v0.5.0' })))).rejects.toMatchObject({ code: 'bad-tag' })
  const boom = async () => { throw new RuntimeError('extract-failed', 'boom') }
  await expect(installLatest(opts(fakeGithub(), { extract: boom }))).rejects.toMatchObject({ code: 'extract-failed' })
  await expect(installLatest(opts(fakeGithub(), { extract: async () => {} }))).rejects.toMatchObject({ code: 'no-server-exe' })
  expect(readdirSync(versionsDir(data)).filter(n => !n.startsWith('.tmp-'))).toEqual([])
})

test('stale .tmp- directories from an interrupted install are cleaned', async () => {
  mkdirSync(join(versionsDir(data), '.tmp-b1-99', 'out'), { recursive: true })
  await installLatest(opts(fakeGithub()))
  expect(readdirSync(versionsDir(data))).toEqual(['b1234'])
})

test('already installed latest build is not downloaded again', async () => {
  const f = fakeGithub()
  await installLatest(opts(f))
  f.calls.length = 0
  await installLatest(opts(f))
  expect(f.calls.some(c => c.startsWith('https://dl.test/llama-') || c.includes('cudart'))).toBe(false)
})

test('ensureRuntime: keeps a valid current, adopts an installed version, downloads only when empty', async () => {
  const seen: RuntimeStatus[] = []
  let current = ''
  const base = { dataDir: data, cudaRuntime: '13.3', platform: 'win32' as const, allowDownload: true, setCurrent: (t: string) => { current = t }, onStatus: (s: RuntimeStatus) => seen.push(s) }

  // Empty + downloads disabled.
  expect(await ensureRuntime({ ...base, current: '', allowDownload: false })).toEqual({ state: 'disabled' })

  // Empty: download.
  const f = fakeGithub()
  const r1 = await ensureRuntime({ ...base, current: '', fetch: f.fetchFn, extract: fakeExtract() })
  expect(r1).toEqual({ state: 'ready', tag: 'b1234' })
  expect(current).toBe('b1234')
  expect(seen.some(s => s.state === 'working' && s.step === 'download')).toBe(true)

  // Valid current: untouched, no network.
  f.calls.length = 0
  current = ''
  expect(await ensureRuntime({ ...base, current: 'b1234', fetch: f.fetchFn })).toEqual({ state: 'ready', tag: 'b1234' })
  expect(f.calls).toEqual([])
  expect(current).toBe('')

  // Stale current: adopt the installed one.
  expect(await ensureRuntime({ ...base, current: 'b999', fetch: f.fetchFn })).toEqual({ state: 'ready', tag: 'b1234' })
  expect(current).toBe('b1234')
})

test('ensureRuntime reports download failures as status, not exceptions', async () => {
  const r = await ensureRuntime({
    dataDir: data, cudaRuntime: '13.3', platform: 'win32', allowDownload: true, current: '', setCurrent() {},
    fetch: fakeGithub({ fail: 'api.github.com' }).fetchFn,
  })
  expect(r).toMatchObject({ state: 'error', code: 'network' })
})

test.skipIf(process.platform !== 'win32')('extractZip unpacks a real zip with the system tool', async () => {
  const src = join(data, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'hello')
  const zip = join(data, 'x.zip')
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const p = spawnSync(tar, ['-a', '-cf', zip, '-C', src, 'a.txt'], { stdio: 'ignore' })
  expect(p.status).toBe(0)
  const out = join(data, 'out')
  await extractZip(zip, out)
  expect(await Bun.file(join(out, 'a.txt')).text()).toBe('hello')
  await expect(extractZip(join(data, 'missing.zip'), join(data, 'out2'))).rejects.toMatchObject({ code: 'extract-failed' })
}, 30_000) // process start-up is slow on Windows
