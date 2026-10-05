// GitHub release metadata without the REST API (which allows only 60 anonymous requests an hour):
// the releases Atom feed, the "latest download" redirect and the expanded-assets page, all on
// github.com. Used when the API answers rate-limited or with an error. Pure parsing + small fetch
// helpers; no Nitro. The pages are HTML meant for browsers, so every parser is tolerant and returns
// less rather than guessing: an asset without a digest is still listed (the download then refuses it).
import { getBody, RuntimeError, type FetchFn, type NetOptions, type ReleaseAsset } from './llamacpp'
import type { GithubRelease } from './app-update'

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const TAG_CHARS = /^[A-Za-z0-9._-]{1,100}$/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
const unescapeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  }
  return ENTITIES[e.toLowerCase()] ?? m
})

/** Release notes as plain text: the feed carries them as escaped HTML. */
export function htmlToText(html: string): string {
  return unescapeEntities(unescapeEntities(html)
    .replace(/<\/(p|h[1-6]|ul|ol|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Entries of `releases.atom`, newest first. Draft releases never appear there. */
export function parseReleasesAtom(xml: string, repo: string): GithubRelease[] {
  const out: GithubRelease[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1]!
    const tag = /<link[^>]*href="[^"]*\/releases\/tag\/([^"/]+)"/.exec(entry)?.[1]
    if (!tag) continue
    let tagName: string
    try { tagName = decodeURIComponent(tag) } catch { continue }
    if (!TAG_CHARS.test(tagName)) continue
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1]
    out.push({
      tag_name: tagName,
      name: title ? unescapeEntities(title).trim() : tagName,
      body: content ? htmlToText(content) : '',
      published_at: /<updated>([^<]+)<\/updated>/.exec(entry)?.[1] ?? null,
      html_url: `https://github.com/${repo}/releases/tag/${tagName}`,
    })
  }
  return out
}

/** Assets of one release from its expanded-assets HTML fragment. */
export function parseExpandedAssets(html: string, repo: string, tag: string): ReleaseAsset[] {
  const prefix = `/${repo}/releases/download/${tag}/`
  const digests = new Map<string, string>()
  for (const m of html.matchAll(/aria-label="Copy to clipboard digest for ([^"]+)"[^>]*?value="(sha256:[0-9a-f]{64})"/gi)) digests.set(unescapeEntities(m[1]!), m[2]!.toLowerCase())
  for (const m of html.matchAll(/value="(sha256:[0-9a-f]{64})"[^>]*?aria-label="Copy to clipboard digest for ([^"]+)"/gi)) digests.set(unescapeEntities(m[2]!), m[1]!.toLowerCase())
  const seen = new Set<string>()
  const assets: ReleaseAsset[] = []
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = unescapeEntities(m[1]!)
    if (!href.startsWith(prefix)) continue
    const name = decodeURIComponent(href.slice(prefix.length))
    if (!name || name.includes('/') || seen.has(name)) continue
    seen.add(name)
    assets.push({ name, browser_download_url: `https://github.com${href}`, digest: digests.get(name) ?? null })
  }
  return assets
}

function checkRepo(repo: string) {
  if (!REPO_RE.test(repo)) throw new RuntimeError('http', 'Unexpected repository name', repo)
}

/** `releases.atom` of a repository. */
export async function fetchReleasesAtom(fetchFn: FetchFn, repo: string, net: NetOptions = {}): Promise<GithubRelease[]> {
  checkRepo(repo)
  const xml = String(await getBody(fetchFn, `https://github.com/${repo}/releases.atom`, 'text', net))
  const list = parseReleasesAtom(xml, repo)
  if (!list.length) throw new RuntimeError('http', 'Release feed has no entries', repo)
  return list
}

/** Assets of one release, from the expanded-assets page. */
export async function fetchExpandedAssets(fetchFn: FetchFn, repo: string, tag: string, net: NetOptions = {}): Promise<ReleaseAsset[]> {
  checkRepo(repo)
  if (!TAG_CHARS.test(tag)) throw new RuntimeError('http', 'Unexpected release tag', tag)
  const html = String(await getBody(fetchFn, `https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`, 'text', net))
  const assets = parseExpandedAssets(html, repo, tag)
  if (!assets.length) throw new RuntimeError('http', 'Release page has no assets', tag)
  return assets
}

/** True when the API failure is one that the github.com pages can work around. */
export const apiFallbackCode = (e: unknown): boolean => e instanceof RuntimeError && (e.code === 'rate-limited' || e.code === 'http')
