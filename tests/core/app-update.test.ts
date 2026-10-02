import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_REPO, APP_VERSION } from '../../server/core/app-info'
import { AppUpdater, compareVersions, pickUpdate, sumFor, type GithubRelease, type InstallRequest } from '../../server/core/app-update'

const REPO = 'owner/app'
const DL = `https://github.com/${REPO}/releases/download`
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-appupd-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

function release(version: string, o: { draft?: boolean, prerelease?: boolean, body?: string, installer?: string, sums?: string | null, digest?: string | null, host?: string } = {}): GithubRelease {
  const name = `llama-web_${version}_x64-setup.exe`
  const body = o.installer ?? `INSTALLER-${version}`
  const base = o.host ?? `${DL}/v${version}`
  return {
    tag_name: `v${version}`, name: `llama-web v${version}`, body: o.body ?? `notes ${version}`, draft: o.draft ?? false,
    prerelease: o.prerelease ?? version.includes('-'), html_url: `https://github.com/${REPO}/releases/tag/v${version}`, published_at: '2026-10-02T00:00:00Z',
    assets: [
      { name, browser_download_url: `${base}/${name}`, digest: o.digest === undefined ? `sha256:${sha(body)}` : o.digest },
      ...(o.sums === null ? [] : [{ name: 'SHA256SUMS', browser_download_url: `${base}/SHA256SUMS` }]),
    ],
  }
}

/** Fake GitHub: the release list plus asset bodies keyed by URL. */
function fakeFeed(list: GithubRelease[], bodies: Record<string, string> = {}, o: { offline?: boolean } = {}) {
  const calls: string[] = []
  const files: Record<string, string> = { ...bodies }
  for (const r of list) {
    const v = r.tag_name!.slice(1)
    for (const a of r.assets ?? []) {
      if (a.name === 'SHA256SUMS') files[a.browser_download_url] ??= `${sha(`INSTALLER-${v}`)}  llama-web_${v}_x64-setup.exe\n`
      else files[a.browser_download_url] ??= `INSTALLER-${v}`
    }
  }
  const fetchFn = async (url: string) => {
    calls.push(url)
    if (o.offline) throw new Error('offline')
    if (url.includes('/releases?per_page=')) return Response.json(list)
    if (url in files) return new Response(files[url])
    return new Response('nope', { status: 404 })
  }
  return { fetchFn, calls, files }
}

function updater(current: string, feed: ReturnType<typeof fakeFeed>, desktop = true) {
  let changes = 0
  const installs: InstallRequest[] = []
  const u = new AppUpdater({ current, repo: REPO, dataDir: data, fetch: feed.fetchFn, onChange: () => { changes++ }, firstCheckMs: 60_000, everyMs: 60_000 })
  if (desktop) u.setInstaller(r => installs.push(r))
  return { u, installs, changes: () => changes }
}

test('package metadata gives the version and the GitHub repository', () => {
  expect(compareVersions(APP_VERSION, '0.0.0')).toBeGreaterThan(0)
  expect(APP_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/)
})

test('SemVer precedence including prerelease identifiers', () => {
  const order = ['0.0.9', '0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '1.0.0']
  for (let i = 0; i < order.length - 1; i++) {
    expect(compareVersions(order[i]!, order[i + 1]!)).toBeLessThan(0)
    expect(compareVersions(order[i + 1]!, order[i]!)).toBeGreaterThan(0)
  }
  expect(compareVersions('0.1.0-beta.1', '0.1.0-beta.1')).toBe(0)
  expect(compareVersions('garbage', '0.0.1')).toBeLessThan(0)
})

test('pickUpdate: newest newer release; drafts and invalid tags never; stable stays on stable', () => {
  const ok = (u: string) => u.startsWith(DL)
  const list = [release('0.2.0', { draft: true }), release('0.1.0-beta.3'), release('0.1.0-beta.2'), { tag_name: 'nightly' }, release('0.0.9')]
  expect(pickUpdate(list, '0.1.0-beta.1', ok)?.version).toBe('0.1.0-beta.3')
  expect(pickUpdate(list, '0.1.0-beta.3', ok)).toBeNull()
  // A stable version is not offered prereleases, only newer stable releases.
  expect(pickUpdate(list, '0.0.8', ok)?.version).toBe('0.0.9')
  expect(pickUpdate([...list, release('0.1.0')], '0.1.0-beta.1', ok)?.version).toBe('0.1.0')
  const c = pickUpdate(list, '0.1.0-beta.1', ok)!
  expect(c.notes).toBe('notes 0.1.0-beta.3')
  expect(c.installer?.name).toBe('llama-web_0.1.0-beta.3_x64-setup.exe')
  expect(c.sums?.name).toBe('SHA256SUMS')
  // Assets outside the project's release downloads are ignored.
  expect(pickUpdate([release('0.1.0-beta.3', { host: 'https://example.com/x' })], '0.1.0-beta.1', ok)!.installer).toBeNull()
})

test('sumFor reads sha256sum lines', () => {
  const h = sha('x')
  expect(sumFor(`${h.toUpperCase()}  a.exe\n${sha('y')} *b.exe\n`, 'a.exe')).toBe(h)
  expect(sumFor(`${h}  a.exe`, 'b.exe')).toBeNull()
  expect(sumFor('junk', 'a.exe')).toBeNull()
})

test('check reports latest, available (with notes) and network errors', async () => {
  const none = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.1')]))
  await none.u.check()
  expect(none.u.view().check.state).toBe('latest')
  none.u.stop()

  const avail = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2', { body: '## 新增\n- 更新提示' })]))
  await avail.u.check()
  const v = avail.u.view()
  expect(v.check.state).toBe('available')
  if (v.check.state === 'available') {
    expect(v.check.release.version).toBe('0.1.0-beta.2')
    expect(v.check.release.notes).toContain('更新提示')
    expect(JSON.stringify(v)).not.toContain('browser_download_url')
  }
  expect(avail.changes()).toBeGreaterThan(0)
  avail.u.stop()

  const off = updater('0.1.0-beta.1', fakeFeed([], {}, { offline: true }))
  await off.u.check()
  const e = off.u.view().check
  expect(e.state === 'error' && e.code).toBe('network')
  off.u.stop()
})

test('download verifies digest and SHA256SUMS, install re-checks and hands off to the shell', async () => {
  const { u, installs } = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2')]))
  await u.check()
  await u.download()
  expect(u.view().download).toEqual({ state: 'ready', version: '0.1.0-beta.2' })
  const file = join(u.dir, 'llama-web_0.1.0-beta.2_x64-setup.exe')
  expect(readFileSync(file, 'utf8')).toBe('INSTALLER-0.1.0-beta.2')
  expect(existsSync(`${file}.part`)).toBe(false)
  await u.install()
  expect(installs).toEqual([{ file, sha256: sha('INSTALLER-0.1.0-beta.2'), version: '0.1.0-beta.2' }])
  expect(u.view().download.state).toBe('installing')
  u.stop()
})

test('a replaced installer after download is refused at install time', async () => {
  const { u, installs } = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2')]))
  await u.check()
  await u.download()
  writeFileSync(join(u.dir, 'llama-web_0.1.0-beta.2_x64-setup.exe'), 'EVIL')
  await expect(u.install()).rejects.toMatchObject({ code: 'digest-mismatch' })
  expect(installs).toEqual([])
  expect(u.view().download).toMatchObject({ state: 'error', code: 'digest-mismatch' })
  u.stop()
})

test('download refuses mismatching digests, missing sums and the source version', async () => {
  const r = release('0.1.0-beta.2')
  const sums = r.assets![1]!.browser_download_url
  const wrongSums = updater('0.1.0-beta.1', fakeFeed([r], { [sums]: `${sha('other')}  llama-web_0.1.0-beta.2_x64-setup.exe\n` }))
  await wrongSums.u.check()
  await expect(wrongSums.u.download()).rejects.toMatchObject({ code: 'digest-mismatch' })
  expect(existsSync(wrongSums.u.dir)).toBe(false)
  wrongSums.u.stop()

  const r2 = release('0.1.0-beta.2', { digest: `sha256:${sha('different')}` })
  const s2 = r2.assets![1]!.browser_download_url
  const bad = updater('0.1.0-beta.1', fakeFeed([r2], { [s2]: `${sha('different')}  llama-web_0.1.0-beta.2_x64-setup.exe\n` }))
  await bad.u.check()
  await expect(bad.u.download()).rejects.toMatchObject({ code: 'digest-mismatch' })
  bad.u.stop()

  const noSums = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2', { sums: null })]))
  await noSums.u.check()
  await expect(noSums.u.download()).rejects.toMatchObject({ code: 'no-installer' })
  noSums.u.stop()

  const noDigest = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2', { digest: null })]))
  await noDigest.u.check()
  await expect(noDigest.u.download()).rejects.toMatchObject({ code: 'no-digest' })
  noDigest.u.stop()

  const source = updater('0.1.0-beta.1', fakeFeed([release('0.1.0-beta.2')]), false)
  await source.u.check()
  expect(source.u.view().canInstall).toBe(false)
  await expect(source.u.download()).rejects.toMatchObject({ code: 'not-desktop' })
  await expect(source.u.install()).rejects.toMatchObject({ code: 'not-desktop' })
  source.u.stop()
})

test('preferences persist: skipped version and automatic checks', () => {
  const feed = fakeFeed([])
  const a = updater('0.1.0-beta.1', feed)
  expect(a.u.view()).toMatchObject({ autoCheck: true, skipped: null })
  a.u.setPrefs({ skipped: '0.1.0-beta.2', autoCheck: false })
  a.u.stop()
  const b = updater('0.1.0-beta.1', feed)
  expect(b.u.view()).toMatchObject({ autoCheck: false, skipped: '0.1.0-beta.2' })
  expect(() => b.u.setPrefs({ skipped: 'not a version' })).toThrow()
  b.u.stop()
})

test('feed override only accepts loopback test URLs and then only loopback assets', async () => {
  expect(() => new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, feed: 'https://example.com/releases' })).toThrow()
  const local = 'http://127.0.0.1:9/releases'
  const r = release('0.2.0', { host: 'http://127.0.0.1:9/dl' })
  const feed = fakeFeed([r])
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, feed: local, fetch: feed.fetchFn })
  u.setInstaller(() => {})
  await u.check()
  expect(feed.calls[0]).toBe(`${local}?per_page=30`)
  await u.download()
  expect(u.view().download.state).toBe('ready')
  u.stop()
})

test('start removes installers left by an earlier run', () => {
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, firstCheckMs: 60_000 })
  mkdirSync(u.dir, { recursive: true })
  writeFileSync(join(u.dir, 'old.exe'), 'x')
  u.start()
  expect(existsSync(u.dir)).toBe(false)
  u.stop()
})
