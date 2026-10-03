import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionsDir } from '../../server/core/llamacpp'
import type { RuntimeTarget } from '../../server/core/platform'
import {
  AddError, parseGithubSource, parseVersionOutput, pickAsset, RuntimeInstaller, type InstallerOptions,
} from '../../server/core/runtime-add'
import { customDir, RuntimeRegistry } from '../../server/core/runtimes'
import { machoArm64, machoX64, peX64 } from '../fixtures/fake-binary'

let data: string
let work: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'lw-add-data-'))
  work = mkdtempSync(join(tmpdir(), 'lw-add-src-'))
})
afterEach(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const win: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const mac: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }
const VERSION = 'load_backend: loaded\nversion: 0.5.0-dev (build 11146, commit 7fe450e19)\nbuilt with Clang\n'
const exeName = (t: RuntimeTarget) => (t.os === 'win32' ? 'llama-server.exe' : 'llama-server')
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const customBase = () => join(versionsDir(data), 'custom')
const leftovers = () => (existsSync(customBase()) ? readdirSync(customBase()).filter(n => n.startsWith('.stage-')) : [])

function installer(over: Partial<InstallerOptions> = {}, target = win) {
  const registry = new RuntimeRegistry(data)
  const inst = new RuntimeInstaller({
    dataDir: data, target, registry, runVersion: async () => VERSION, clearQuarantine: async () => {}, freeBytes: () => null, ...over,
  })
  return { inst, registry }
}

/** A build directory: the executable (with a real header) and a shared library next to it. */
function buildDir(name = 'build', t = win, header = peX64(), extra: Record<string, string> = { 'ggml-base.dll': 'dll' }): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, exeName(t)), header)
  for (const [n, c] of Object.entries(extra)) writeFileSync(join(dir, n), c)
  return dir
}

describe('parseVersionOutput / parseGithubSource / pickAsset', () => {
  test('build number from the version line', () => {
    expect(parseVersionOutput(VERSION)).toEqual({ line: 'version: 0.5.0-dev (build 11146, commit 7fe450e19)', tag: 'b11146' })
    expect(parseVersionOutput('version: 4321 (abcdef0)\n')).toEqual({ line: 'version: 4321 (abcdef0)', tag: 'b4321' })
    expect(parseVersionOutput('error')).toEqual({ line: '', tag: '' })
  })
  test('only https://github.com/ repositories and release pages are accepted', () => {
    expect(parseGithubSource('https://github.com/ggml-org/llama.cpp')).toEqual({ owner: 'ggml-org', repo: 'llama.cpp', tag: null })
    expect(parseGithubSource('https://github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b', tag: null })
    expect(parseGithubSource('https://github.com/a/b/releases')).toEqual({ owner: 'a', repo: 'b', tag: null })
    expect(parseGithubSource('https://github.com/a/b/releases/latest')).toEqual({ owner: 'a', repo: 'b', tag: null })
    expect(parseGithubSource('https://github.com/a/b/releases/tag/b11146')).toEqual({ owner: 'a', repo: 'b', tag: 'b11146' })
    for (const bad of [
      'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://evil.test/github.com/a/b', 'https://user:pw@github.com/a/b',
      'https://github.com:8443/a/b', 'https://api.github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/issues', 'https://github.com/a/..',
      'https://github.com/a/b/releases/tag/x%2F..%2Fy', 'file:///etc/passwd', 'not a url', '',
    ]) expect(() => parseGithubSource(bad)).toThrow(AddError)
  })
  test('asset choice follows the host: Windows CUDA (with cudart) or CPU, macOS exactly the host architecture', () => {
    const names = [
      'llama-b1-bin-win-cuda-12.4-x64.zip', 'llama-b1-bin-win-cuda-13.3-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-13.3-x64.zip',
      'llama-b1-bin-win-cpu-x64.zip', 'llama-b1-bin-win-vulkan-x64.zip', 'llama-b1-bin-win-cpu-arm64.zip',
      'llama-b1-bin-macos-arm64.tar.gz', 'llama-b1-bin-macos-x64.tar.gz', 'llama-b1-xcframework.zip',
    ]
    expect(pickAsset(names, win, 'cuda')).toEqual({ bin: 'llama-b1-bin-win-cuda-13.3-x64.zip', cudart: 'cudart-llama-bin-win-cuda-13.3-x64.zip', accel: 'cuda' })
    expect(pickAsset(names, win, 'cpu')).toEqual({ bin: 'llama-b1-bin-win-cpu-x64.zip', accel: 'cpu' })
    expect(pickAsset(['llama-b1-bin-win-cuda-13.3-x64.zip'], win, 'cuda')).toEqual({ bin: 'llama-b1-bin-win-cuda-13.3-x64.zip', accel: 'cuda' })
    expect(pickAsset(names, mac, 'metal')).toEqual({ bin: 'llama-b1-bin-macos-arm64.tar.gz', accel: 'metal' })
    expect(pickAsset(names, { os: 'darwin', arch: 'x64' }, 'cpu')).toEqual({ bin: 'llama-b1-bin-macos-x64.tar.gz', accel: 'cpu' })
    expect(pickAsset(['llama-b1-bin-win-cpu-x64.zip'], mac, 'metal')).toBeNull() // never a Windows asset on a Mac
    expect(pickAsset(['llama-b1-bin-macos-x64.tar.gz'], mac, 'metal')).toBeNull() // no Rosetta
    expect(pickAsset(['llama-b1-bin-macos-arm64.tar.gz'], win, 'cuda')).toBeNull()
  })
})

describe('local directory', () => {
  test('preview stages a copy, confirm registers it; the source is untouched', async () => {
    const src = buildDir()
    const { inst, registry } = installer()
    const p = await inst.preview({ kind: 'dir', path: src })
    expect(p).toMatchObject({ kind: 'dir', os: 'win32', arch: 'x64', accel: 'cpu', tag: 'b11146', needsDigestConfirm: false, files: 2 })
    expect(p.version).toContain('build 11146')
    expect(p.warnings).toEqual([])
    expect(registry.list()).toEqual([]) // nothing registered before the confirmation
    const e = inst.confirm(p.stageId, { label: '  My build  ' })
    expect(e).toMatchObject({ label: 'My build', os: 'win32', arch: 'x64', accel: 'cpu', tag: 'b11146', source: { kind: 'dir', from: src } })
    expect(existsSync(join(customDir(data, e.id), 'llama-server.exe'))).toBe(true)
    expect(existsSync(join(customDir(data, e.id), 'ggml-base.dll'))).toBe(true)
    expect(registry.list().map(x => x.id)).toEqual([e.id])
    expect(leftovers()).toEqual([])
    expect(existsSync(join(src, 'llama-server.exe'))).toBe(true)
  })
  test('ggml-cuda next to the executable marks it as a CUDA build; a build without libraries is warned about', async () => {
    const { inst } = installer()
    const cuda = await inst.preview({ kind: 'dir', path: buildDir('c', win, peX64(), { 'ggml-cuda.dll': 'x' }) })
    expect(cuda.accel).toBe('cuda')
    const bare = await inst.preview({ kind: 'dir', path: buildDir('b', win, peX64(), {}) })
    expect(bare.warnings).toContain('no-shared-libs')
  })
  test('the executable inside a single top-level folder is found', async () => {
    const outer = join(work, 'outer')
    mkdirSync(join(outer, 'inner'), { recursive: true })
    writeFileSync(join(outer, 'inner', 'llama-server.exe'), peX64())
    const { inst } = installer()
    const p = await inst.preview({ kind: 'dir', path: outer })
    const e = inst.confirm(p.stageId)
    expect(existsSync(join(customDir(data, e.id), 'llama-server.exe'))).toBe(true)
  })
  test('failures leave nothing behind: no server, wrong platform, cannot run, not found, not a directory', async () => {
    const empty = join(work, 'empty')
    mkdirSync(empty)
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['no-server-exe', () => installer().inst.preview({ kind: 'dir', path: empty })],
      ['wrong-platform', () => installer().inst.preview({ kind: 'dir', path: buildDir('m', win, machoArm64()) })],
      ['wrong-platform', () => installer().inst.preview({ kind: 'dir', path: buildDir('t', win, Buffer.from('#!/bin/sh')) })],
      ['run-failed', () => installer({ runVersion: async () => { throw new AddError('run-failed', 'x') } }).inst.preview({ kind: 'dir', path: buildDir('r') })],
      ['run-failed', () => installer({ runVersion: async () => 'no version line here' }).inst.preview({ kind: 'dir', path: buildDir('r2') })],
      ['not-found', () => installer().inst.preview({ kind: 'dir', path: join(work, 'nope') })],
      ['bad-source', () => installer().inst.preview({ kind: 'dir', path: join(buildDir('f'), 'llama-server.exe') })],
    ]
    for (const [code, run] of cases) {
      await expect(run()).rejects.toMatchObject({ code })
      expect(leftovers()).toEqual([])
    }
    expect(readdirSync(customBase()).filter(n => !n.startsWith('.'))).toEqual([])
  })
  test('limits: too many files, too large, not enough disk space', async () => {
    const src = buildDir('lim', win, peX64(), { a: '1', b: '2', c: '3' })
    await expect(installer({ limits: { maxFiles: 2 } }).inst.preview({ kind: 'dir', path: src })).rejects.toMatchObject({ code: 'too-large' })
    await expect(installer({ limits: { maxTreeBytes: 10 } }).inst.preview({ kind: 'dir', path: src })).rejects.toMatchObject({ code: 'too-large' })
    await expect(installer({ freeBytes: () => 10 }).inst.preview({ kind: 'dir', path: src })).rejects.toMatchObject({ code: 'disk-space' })
    expect(leftovers()).toEqual([])
  })
  test('a link that leaves the directory is refused (when the system allows creating one)', async () => {
    const src = buildDir('lnk')
    const outside = join(work, 'outside.txt')
    writeFileSync(outside, 'secret')
    try { symlinkSync(outside, join(src, 'evil.dll')) } catch { return } // no privilege to create links: nothing to test
    await expect(installer().inst.preview({ kind: 'dir', path: src })).rejects.toMatchObject({ code: 'unsafe' })
    expect(leftovers()).toEqual([])
  })
  test('one stage at a time: a new preview discards the old one; confirming a stale id fails', async () => {
    const { inst, registry } = installer()
    const a = await inst.preview({ kind: 'dir', path: buildDir('a') })
    const b = await inst.preview({ kind: 'dir', path: buildDir('b') })
    expect(leftovers().length).toBe(1)
    expect(() => inst.confirm(a.stageId)).toThrow(expect.objectContaining({ code: 'stale-stage' }))
    inst.cancel(b.stageId)
    expect(leftovers()).toEqual([])
    expect(() => inst.confirm(b.stageId)).toThrow(expect.objectContaining({ code: 'stale-stage' }))
    expect(registry.list()).toEqual([])
  })
  test('a staged preview expires', async () => {
    let now = 1_000
    const { inst } = installer({ now: () => now })
    const p = await inst.preview({ kind: 'dir', path: buildDir() })
    now += 31 * 60_000
    expect(() => inst.confirm(p.stageId)).toThrow(expect.objectContaining({ code: 'stale-stage' }))
    expect(leftovers()).toEqual([])
  })
  test('a registry that cannot be written: the copy is rolled back', async () => {
    const { inst, registry } = installer()
    const p = await inst.preview({ kind: 'dir', path: buildDir() })
    registry.add = () => { throw new Error('disk full') }
    expect(() => inst.confirm(p.stageId)).toThrow(expect.objectContaining({ code: 'failed' }))
    expect(readdirSync(customBase()).filter(n => !n.startsWith('.'))).toEqual([])
  })
  test('startup clears staging and trash leftovers', () => {
    mkdirSync(join(customBase(), '.stage-1', 'out'), { recursive: true })
    mkdirSync(join(customBase(), '.del-r1-1-1'), { recursive: true })
    mkdirSync(join(customBase(), 'rabc'), { recursive: true })
    installer().inst.clearLeftovers()
    expect(readdirSync(customBase())).toEqual(['rabc'])
  })
})

describe('local archive', () => {
  const fakeExtract = (header = peX64(), t = win) => async (_file: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, exeName(t)), header)
    writeFileSync(join(dest, 'ggml-base.dll'), 'x')
  }
  test('extracted, checked, previewed and registered; the SHA-256 is shown', async () => {
    const zip = join(work, 'llama-b1-bin-win-cpu-x64.zip')
    writeFileSync(zip, 'ZIPDATA')
    const { inst } = installer({ extract: fakeExtract() })
    const p = await inst.preview({ kind: 'archive', path: zip })
    expect(p.digests).toEqual([{ name: 'llama-b1-bin-win-cpu-x64.zip', sha256: sha('ZIPDATA'), verified: false }])
    expect(p.needsDigestConfirm).toBe(false) // a file the user picked themselves
    const e = inst.confirm(p.stageId)
    expect(e.source.kind).toBe('archive')
    expect(e.sha256).toBe(sha('ZIPDATA'))
  })
  test('unsupported name, missing file, failing extraction, wrong platform', async () => {
    const txt = join(work, 'a.rar')
    writeFileSync(txt, 'x')
    await expect(installer().inst.preview({ kind: 'archive', path: txt })).rejects.toMatchObject({ code: 'bad-source' })
    await expect(installer().inst.preview({ kind: 'archive', path: join(work, 'nope.zip') })).rejects.toMatchObject({ code: 'not-found' })
    const zip = join(work, 'a.zip')
    writeFileSync(zip, 'x')
    const { RuntimeError } = await import('../../server/core/llamacpp')
    await expect(installer({ extract: async () => { throw new RuntimeError('extract-failed', 'Unsafe archive path') } }).inst.preview({ kind: 'archive', path: zip })).rejects.toMatchObject({ code: 'unsafe' })
    await expect(installer({ extract: fakeExtract(machoArm64(), win) }).inst.preview({ kind: 'archive', path: zip })).rejects.toMatchObject({ code: 'wrong-platform' })
    expect(leftovers()).toEqual([])
  })
  test('cancel while extracting aborts it: no preview, no leftovers, nothing to confirm, and the next add works', async () => {
    const zip = join(work, 'a.zip')
    writeFileSync(zip, 'ZIPDATA')
    let calls = 0, sawAbort = false
    const { inst } = installer({
      extract: async (_f, dest, o) => {
        if (++calls === 1) {
          await new Promise<void>(r => o?.signal?.addEventListener('abort', () => { sawAbort = true; r() }, { once: true }))
        }
        mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, exeName(win)), peX64())
      },
    })
    const settled = inst.preview({ kind: 'archive', path: zip }).then(() => 'ok', (e: AddError) => e.code)
    await new Promise(r => setTimeout(r, 30))
    inst.cancel()
    expect(await settled).toBe('cancelled')
    expect(sawAbort).toBe(true)
    expect(leftovers()).toEqual([])
    expect(() => inst.confirm('anything')).toThrow()
    const p = await inst.preview({ kind: 'archive', path: zip }) // the same installer is usable again
    expect(p.version).toContain('11146')
    expect(inst.confirm(p.stageId).id).toBeTruthy()
  })
  test('cancel while the version probe runs: the probe is told to stop and its result is not published', async () => {
    const dir = buildDir('cancelprobe')
    let calls = 0, probeSignal: AbortSignal | undefined, release: () => void = () => {}
    const { inst } = installer({
      runVersion: async (_e, _c, _t, signal) => {
        if (++calls === 1) { probeSignal = signal; await new Promise<void>((r) => { release = r }) }
        return VERSION
      },
    })
    const settled = inst.preview({ kind: 'dir', path: dir }).then(() => 'ok', (e: AddError) => e.code)
    await new Promise(r => setTimeout(r, 30))
    inst.cancel()
    expect(probeSignal?.aborted).toBe(true)
    release() // a probe that ignores the signal and still returns a version
    expect(await settled).toBe('cancelled')
    expect(leftovers()).toEqual([])
    const p = await inst.preview({ kind: 'dir', path: dir })
    expect(p.version).toContain('11146')
  })
  test('too little free disk space (3x the archive) is refused before extracting', async () => {
    const zip = join(work, 'a.zip')
    writeFileSync(zip, '0123456789')
    let extracted = false
    const { inst } = installer({ freeBytes: () => 29, extract: async () => { extracted = true } })
    await expect(inst.preview({ kind: 'archive', path: zip })).rejects.toMatchObject({ code: 'disk-space' })
    expect(extracted).toBe(false)
  })
  test.skipIf(process.platform !== 'win32')('a real zip is unpacked with the system tool and passes every check', async () => {
    const src = buildDir('realzip')
    const zip = join(work, 'real.zip')
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    expect(spawnSync(tar, ['-a', '-cf', zip, '-C', src, 'llama-server.exe', 'ggml-base.dll'], { stdio: 'ignore' }).status).toBe(0)
    const { inst } = installer()
    const p = await inst.preview({ kind: 'archive', path: zip })
    expect(p.files).toBe(2)
    const e = inst.confirm(p.stageId)
    expect(existsSync(join(customDir(data, e.id), 'llama-server.exe'))).toBe(true)
  }, 30_000)
  test.skipIf(process.platform !== 'win32')('a real .tar.gz is unpacked the same way', async () => {
    const src = buildDir('realtgz')
    const tgz = join(work, 'real.tar.gz')
    const tar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
    expect(spawnSync(tar, ['-czf', tgz, '-C', src, 'llama-server.exe', 'ggml-base.dll'], { stdio: 'ignore' }).status).toBe(0)
    const p = await installer().inst.preview({ kind: 'archive', path: tgz })
    expect(p.files).toBe(2)
  }, 30_000)
})

describe('GitHub release', () => {
  const BIN = 'llama-b9-bin-win-cuda-13.3-x64.zip'
  const RT = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  const bodies: Record<string, string> = { [BIN]: 'BIN', [RT]: 'RT' }
  const releaseUrl = (n: string) => `https://github.com/o/r/releases/download/b9/${n}`
  function fake(over: { digests?: Record<string, string | null>, assets?: Array<Record<string, unknown>>, apiFail?: boolean } = {}) {
    const calls: string[] = []
    const asset = (n: string) => ({ name: n, browser_download_url: releaseUrl(n), size: bodies[n]!.length, digest: n in (over.digests ?? {}) ? over.digests![n] : `sha256:${sha(bodies[n]!)}` })
    const fetchFn = async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://api.github.com/repos/o/r/releases/')) {
        if (over.apiFail) throw new Error('offline')
        return Response.json({ assets: over.assets ?? [asset(BIN), asset(RT)] })
      }
      const name = url.replace(/^.*\//, '')
      return name in bodies ? new Response(bodies[name]) : new Response('no', { status: 404 })
    }
    return { fetchFn, calls }
  }
  const extract = async (file: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    if (file.includes('cudart')) writeFileSync(join(dest, 'cudart64_13.dll'), 'x')
    else { writeFileSync(join(dest, 'llama-server.exe'), peX64()); writeFileSync(join(dest, 'ggml-cuda.dll'), 'x') }
  }

  test('latest release: assets picked for the host, verified against the published digest, then registered', async () => {
    const f = fake()
    const { inst } = installer({ fetch: f.fetchFn, extract })
    const p = await inst.preview({ kind: 'github', url: 'https://github.com/o/r' })
    expect(f.calls[0]).toBe('https://api.github.com/repos/o/r/releases/latest')
    expect(p).toMatchObject({ kind: 'github', accel: 'cuda', source: 'https://github.com/o/r', needsDigestConfirm: false })
    expect(p.digests).toEqual([{ name: BIN, sha256: sha('BIN'), verified: true }, { name: RT, sha256: sha('RT'), verified: true }])
    expect(inst.confirm(p.stageId).source).toEqual({ kind: 'github', from: 'https://github.com/o/r' })
    expect(leftovers()).toEqual([])
  })
  test('a tag page reads that tag', async () => {
    const f = fake()
    await installer({ fetch: f.fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://github.com/o/r/releases/tag/b9' })
    expect(f.calls[0]).toBe('https://api.github.com/repos/o/r/releases/tags/b9')
  })
  test('without a published digest the computed value is shown and the confirmation must accept it', async () => {
    const f = fake({ digests: { [BIN]: null } })
    const { inst, registry } = installer({ fetch: f.fetchFn, extract })
    const p = await inst.preview({ kind: 'github', url: 'https://github.com/o/r' })
    expect(p.needsDigestConfirm).toBe(true)
    expect(p.digests[0]).toEqual({ name: BIN, sha256: sha('BIN'), verified: false })
    expect(() => inst.confirm(p.stageId)).toThrow(expect.objectContaining({ code: 'needs-digest-confirm' }))
    expect(() => inst.confirm(p.stageId, { acceptUnverified: false })).toThrow(expect.objectContaining({ code: 'needs-digest-confirm' }))
    expect(registry.list()).toEqual([])
    inst.confirm(p.stageId, { acceptUnverified: true })
    expect(registry.list().length).toBe(1)
  })
  test('a published digest that does not match is refused and nothing is kept', async () => {
    const f = fake({ digests: { [BIN]: `sha256:${sha('OTHER')}` } })
    await expect(installer({ fetch: f.fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://github.com/o/r' })).rejects.toMatchObject({ code: 'digest-mismatch' })
    expect(leftovers()).toEqual([])
  })
  test('CUDA build without a cudart is allowed with a warning', async () => {
    const f = fake({ assets: [{ name: BIN, browser_download_url: releaseUrl(BIN), size: 3, digest: `sha256:${sha('BIN')}` }] })
    const p = await installer({ fetch: f.fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://github.com/o/r' })
    expect(p.warnings).toContain('no-cudart')
  })
  test('CPU build on request', async () => {
    const CPU = 'llama-b9-bin-win-cpu-x64.zip'
    bodies[CPU] = 'CPU'
    const f = fake({ assets: [{ name: CPU, browser_download_url: releaseUrl(CPU), size: 3, digest: `sha256:${sha('CPU')}` }] })
    const p = await installer({ fetch: f.fetchFn, extract: async (_f, d) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'llama-server.exe'), peX64()) } }).inst.preview({ kind: 'github', url: 'https://github.com/o/r', accel: 'cpu' })
    expect(p.accel).toBe('cpu')
    delete bodies[CPU]
  })
  test('no asset for this computer, offline, download address outside github.com, oversized download', async () => {
    const mine = installer({ fetch: fake({ assets: [{ name: 'llama-b9-bin-macos-arm64.tar.gz', browser_download_url: releaseUrl('x.tar.gz') }] }).fetchFn, extract })
    await expect(mine.inst.preview({ kind: 'github', url: 'https://github.com/o/r' })).rejects.toMatchObject({ code: 'no-asset' })
    await expect(installer({ fetch: fake({ apiFail: true }).fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://github.com/o/r' })).rejects.toMatchObject({ code: 'network' })
    const evil = fake({ assets: [{ name: BIN, browser_download_url: `https://evil.test/${BIN}`, size: 3, digest: `sha256:${sha('BIN')}` }] })
    await expect(installer({ fetch: evil.fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://github.com/o/r' })).rejects.toMatchObject({ code: 'bad-url' })
    expect(evil.calls.some(c => c.includes('evil.test'))).toBe(false)
    const big = fake({ assets: [{ name: BIN, browser_download_url: releaseUrl(BIN), size: 5_000, digest: `sha256:${sha('BIN')}` }] })
    await expect(installer({ fetch: big.fetchFn, extract, limits: { maxDownloadBytes: 1_000 } }).inst.preview({ kind: 'github', url: 'https://github.com/o/r' })).rejects.toMatchObject({ code: 'too-large' })
    await expect(installer({ fetch: fake().fetchFn, extract }).inst.preview({ kind: 'github', url: 'https://example.com/o/r' })).rejects.toMatchObject({ code: 'bad-url' })
    expect(leftovers()).toEqual([])
  })
})

describe('macOS host', () => {
  const macExtract = (header: Buffer) => async (_f: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'llama-server'), header)
    writeFileSync(join(dest, 'libggml.dylib'), 'x')
  }
  test('an arm64 Mach-O build is accepted as a Metal build; the quarantine attribute is cleared', async () => {
    const zip = join(work, 'llama-b9-bin-macos-arm64.tar.gz')
    writeFileSync(zip, 'x')
    let cleared = ''
    const { inst } = installer({ extract: macExtract(machoArm64()), clearQuarantine: async (d) => { cleared = d } }, mac)
    const p = await inst.preview({ kind: 'archive', path: zip })
    expect(p).toMatchObject({ os: 'darwin', arch: 'arm64', accel: 'metal' })
    expect(cleared).not.toBe('')
  })
  test('a Windows build, and an Intel build, are refused on Apple silicon', async () => {
    const zip = join(work, 'a.tar.gz')
    writeFileSync(zip, 'x')
    await expect(installer({ extract: macExtract(peX64()) }, mac).inst.preview({ kind: 'archive', path: zip })).rejects.toMatchObject({ code: 'wrong-platform' })
    await expect(installer({ extract: macExtract(machoX64()) }, mac).inst.preview({ kind: 'archive', path: zip })).rejects.toMatchObject({ code: 'wrong-platform' })
    expect(leftovers()).toEqual([])
  })
})
