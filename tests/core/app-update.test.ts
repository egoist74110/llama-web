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
  u.setPrefs({ autoUpdate: false }) // Existing cases exercise explicit download/install actions.
  if (desktop) u.setInstaller(r => installs.push(r))
  return { u, installs, changes: () => changes }
}

test('package metadata gives the version and the GitHub repository', () => {
  expect(compareVersions(APP_VERSION, '0.0.0')).toBeGreaterThan(0)
  expect(APP_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/)
})

test('desktop defaults enable daily checks and automatically verify and install a newer release', async () => {
  const feed = fakeFeed([release('0.2.0')])
  const installs: InstallRequest[] = []
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: feed.fetchFn })
  u.setInstaller(r => installs.push(r))
  try {
    expect(u.view()).toMatchObject({ autoCheck: true, autoUpdate: true })
    await u.check()
    expect(feed.calls).toHaveLength(3)
    expect(installs).toEqual([{ file: join(u.dir, 'llama-web_0.2.0_x64-setup.exe'), sha256: sha('INSTALLER-0.2.0'), version: '0.2.0' }])
    expect(u.view().download.state).toBe('installing')
  } finally { u.stop() }
})

test('automatic installation off preserves daily checks and only publishes an available version', async () => {
  const feed = fakeFeed([release('0.2.0')])
  const { u, installs } = updater('0.1.0', feed)
  try {
    u.start()
    await u.check()
    expect(u.view()).toMatchObject({ autoCheck: true, autoUpdate: false, check: { state: 'available' }, download: { state: 'none' } })
    expect(feed.calls).toHaveLength(1)
    expect(installs).toEqual([])
  } finally { u.stop() }
})

test('legacy app preferences migrate to enabled automatic updates with a backup', () => {
  const original = JSON.stringify({ version: 1, autoCheck: false, skipped: '0.2.0' })
  writeFileSync(join(data, 'app-update.json'), original)
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data })
  try {
    expect(u.view()).toMatchObject({ autoCheck: true, autoUpdate: true, skipped: '0.2.0' })
    expect(JSON.parse(readFileSync(join(data, 'app-update.json'), 'utf8')).version).toBe(2)
  } finally { u.stop() }
})

test('automatic installs never hand off a corrupt or skipped release', async () => {
  const feed = fakeFeed([release('0.2.0', { digest: `sha256:${sha('wrong')}` })])
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: feed.fetchFn })
  const installs: InstallRequest[] = []
  u.setInstaller(r => installs.push(r))
  try {
    await u.check()
    expect(u.view().check.state).toBe('available')
    expect(u.view().download).toMatchObject({ state: 'error', code: 'digest-mismatch' })
    expect(installs).toEqual([])
    u.setPrefs({ skipped: '0.2.0' })
    feed.calls.length = 0
    await u.check()
    expect(feed.calls).toHaveLength(1)
    expect(installs).toEqual([])
  } finally { u.stop() }
})

test('turning automatic updates off while downloading prevents installer hand-off', async () => {
  const feed = fakeFeed([release('0.2.0')])
  const installs: InstallRequest[] = []
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: async (url, init) => {
    if (url.endsWith('.exe')) u.setPrefs({ autoUpdate: false })
    return feed.fetchFn(url, init)
  } })
  u.setInstaller(r => installs.push(r))
  try {
    await u.check()
    expect(u.view().download.state).toBe('ready')
    expect(installs).toEqual([])
  } finally { u.stop() }
})

test('shutdown during an automatic download cancels it and never hands off an installer', async () => {
  const feed = fakeFeed([release('0.2.0')])
  const installs: InstallRequest[] = []
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: async (url, init) => {
    if (url.endsWith('.exe')) u.stop()
    return feed.fetchFn(url, init)
  } })
  u.setInstaller(r => installs.push(r))
  try {
    await u.check()
    expect(installs).toEqual([])
    expect(existsSync(u.dir)).toBe(false)
  } finally { u.stop() }
})

test('daily timer keeps checking with automatic installation off and does not download', async () => {
  const feed = fakeFeed([release('0.2.0')])
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: feed.fetchFn, firstCheckMs: 5, everyMs: 30 })
  const installs: InstallRequest[] = []
  u.setInstaller(r => installs.push(r))
  try {
    u.setPrefs({ autoUpdate: false })
    u.start()
    await new Promise(r => setTimeout(r, 90))
    expect(feed.calls.length).toBeGreaterThanOrEqual(2)
    expect(feed.calls.every(url => url.includes('/releases?'))).toBe(true)
    expect(installs).toEqual([])
  } finally { u.stop() }
})

test('installer hand-off failure is reported and does not leave an installing state', async () => {
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: fakeFeed([release('0.2.0')]).fetchFn })
  u.setInstaller(() => { throw new Error('closed channel') })
  try {
    await u.check()
    expect(u.view().download).toMatchObject({ state: 'error', code: 'failed' })
  } finally { u.stop() }
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
  u.setPrefs({ autoUpdate: false })
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

test('automatic application checks survive restart; manual checks can bypass the daily limit', async () => {
  const feed = fakeFeed([release('0.1.0-beta.2')])
  let now = Date.UTC(2026, 9, 3, 12)
  const make = () => new AppUpdater({ current: '0.1.0-beta.1', repo: REPO, dataDir: data, fetch: feed.fetchFn, now: () => now, firstCheckMs: 5 })
  const first = make()
  await first.check()
  first.stop()
  now += 60_000
  const restarted = make()
  try {
    restarted.start()
    await new Promise(r => setTimeout(r, 30))
    expect(feed.calls).toHaveLength(1)
    expect(restarted.view().check).toMatchObject({ state: 'available', release: { version: '0.1.0-beta.2' } })
    await restarted.check()
    expect(feed.calls).toHaveLength(2)
  } finally { restarted.stop() }
})

test('failed application checks count for the daily limit and retry after it expires', async () => {
  const offline = fakeFeed([], {}, { offline: true })
  let now = Date.UTC(2026, 9, 3, 12)
  const opts = { current: '0.1.0', repo: REPO, dataDir: data, now: () => now, firstCheckMs: 5 }
  const first = new AppUpdater({ ...opts, fetch: offline.fetchFn })
  await first.check()
  first.stop()
  now += 60_000
  const feed = fakeFeed([])
  const restarted = new AppUpdater({ ...opts, fetch: feed.fetchFn })
  try {
    restarted.start()
    await new Promise(r => setTimeout(r, 30))
    expect(feed.calls).toEqual([])
    expect(restarted.view().check).toMatchObject({ state: 'error', code: 'network' })
    now += 24 * 60 * 60 * 1000
    restarted.start()
    await new Promise(r => setTimeout(r, 30))
    expect(feed.calls).toHaveLength(1)
    expect(restarted.view().check.state).toBe('latest')
  } finally { restarted.stop() }
})

test('cached application release remains downloadable with checksum verification after restart', async () => {
  const feed = fakeFeed([release('0.1.0-beta.2')])
  const first = updater('0.1.0-beta.1', feed)
  await first.u.check()
  first.u.stop()
  const restarted = updater('0.1.0-beta.1', feed)
  try {
    await restarted.u.download()
    expect(restarted.u.view().download).toEqual({ state: 'ready', version: '0.1.0-beta.2' })
    expect(feed.calls.filter(u => u.includes('/releases?'))).toHaveLength(1)
  } finally { restarted.u.stop() }
})

test('application checks distinguish GitHub rate limits from other HTTP failures', async () => {
  for (const [status, code] of [[429, 'rate-limited'], [503, 'http']] as const) {
    const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: async () => new Response('', { status }) })
    try {
      await u.check()
      expect(u.view().check).toMatchObject({ state: 'error', code })
    } finally { u.stop() }
  }
})

test('stopping a concurrent application check cancels its request and releases its single flight', async () => {
  let calls = 0
  let signal: AbortSignal | undefined
  const u = new AppUpdater({ current: '0.1.0', repo: REPO, dataDir: data, fetch: async (_url, init) => {
    calls++
    signal = init?.signal ?? undefined
    return new Promise<Response>(() => {})
  } })
  const first = u.check()
  expect(u.check()).toBe(first)
  u.stop()
  await first
  expect(calls).toBe(1)
  expect(signal?.aborted).toBe(true)
  await u.check()
  expect(calls).toBe(1)
})
