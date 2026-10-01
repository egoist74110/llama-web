import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractZip, installLatest, listInstalled, pickCudaVersion, RuntimeError, versionsDir } from '../../server/core/llamacpp'
import { EXE, fakeExtract, fakeGithub, sha } from '../fixtures/fake-github'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-rt-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

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

test('pickCudaVersion: exact match, else newest minor of the same major with a cudart', () => {
  const t = 'b9'
  const names = (vs: string[], cudart = vs) => [
    ...vs.map(v => `llama-${t}-bin-win-cuda-${v}-x64.zip`),
    ...cudart.map(v => `cudart-llama-bin-win-cuda-${v}-x64.zip`),
    `llama-${t}-bin-win-cuda-13.9-arm64.zip`,
  ]
  expect(pickCudaVersion(names(['12.4', '13.3', '13.4']), t, 'win', '13.3')).toBe('13.3')
  expect(pickCudaVersion(names(['12.4', '13.4']), t, 'win', '13.3')).toBe('13.4')
  expect(pickCudaVersion(names(['13.4', '13.10']), t, 'win', '13.3')).toBe('13.10')
  expect(pickCudaVersion(names(['13.4', '13.5'], ['13.4']), t, 'win', '13.3')).toBe('13.4') // 13.5 has no cudart
  expect(pickCudaVersion(names(['12.4']), t, 'win', '13.3')).toBeNull() // never switch major
})

test('installLatest falls back to the newer CUDA minor the release actually ships', async () => {
  const f = fakeGithub()
  const tag = await installLatest(opts(f, { cudaRuntime: '13.2' }))
  expect(tag).toBe('b1234')
  expect(f.calls).toContain(`https://dl.test/${f.binName}`)
})
