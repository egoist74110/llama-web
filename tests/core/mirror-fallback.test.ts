// GitHub API limits and unreachable github.com (decision 53): the github.com pages as a fallback for
// release metadata, and public mirrors offered only after a user-started update failed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppUpdater } from '../../server/core/app-update'
import { htmlToText, parseExpandedAssets, parseReleasesAtom } from '../../server/core/github-feed'
import { resolveLatest, type FetchFn, type RuntimeStatus } from '../../server/core/llamacpp'
import { MIRRORS, mirrorById, mirrorFetch, offeredMirrors } from '../../server/core/mirrors'
import type { RuntimeTarget } from '../../server/core/platform'
import { Updater } from '../../server/core/updater'

const LLAMA = 'ggml-org/llama.cpp'
const APP = 'example-org/llama-web'
const HEX = (c: string) => c.repeat(64)
const MAC: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-mirror-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

/** The shape of GitHub's expanded-assets fragment (names, links and digests). */
function assetsHtml(repo: string, tag: string, assets: Array<{ name: string, digest?: string }>) {
  return assets.map(a => `
    <a href="/${repo}/releases/download/${tag}/${a.name}" rel="nofollow" class="wb-break-all"><span>${a.name}</span></a>
    ${a.digest ? `<span class="Truncate-text">${a.digest}</span>
    <clipboard-copy id="clipboard-button-${a.digest}" aria-label="Copy to clipboard digest for ${a.name}" type="button" value="${a.digest}"></clipboard-copy>` : ''}`).join('\n')
}
const atom = (repo: string, entries: Array<{ tag: string, title: string, body: string, at: string }>) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes</title>${entries.map(e => `
  <entry><id>tag:github.com,2008:Repository/1/${e.tag}</id><updated>${e.at}</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${repo}/releases/tag/${e.tag}"/>
    <title>${e.title}</title><content type="html">${e.body}</content></entry>`).join('')}</feed>`

test('release pages are parsed: assets with their digests, feed entries with plain-text notes', () => {
  const tag = 'b200'
  const html = assetsHtml(LLAMA, tag, [
    { name: 'llama-b200-bin-macos-arm64.tar.gz', digest: `sha256:${HEX('a')}` },
    { name: 'nightly-tag.txt' },
  ])
  expect(parseExpandedAssets(html, LLAMA, tag)).toEqual([
    { name: 'llama-b200-bin-macos-arm64.tar.gz', browser_download_url: `https://github.com/${LLAMA}/releases/download/b200/llama-b200-bin-macos-arm64.tar.gz`, digest: `sha256:${HEX('a')}` },
    { name: 'nightly-tag.txt', browser_download_url: `https://github.com/${LLAMA}/releases/download/b200/nightly-tag.txt`, digest: null },
  ])
  // Links to other releases or other repositories are not assets of this one.
  expect(parseExpandedAssets('<a href="/other/repo/releases/download/b200/x.zip"></a><a href="/ggml-org/llama.cpp/releases/download/b199/y.zip"></a>', LLAMA, tag)).toEqual([])
  const entries = parseReleasesAtom(atom(APP, [{ tag: 'v0.2.0', title: 'v0.2.0', body: '&lt;p&gt;Fix &amp;amp; polish&lt;/p&gt;&lt;ul&gt;&lt;li&gt;one&lt;/li&gt;&lt;/ul&gt;', at: '2026-10-05T00:00:00Z' }]), APP)
  expect(entries).toEqual([{ tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Fix & polish\n- one', published_at: '2026-10-05T00:00:00Z', html_url: `https://github.com/${APP}/releases/tag/v0.2.0` }])
  expect(htmlToText('&lt;script&gt;x&lt;/script&gt;ok')).toBe('xok')
})

test('mirror redirects are followed by hand: path-absolute ones resolve against the mirror, strange ones are refused', async () => {
  const seen: string[] = []
  const answers: Record<string, Response> = {
    'https://ghfast.top/https://github.com/a/b/releases/latest/download/x.txt': new Response(null, { status: 302, headers: { location: '/https://github.com/a/b/releases/download/v1/x.txt' } }),
    'https://ghfast.top/https://github.com/a/b/releases/download/v1/x.txt': new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/x?sig=1' } }),
    'https://release-assets.githubusercontent.com/x?sig=1': new Response('payload'),
  }
  const inner: FetchFn = async (url, init) => {
    seen.push(`${url} ${init?.redirect}`)
    return answers[url] ?? new Response('no', { status: 404 })
  }
  const res = await mirrorFetch(mirrorById('ghfast')!, inner)('https://github.com/a/b/releases/latest/download/x.txt')
  expect(await res.text()).toBe('payload')
  expect(seen.every(s => s.endsWith(' manual'))).toBe(true)
  const evil: FetchFn = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
  await expect(mirrorFetch(mirrorById('ghfast')!, evil)('https://github.com/a/b/x')).rejects.toThrow()
  const loop: FetchFn = async () => new Response(null, { status: 302, headers: { location: '/https://github.com/a/b/x' } })
  await expect(mirrorFetch(mirrorById('ghfast')!, loop)('https://github.com/a/b/x')).rejects.toThrow()
})

test('mirrors take GitHub URLs only and are listed in recommended order', () => {
  const seen: string[] = []
  const inner: FetchFn = async (url) => { seen.push(url); return new Response('ok') }
  const m = mirrorById('ghfast')!
  const f = mirrorFetch(m, inner)
  return f('https://github.com/a/b/releases/latest/download/x.txt').then(async () => {
    expect(seen).toEqual(['https://ghfast.top/https://github.com/a/b/releases/latest/download/x.txt'])
    await expect(f('https://evil.example/x')).rejects.toThrow()
    await expect(f('http://github.com/x')).rejects.toThrow()
    await expect(f('https://user:pw@github.com/x')).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(offeredMirrors().map(x => x.id)).toEqual([MIRRORS[0]!.id, MIRRORS[1]!.id])
    expect(mirrorById('nope')).toBeNull()
  })
})

/** A fake of the llama.cpp release: API answers rate-limited, the github.com pages work. */
function llamaWeb(o: { api?: 'limited' | 'offline' | 'ok', pagesOffline?: boolean } = {}) {
  const calls: string[] = []
  const tag = 'b300'
  const fetchFn: FetchFn = async (url) => {
    calls.push(url)
    const direct = url.replace(/^https:\/\/[a-z.-]+\/(?=https:\/\/)/, '')
    const viaMirror = direct !== url
    if (o.pagesOffline && !viaMirror) throw new Error('offline')
    if (direct.startsWith('https://api.github.com/')) {
      if (o.api === 'offline') throw new Error('offline')
      if (o.api !== 'ok') return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      if (direct.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: `https://github.com/${LLAMA}/releases/download/nightly/nightly-tag.txt` }] })
      return Response.json({ assets: [{ name: `llama-${tag}-bin-macos-arm64.tar.gz`, browser_download_url: `https://github.com/${LLAMA}/releases/download/${tag}/llama-${tag}-bin-macos-arm64.tar.gz`, digest: `sha256:${HEX('b')}` }] })
    }
    if (direct.endsWith('/releases/latest/download/nightly-tag.txt') || direct.endsWith('/releases/download/nightly/nightly-tag.txt')) return new Response(`${tag}\n`)
    if (direct.endsWith(`/releases/expanded_assets/${tag}`)) return new Response(assetsHtml(LLAMA, tag, [{ name: `llama-${tag}-bin-macos-arm64.tar.gz`, digest: `sha256:${HEX('c')}` }]))
    return new Response('nope', { status: 404 })
  }
  return { fetchFn, calls, tag }
}

test('llama.cpp metadata falls back to the release pages when the API is rate-limited', async () => {
  const gh = llamaWeb()
  const latest = await resolveLatest(gh.fetchFn, '', 'darwin', {}, MAC)
  expect(latest.tag).toBe('b300')
  expect(latest.bin.digest).toBe(`sha256:${HEX('c')}`)
  expect(gh.calls.some(u => u.includes('expanded_assets'))).toBe(true)
  // A network failure is not worked around (the pages would be unreachable too).
  const dead = llamaWeb({ api: 'offline' })
  await expect(resolveLatest(dead.fetchFn, '', 'darwin', {}, MAC)).rejects.toMatchObject({ code: 'network' })
  expect(dead.calls.some(u => u.includes('expanded_assets'))).toBe(false)
})

function llamaUpdater(fetchFn: FetchFn) {
  const cfg = { cudaRuntime: '', current: '', keepVersions: 2, autoUpdate: false }
  const statuses: RuntimeStatus[] = []
  const u = new Updater({ dataDir: data, platform: 'darwin', target: MAC, fetch: fetchFn, llamacpp: () => cfg, setCurrent: (t) => { cfg.current = t }, usedExes: () => [], onStatus: s => statuses.push(s) })
  return { u, statuses }
}

test('a mirror is offered only when the user started the check or download that failed', async () => {
  const auto = llamaUpdater(llamaWeb({ api: 'offline' }).fetchFn)
  const result = await auto.u.run()
  expect(result).toMatchObject({ state: 'error', code: 'network' })
  expect('offer' in result).toBe(false)
  await auto.u.stop()

  const manual = llamaUpdater(llamaWeb({ api: 'offline' }).fetchFn)
  expect(await manual.u.run({ manual: true })).toMatchObject({ state: 'error', code: 'network', offer: 'check' })
  await manual.u.stop()
  const forced = llamaUpdater(llamaWeb({ api: 'offline' }).fetchFn)
  expect(await forced.u.run({ force: true })).toMatchObject({ state: 'error', offer: 'download' })
  await forced.u.stop()
})

test('a chosen mirror carries the whole manual check: every request goes through it', async () => {
  const gh = llamaWeb({ api: 'limited', pagesOffline: true })
  const { u } = llamaUpdater(gh.fetchFn)
  expect(await u.run({ manual: true })).toMatchObject({ state: 'error', offer: 'check' })
  gh.calls.length = 0
  const done = await u.run({ manual: true, mirror: 'ghfast' })
  expect(done).toMatchObject({ state: 'disabled' })
  expect(u.getUpdateCheck()).toMatchObject({ state: 'checked', tag: 'b300' })
  expect(gh.calls.length).toBeGreaterThan(0)
  expect(gh.calls.every(c => c.startsWith('https://ghfast.top/https://'))).toBe(true)
  await u.stop()
})

/** Our own releases: API limited, feed and release page on github.com. */
function appWeb(o: { pagesOffline?: boolean } = {}) {
  const calls: string[] = []
  const installer = 'llama-web_0.2.0_x64-setup.exe'
  const fetchFn: FetchFn = async (url) => {
    calls.push(url)
    const direct = url.replace(/^https:\/\/[a-z.-]+\/(?=https:\/\/)/, '')
    if (o.pagesOffline && direct === url) throw new Error('offline')
    if (direct.startsWith('https://api.github.com/')) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    if (direct.endsWith('/releases.atom')) return new Response(atom(APP, [{ tag: 'v0.2.0', title: 'llama-web v0.2.0', body: '&lt;p&gt;Notes&lt;/p&gt;', at: '2026-10-05T00:00:00Z' }]))
    if (direct.includes('/releases/expanded_assets/')) return new Response(assetsHtml(APP, 'v0.2.0', [{ name: installer, digest: `sha256:${HEX('d')}` }, { name: 'SHA256SUMS', digest: `sha256:${HEX('e')}` }]))
    return new Response('nope', { status: 404 })
  }
  return { fetchFn, calls }
}

test('llama-web updates are found through the release pages when the API is limited', async () => {
  const web = appWeb()
  const u = new AppUpdater({ current: '0.1.0', repo: APP, dataDir: data, fetch: web.fetchFn, firstCheckMs: 60_000 })
  await u.check()
  expect(u.view().check).toMatchObject({ state: 'available', release: { version: '0.2.0', notes: 'Notes' } })
  u.stop()
})

test('llama-web: the offer appears for a user-started check only, and the mirror finishes it', async () => {
  const web = appWeb({ pagesOffline: true })
  const u = new AppUpdater({ current: '0.1.0', repo: APP, dataDir: data, fetch: web.fetchFn, firstCheckMs: 60_000 })
  await u.check()
  expect(u.view().check).toMatchObject({ state: 'error' })
  expect((u.view().check as { offer?: boolean }).offer).toBeUndefined()
  await u.check({ manual: true })
  expect(u.view().check).toMatchObject({ state: 'error', code: 'network', offer: true })
  await u.check({ manual: true, mirror: 'gh-proxy' })
  expect(u.view().check).toMatchObject({ state: 'available', release: { version: '0.2.0' } })
  u.stop()
})
