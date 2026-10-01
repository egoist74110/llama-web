import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionsDir, type RuntimeStatus } from '../../server/core/llamacpp'
import { pruneCandidates, UpdateError, Updater, versionOfExe, type PruneResult } from '../../server/core/updater'
import { EXE, fakeExtract, fakeGithub, sha, type FakeOpts } from '../fixtures/fake-github'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-upd-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const dirOf = (tag: string) => join(versionsDir(data), tag)
function install(...tags: string[]) {
  for (const t of tags) {
    mkdirSync(dirOf(t), { recursive: true })
    writeFileSync(join(dirOf(t), EXE), '')
  }
}
const entries = () => readdirSync(versionsDir(data)).sort()

function setup(o: { current?: string, autoUpdate?: boolean, keep?: number, used?: string[], gh?: FakeOpts } = {}) {
  const cfg = { cudaRuntime: '13.3', current: o.current ?? '', keepVersions: o.keep ?? 2, autoUpdate: o.autoUpdate ?? true }
  const gh = fakeGithub(o.gh)
  const statuses: RuntimeStatus[] = []
  const prunes: PruneResult[] = []
  const used = { exes: (o.used ?? []).map(t => join(dirOf(t), EXE)) }
  const u = new Updater({
    dataDir: data, platform: 'win32', fetch: gh.fetchFn, extract: fakeExtract(),
    llamacpp: () => cfg,
    setCurrent: (t) => { cfg.current = t },
    usedExes: () => used.exes,
    onStatus: s => statuses.push(s),
    onPrune: r => prunes.push(r),
  })
  return { u, cfg, gh, statuses, prunes, used }
}

test('nothing installed, auto update off: disabled, no network', async () => {
  const { u, gh } = setup({ autoUpdate: false })
  expect(await u.run()).toEqual({ state: 'disabled' })
  expect(gh.calls).toEqual([])
})

test('auto update off keeps / adopts an installed version without checking', async () => {
  install('b100', 'b200')
  const { u, cfg, gh } = setup({ autoUpdate: false, current: 'b999' })
  expect(await u.run()).toEqual({ state: 'ready', tag: 'b200', note: 'auto-off' })
  expect(cfg.current).toBe('b200')
  expect(gh.calls).toEqual([])
})

test('first start: downloads the latest and makes it current', async () => {
  const { u, cfg, statuses } = setup({ gh: { tag: 'b300' } })
  expect(await u.run()).toEqual({ state: 'ready', tag: 'b300', note: 'updated', from: null, latest: 'b300' })
  expect(cfg.current).toBe('b300')
  expect(statuses.some(s => s.state === 'working' && s.step === 'download' && s.tag === 'b300')).toBe(true)
  expect(existsSync(join(dirOf('b300'), 'cudart64_13.dll'))).toBe(true)
})

test('new release: installs it, switches current, keeps the previous one for rollback', async () => {
  install('b100', 'b200')
  const { u, cfg } = setup({ current: 'b200', gh: { tag: 'b300' } })
  expect(await u.run()).toEqual({ state: 'ready', tag: 'b300', note: 'updated', from: 'b200', latest: 'b300' })
  expect(cfg.current).toBe('b300')
  expect(entries()).toEqual(['b200', 'b300']) // b100 pruned (keep 2)
  expect(u.versions()).toEqual([
    { tag: 'b300', current: true, inUse: false },
    { tag: 'b200', current: false, inUse: false },
  ])
  expect(u.rollbackTarget()).toBe('b200')
})

test('current is the latest: no download, nothing changes', async () => {
  install('b200', 'b300')
  const { u, cfg, gh } = setup({ current: 'b300', gh: { tag: 'b300' } })
  expect(await u.run()).toEqual({ state: 'ready', tag: 'b300', note: 'latest', latest: 'b300' })
  expect(gh.downloads()).toEqual([])
  expect(cfg.current).toBe('b300')
  expect(entries()).toEqual(['b200', 'b300'])
})

test('a version rolled back to stays current on the next start (latest already installed)', async () => {
  install('b100', 'b200', 'b300')
  const { u, cfg } = setup({ current: 'b100', gh: { tag: 'b300' } })
  expect(await u.run()).toEqual({ state: 'ready', tag: 'b100', note: 'pinned', latest: 'b300' })
  expect(cfg.current).toBe('b100')
  // The newest 2 are kept, and current is never removed even when it is beyond keepVersions.
  expect(entries()).toEqual(['b100', 'b200', 'b300'])
  expect(u.rollbackTarget()).toBeNull() // current is not the newest: no "roll back" hint
})

test('version directory used by a running llama-server is not removed', async () => {
  install('b100', 'b200')
  const s = setup({ current: 'b200', used: ['b100'], gh: { tag: 'b300' } })
  await s.u.run()
  expect(entries()).toEqual(['b100', 'b200', 'b300'])
  expect(s.u.versions().find(v => v.tag === 'b100')?.inUse).toBe(true)
  // Once it has stopped, the next prune removes it.
  s.used.exes = []
  expect(s.u.prune()).toEqual({ removed: ['b100'], failed: [] })
  expect(entries()).toEqual(['b200', 'b300'])
  expect(s.prunes.at(-1)).toEqual({ removed: ['b100'], failed: [] })
})

test('keepVersions below 2 still keeps 2; larger values keep more', async () => {
  expect(pruneCandidates(['b4', 'b3', 'b2', 'b1'], 0, new Set())).toEqual(['b2', 'b1'])
  expect(pruneCandidates(['b4', 'b3', 'b2', 'b1'], 3, new Set())).toEqual(['b1'])
  expect(pruneCandidates(['b4', 'b3', 'b2', 'b1'], Number.NaN, new Set(['b1']))).toEqual(['b2'])
})

test('network failure: error status with the version still in use, nothing changed', async () => {
  install('b100')
  const { u, cfg } = setup({ current: 'b100', gh: { fail: 'api.github.com' } })
  expect(await u.run()).toMatchObject({ state: 'error', code: 'network', using: 'b100' })
  expect(cfg.current).toBe('b100')
  expect(entries()).toEqual(['b100'])
})

test('failed download (SHA-256 mismatch) leaves no half version and keeps the old one current', async () => {
  install('b100')
  const bin = 'llama-b300-bin-win-cuda-13.3-x64.zip'
  const { u, cfg } = setup({ current: 'b100', gh: { tag: 'b300', bodies: { [bin]: 'TAMPERED' }, digests: { [bin]: `sha256:${sha('BIN-ZIP')}` } } })
  expect(await u.run()).toMatchObject({ state: 'error', code: 'digest-mismatch', using: 'b100' })
  expect(cfg.current).toBe('b100')
  expect(entries()).toEqual(['b100'])
})

test('nothing installed and the download fails: error without a usable version', async () => {
  const { u } = setup({ gh: { fail: 'dl.test/llama-' } })
  expect(await u.run()).toMatchObject({ state: 'error', code: 'network', using: null })
  expect(entries()).toEqual([])
})

test('loads during the download keep using the old version; a version picked meanwhile wins', async () => {
  install('b100', 'b200')
  let seenCurrent = ''
  const s = setup({
    current: 'b200',
    gh: {
      tag: 'b300',
      onDownload: () => {
        seenCurrent ||= s.cfg.current
        s.u.use('b100') // user rolls back while the download runs
      },
    },
  })
  expect(await s.u.run()).toEqual({ state: 'ready', tag: 'b100', note: 'pinned', latest: 'b300' })
  expect(seenCurrent).toBe('b200')
  expect(s.cfg.current).toBe('b100')
  expect(existsSync(join(dirOf('b300'), EXE))).toBe(true)
})

test('use(): only installed versions; bad tags refused', () => {
  install('b100', 'b200')
  const { u, cfg } = setup({ current: 'b200' })
  expect(u.use('b100')).toBe('b100')
  expect(cfg.current).toBe('b100')
  expect(() => u.use('b999')).toThrow(UpdateError)
  expect(() => u.use('../b100')).toThrow(UpdateError)
  expect(() => u.use(42)).toThrow(UpdateError)
  try { u.use('b999') } catch (e) { expect((e as UpdateError).code).toBe('not-installed') }
  expect(cfg.current).toBe('b100')
})

test('rollbackTarget: newest older version while current is the newest', () => {
  install('b100', 'b200', 'b300')
  expect(setup({ current: 'b300' }).u.rollbackTarget()).toBe('b200')
  expect(setup({ current: 'b200' }).u.rollbackTarget()).toBeNull()
  rmSync(versionsDir(data), { recursive: true })
  install('b300')
  expect(setup({ current: 'b300' }).u.rollbackTarget()).toBeNull()
})

test('run() is single flight', async () => {
  const { u, gh } = setup({ gh: { tag: 'b300' } })
  const [a, b] = await Promise.all([u.run(), u.run()])
  expect(a).toEqual(b)
  expect(gh.downloads().length).toBe(2) // bin + cudart once
})

test('leftovers of interrupted installs / removals are cleared at the next start', async () => {
  install('b100')
  mkdirSync(join(versionsDir(data), '.tmp-b300-1', 'out'), { recursive: true })
  mkdirSync(join(versionsDir(data), '.del-b50-1-2'), { recursive: true })
  await setup({ current: 'b100', autoUpdate: false }).u.run()
  expect(entries()).toEqual(['b100'])
})

test('versionOfExe: only executables inside a version directory', () => {
  const base = versionsDir(data)
  expect(versionOfExe(data, join(base, 'b100', EXE), 'win32')).toBe('b100')
  expect(versionOfExe(data, join(base, 'b100', EXE).toUpperCase(), 'win32')).toBe('b100')
  expect(versionOfExe(data, join(base, 'notes', EXE), 'win32')).toBeNull()
  expect(versionOfExe(data, join(data, 'elsewhere', 'b100', EXE), 'win32')).toBeNull()
})

test.skipIf(process.platform !== 'win32')('a directory held open by an unknown process is left intact', async () => {
  install('b100', 'b200', 'b300')
  // A process whose working directory is inside b100 (like a llama-server we did not start).
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: dirOf('b100'), stdio: 'ignore' })
  try {
    await new Promise(r => setTimeout(r, 500))
    const { u } = setup({ current: 'b300' })
    const r = u.prune()
    expect(r.removed).toEqual([])
    expect(r.failed.map(f => f.tag)).toEqual(['b100'])
    expect(existsSync(join(dirOf('b100'), EXE))).toBe(true)
  } finally {
    child.kill()
    await new Promise(r => child.once('exit', r))
  }
}, 30_000)
