// Updates of llama-web itself (not llama.cpp, see updater.ts). Checks this project's GitHub
// Releases at startup, once a day and on request; tells the page about a newer version with
// its release notes. The desktop app can download the installer (GitHub's SHA-256 digest and
// the release's SHA256SUMS must both match) and hand it to the shell over the private desktop
// channel; the shell stops the service, checks the file again and starts the installer.
// The source version only links to the release page. Pure module (no Nitro).
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { download, getBody, RuntimeError, type FetchFn, type ReleaseAsset } from './llamacpp'
import { JsonStore } from './store'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
/** Installer name produced by the Tauri NSIS bundler. */
export const INSTALLER_RE = /^llama-web_(.+)_x64-setup\.exe$/
const NOTES_LIMIT = 20_000
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

export interface Semver { core: [number, number, number], pre: string[] }

export function parseVersion(v: string): Semver | null {
  const m = SEMVER.exec(v)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** SemVer 2.0 precedence: < 0 when a is older than b. Invalid versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0)
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]!
    const q = y.pre[i]!
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/** The fields of a GitHub release this module reads. */
export interface GithubRelease {
  tag_name?: string
  name?: string | null
  body?: string | null
  draft?: boolean
  prerelease?: boolean
  html_url?: string
  published_at?: string | null
  assets?: ReleaseAsset[]
}

/** A newer release, as shown on the page. */
export interface AppRelease {
  version: string
  name: string
  /** Release notes (Markdown source, shown as text). */
  notes: string
  url: string
  publishedAt: string | null
  prerelease: boolean
}

interface Candidate extends AppRelease {
  installer: ReleaseAsset | null
  sums: ReleaseAsset | null
}

/**
 * Newest release newer than `current`. Drafts never count; a stable version only moves to stable
 * releases, a prerelease also to newer prereleases. Assets whose URL fails `assetOk` are ignored.
 */
export function pickUpdate(list: GithubRelease[], current: string, assetOk: (url: string) => boolean): Candidate | null {
  const onPre = (parseVersion(current)?.pre.length ?? 0) > 0
  let best: Candidate | null = null
  for (const r of list) {
    const version = /^v(.+)$/.exec(r.tag_name ?? '')?.[1]
    if (r.draft || !version || !parseVersion(version)) continue
    const pre = (parseVersion(version)!.pre.length > 0) || !!r.prerelease
    if (pre && !onPre) continue
    if (compareVersions(version, current) <= 0 || (best && compareVersions(version, best.version) <= 0)) continue
    const assets = (r.assets ?? []).filter(a => typeof a?.name === 'string' && typeof a.browser_download_url === 'string' && assetOk(a.browser_download_url))
    best = {
      version,
      name: (r.name || r.tag_name || '').slice(0, 200),
      notes: (r.body ?? '').slice(0, NOTES_LIMIT),
      url: typeof r.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : '',
      publishedAt: r.published_at ?? null,
      prerelease: pre,
      installer: assets.find(a => a.name === `llama-web_${version}_x64-setup.exe`) ?? null,
      sums: assets.find(a => a.name === 'SHA256SUMS') ?? null,
    }
  }
  return best
}

/** `<hex>  <name>` lines (sha256sum format); the hash of `name`, lowercase, or null. */
export function sumFor(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (m && m[2] === name) return m[1]!.toLowerCase()
  }
  return null
}

export type AppUpdateErrorCode =
  | 'network' | 'bad-response' | 'no-installer' | 'no-digest' | 'digest-mismatch' | 'busy'
  | 'not-desktop' | 'not-ready' | 'nothing-new' | 'cancelled' | 'failed'

export class AppUpdateError extends Error {
  constructor(public code: AppUpdateErrorCode, message: string) {
    super(message)
    this.name = 'AppUpdateError'
  }
}

export type AppUpdateCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest', at: number }
  | { state: 'available', at: number, release: AppRelease }
  | { state: 'error', at: number, code: AppUpdateErrorCode }

export type AppUpdateDownload =
  | { state: 'none' }
  | { state: 'downloading', version: string, received: number, total: number | null }
  | { state: 'ready', version: string }
  | { state: 'installing', version: string }
  | { state: 'error', version: string, code: AppUpdateErrorCode }

/** Live view for the page (state snapshot `appUpdate`). */
export interface AppUpdateView {
  current: string
  /** The desktop app can download and install; the source version only links to the release. */
  canInstall: boolean
  autoCheck: boolean
  /** Version the user chose to skip (no prompt for it; the settings card still shows it). */
  skipped: string | null
  check: AppUpdateCheck
  download: AppUpdateDownload
  /** Release list page, for "all versions". */
  releasesUrl: string
}

export interface AppUpdatePrefs {
  version: number
  autoCheck: boolean
  skipped: string | null
}
export const APP_UPDATE_PREFS_VERSION = 1
function normalizePrefs(doc: AppUpdatePrefs): AppUpdatePrefs {
  if (typeof doc.autoCheck !== 'boolean') throw new Error('autoCheck must be a boolean')
  if (doc.skipped !== null && (typeof doc.skipped !== 'string' || !parseVersion(doc.skipped))) throw new Error('skipped must be a version or null')
  return { version: APP_UPDATE_PREFS_VERSION, autoCheck: doc.autoCheck, skipped: doc.skipped }
}

/** What the shell needs to start a verified installer. */
export interface InstallRequest { file: string, sha256: string, version: string }

export interface AppUpdaterOptions {
  current: string
  repo: string
  dataDir: string
  fetch?: FetchFn
  /**
   * Release list URL. Defaults to the GitHub API of `repo`; any other value must be a loopback
   * http(s) URL (local acceptance tests), and then loopback asset URLs are accepted too.
   */
  feed?: string
  onChange?(): void
  now?: () => number
  /** Delay of the startup check and the interval of later automatic checks (tests). */
  firstCheckMs?: number
  everyMs?: number
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

const isLoopback = (url: string) => {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)
  } catch { return false }
}

export class AppUpdater {
  private checkState: AppUpdateCheck = { state: 'idle' }
  private downloadState: AppUpdateDownload = { state: 'none' }
  private candidate: Candidate | null = null
  private ready: InstallRequest | null = null
  private installer: ((r: InstallRequest) => void) | null = null
  private abort: AbortController | null = null
  private checking: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly prefs: JsonStore<AppUpdatePrefs>
  private prefsValue: AppUpdatePrefs
  private readonly feed: string
  private readonly assetOk: (url: string) => boolean
  private readonly fetchFn: FetchFn
  private readonly now: () => number
  readonly dir: string

  constructor(private readonly opts: AppUpdaterOptions) {
    const official = `https://api.github.com/repos/${opts.repo}/releases`
    if (opts.feed && opts.feed !== official && !isLoopback(opts.feed)) throw new Error('Update feed must be the project releases API or a loopback test URL')
    this.feed = opts.feed ?? official
    const releasePrefix = `https://github.com/${opts.repo}/releases/download/`
    this.assetOk = this.feed === official ? url => url.startsWith(releasePrefix) : isLoopback
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? Date.now
    this.dir = join(opts.dataDir, 'run', 'app-update')
    this.prefs = new JsonStore<AppUpdatePrefs>({
      dataDir: opts.dataDir, name: 'app-update.json', version: APP_UPDATE_PREFS_VERSION, keepBackups: 3,
      defaults: () => ({ version: APP_UPDATE_PREFS_VERSION, autoCheck: true, skipped: null }), validate: normalizePrefs,
    })
    try { this.prefsValue = this.prefs.load() }
    catch { this.prefsValue = { version: APP_UPDATE_PREFS_VERSION, autoCheck: true, skipped: null } }
  }

  /** Remove installers of earlier runs (best effort: a running installer keeps its file) and schedule checks. */
  start(): void {
    try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* in use by the installer that started us */ }
    this.schedule(this.opts.firstCheckMs ?? FIRST_CHECK_MS)
  }

  /** The desktop entry attaches the private-channel hand-off; without it there is no in-app install. */
  setInstaller(fn: (r: InstallRequest) => void): void {
    this.installer = fn
    this.changed()
  }

  view(): AppUpdateView {
    return {
      current: this.opts.current,
      canInstall: this.installer !== null,
      autoCheck: this.prefsValue.autoCheck,
      skipped: this.prefsValue.skipped,
      check: this.checkState,
      download: this.downloadState,
      releasesUrl: `https://github.com/${this.opts.repo}/releases`,
    }
  }

  setPrefs(p: { autoCheck?: boolean, skipped?: string | null }): AppUpdateView {
    this.prefsValue = this.prefs.update((d) => {
      if (p.autoCheck !== undefined) d.autoCheck = p.autoCheck
      if (p.skipped !== undefined) d.skipped = p.skipped
    })
    this.schedule(this.opts.everyMs ?? CHECK_EVERY_MS)
    this.changed()
    return this.view()
  }

  /** Check now. A running check is joined; refused while a download or install is in progress. */
  check(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.downloadState.state === 'downloading' || this.downloadState.state === 'installing') return Promise.reject(new AppUpdateError('busy', 'Update download in progress'))
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null
      this.schedule(this.opts.everyMs ?? CHECK_EVERY_MS)
    })
    return this.checking
  }

  private async runCheck() {
    this.checkState = { state: 'checking' }
    this.changed()
    try {
      const list = await getBody(this.fetchFn, `${this.feed}?per_page=30`, 'json')
      if (!Array.isArray(list)) throw new AppUpdateError('bad-response', 'Release list is not an array')
      const found = pickUpdate(list as GithubRelease[], this.opts.current, this.assetOk)
      if (this.stopped) return
      // A different version than a finished download: that file is no longer what the page offers.
      if (found?.version !== this.candidate?.version && this.downloadState.state !== 'none') this.dropDownload()
      this.candidate = found
      const at = this.now()
      if (!found) this.checkState = { state: 'latest', at }
      else {
        const { installer: _i, sums: _s, ...release } = found
        this.checkState = { state: 'available', at, release }
      }
    } catch (e) {
      if (this.stopped) return
      this.checkState = { state: 'error', at: this.now(), code: e instanceof AppUpdateError ? e.code : e instanceof RuntimeError && e.code === 'network' ? 'network' : 'bad-response' }
    }
    this.changed()
  }

  /** Throws when a download cannot start now; returns the release to download. */
  private downloadable(): Candidate {
    if (!this.installer) throw new AppUpdateError('not-desktop', 'Only the desktop app installs updates')
    const c = this.candidate
    if (!c) throw new AppUpdateError('nothing-new', 'No newer version known')
    if (this.downloadState.state === 'downloading' || this.downloadState.state === 'installing') throw new AppUpdateError('busy', 'Download in progress')
    return c
  }

  /** Start the download in the background (the page follows it in the live state); refusals throw right away. */
  startDownload(): void {
    this.downloadable()
    this.download().catch(() => { /* reported in the download state */ })
  }

  /** Download the offered installer and verify it (desktop only). Resolves when it is ready. */
  async download(): Promise<void> {
    const c = this.downloadable()
    if (this.downloadState.state === 'ready' && this.downloadState.version === c.version) return
    const fail = (code: AppUpdateErrorCode) => {
      this.downloadState = { state: 'error', version: c.version, code }
      this.changed()
      return new AppUpdateError(code, `Update download failed: ${code}`)
    }
    if (!c.installer || !c.sums) throw fail('no-installer')
    if (!/^sha256:[0-9a-f]{64}$/i.test(c.installer.digest ?? '')) throw fail('no-digest')
    const abort = new AbortController()
    this.abort = abort
    this.downloadState = { state: 'downloading', version: c.version, received: 0, total: null }
    this.changed()
    const file = join(this.dir, c.installer.name)
    const part = `${file}.part`
    let last = 0
    try {
      rmSync(this.dir, { recursive: true, force: true })
      mkdirSync(this.dir, { recursive: true })
      const sums = String(await getBody(this.fetchFn, c.sums.browser_download_url, 'text', { signal: abort.signal }))
      const listed = sumFor(sums, c.installer.name)
      if (!listed) throw new AppUpdateError('no-digest', 'Installer missing from SHA256SUMS')
      if (`sha256:${listed}` !== c.installer.digest!.toLowerCase()) throw new AppUpdateError('digest-mismatch', 'SHA256SUMS and asset digest differ')
      await download(this.fetchFn, c.installer, part, {
        signal: abort.signal,
        onProgress: (received, total) => {
          if (this.downloadState.state !== 'downloading') return
          this.downloadState = { ...this.downloadState, received, total }
          // At most every 250 ms: the page shows a progress bar, not every chunk.
          const t = this.now()
          if (t - last >= 250) { last = t; this.changed() }
        },
      })
      if (abort.signal.aborted) throw new AppUpdateError('cancelled', 'Cancelled')
      renameSync(part, file)
      this.ready = { file, sha256: listed, version: c.version }
      this.downloadState = { state: 'ready', version: c.version }
      this.changed()
    } catch (e) {
      try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* retried on the next start */ }
      if (this.stopped) return
      const code: AppUpdateErrorCode = abort.signal.aborted ? 'cancelled'
        : e instanceof AppUpdateError ? e.code
          : e instanceof RuntimeError ? (e.code === 'digest-mismatch' ? 'digest-mismatch' : e.code === 'no-digest' ? 'no-digest' : 'network')
            : 'failed'
      throw fail(code)
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  cancel(): void {
    this.abort?.abort(new Error('cancelled'))
  }

  /** Verify the downloaded installer once more and ask the shell to install it. The shell then stops this process. */
  async install(): Promise<void> {
    if (!this.installer) throw new AppUpdateError('not-desktop', 'Only the desktop app installs updates')
    const r = this.ready
    if (!r || this.downloadState.state !== 'ready') throw new AppUpdateError('not-ready', 'Installer not downloaded')
    let actual: string
    try { actual = await sha256File(r.file) } catch { actual = '' }
    if (actual !== r.sha256) {
      this.dropDownload()
      this.downloadState = { state: 'error', version: r.version, code: 'digest-mismatch' }
      this.changed()
      throw new AppUpdateError('digest-mismatch', 'Installer changed after download')
    }
    this.downloadState = { state: 'installing', version: r.version }
    this.changed()
    this.installer(r)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.cancel()
    this.prefs.close()
  }

  private dropDownload() {
    this.cancel()
    this.ready = null
    this.downloadState = { state: 'none' }
    try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* retried on the next start */ }
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped || !this.prefsValue.autoCheck) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.check().catch(() => this.schedule(this.opts.everyMs ?? CHECK_EVERY_MS)) // busy: try again next interval
    }, ms)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private changed() {
    try { this.opts.onChange?.() } catch { /* listener errors must not break updates */ }
  }
}
