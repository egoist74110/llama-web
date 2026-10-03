// llama.cpp update and rollback on top of llamacpp.ts. At startup (in the background, never
// during normal running) it adopts an installed version, checks the official latest Release,
// downloads it when it is not installed yet and makes it the current version, then removes
// old version directories beyond `keepVersions` (at least 2). A version directory that a
// running or starting llama-server uses, and the current version, are never removed.
// Pure module (no Nitro): settings and "in use" come in as callbacks.
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { isInsideDir } from './residue'
import type { RuntimeListing } from './runtime-manager'
import {
  clearLeftovers, installBuild, installedDir, listInstalled, resolveLatest, RuntimeError, versionsDir,
  type InstallOptions, type NetOptions, type RuntimeStatus,
} from './llamacpp'

const TAG_RE = /^b\d+$/

export interface VersionView {
  tag: string
  current: boolean
  /** A running (or starting) llama-server uses this directory. */
  inUse: boolean
}

/** GET /api/llamacpp. */
export interface LlamacppDoc {
  current: string
  status: RuntimeStatus
  versions: VersionView[]
  rollback: string | null
  autoUpdate: boolean
  keepVersions: number
  /** Official and hand-added builds of this computer (decisions 34 / 35); other platforms are hidden. */
  runtimes?: RuntimeListing
}

export class UpdateError extends Error {
  constructor(public code: 'not-installed' | 'bad-tag', message: string) {
    super(message)
    this.name = 'UpdateError'
  }
}

export interface UpdaterOptions extends Pick<InstallOptions, 'fetch' | 'extract' | 'platform' | 'target'> {
  selectionError?: string
  /** HTTP time limits (tests); the shutdown signal is added by the updater. */
  net?: Omit<NetOptions, 'signal'>
  dataDir: string
  /** settings.llamacpp, read fresh each time. */
  llamacpp(): { cudaRuntime: string, current: string, keepVersions: number, autoUpdate: boolean }
  setCurrent(tag: string): void
  /** Executable paths of running / starting llama-server processes. */
  usedExes(): string[]
  /** Tags a model or profile picked by hand: pruning keeps them (decision 35). */
  protect?(): ReadonlySet<string>
  onStatus?(s: RuntimeStatus): void
  /** Version directories removed by pruning, and the ones that could not be removed. */
  onPrune?(r: PruneResult): void
}

export interface PruneResult {
  removed: string[]
  /** Removal failed (files locked, permissions); retried on the next start. */
  failed: Array<{ tag: string, detail: string }>
}

/** Version tag of an executable under data/runtime/llama.cpp/<tag>/, or null. */
export function versionOfExe(dataDir: string, exe: string, platform = process.platform): string | null {
  const base = versionsDir(dataDir)
  if (!isInsideDir(exe, base, platform)) return null
  const path = platform === 'win32' ? win32 : posix
  // Windows paths compare case-insensitively; tags are lower-case `b<digits>`.
  const parts = path.relative(base, exe).toLowerCase().split(/[\\/]/)
  const first = parts[0] ?? ''
  if (TAG_RE.test(first)) return first
  return /^(win32|darwin)-(x64|arm64)-(cuda|cpu|metal)$/.test(first) && TAG_RE.test(parts[1] ?? '') ? parts[1]! : null
}

/**
 * Which installed versions to remove: everything beyond the newest `keep` (at least 2), except
 * protected tags (current, in use). `installed` is newest first.
 */
export function pruneCandidates(installed: string[], keep: number, protect: ReadonlySet<string>): string[] {
  const n = Math.max(2, Number.isFinite(keep) ? Math.floor(keep) : 2)
  return installed.slice(n).filter(t => !protect.has(t))
}

export class Updater {
  private status: RuntimeStatus = { state: 'idle' }
  private installed: string[] = []
  private running: Promise<RuntimeStatus> | null = null
  private abort = new AbortController()

  constructor(private readonly opts: UpdaterOptions) {
    this.installed = listInstalled(opts.dataDir, opts.platform, opts.target)
  }

  getStatus(): RuntimeStatus {
    return this.status
  }

  /** Re-read the installed versions from disk. */
  refresh(): string[] {
    this.installed = listInstalled(this.opts.dataDir, this.opts.platform, this.opts.target)
    return this.installed
  }

  /** Tags that must not be removed right now. */
  private inUse(): Set<string> {
    const tags = new Set<string>()
    for (const exe of this.opts.usedExes()) {
      const t = versionOfExe(this.opts.dataDir, exe, this.opts.platform)
      if (t) tags.add(t)
    }
    return tags
  }

  /** Installed versions, newest first. */
  versions(): VersionView[] {
    const current = this.opts.llamacpp().current
    const used = this.inUse()
    return this.installed.map(tag => ({ tag, current: tag === current, inUse: used.has(tag) }))
  }

  /**
   * Older version to suggest when a model fails to load: the newest installed version below the
   * current one, but only while the current one is the newest installed (i.e. it is the update).
   */
  rollbackTarget(): string | null {
    const current = this.opts.llamacpp().current
    if (!current || this.installed[0] !== current) return null
    return this.installed[1] ?? null
  }

  /** Make an installed version current (rollback, or back to the newer one). Next loads use it. */
  use(tag: unknown): string {
    if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new UpdateError('bad-tag', 'Invalid version tag')
    if (!this.refresh().includes(tag)) throw new UpdateError('not-installed', `Version ${tag} is not installed`)
    const from = this.opts.llamacpp().current
    this.opts.setCurrent(tag)
    // A running check reports its own result (and keeps this choice, see check()).
    if (this.status.state !== 'working') this.set({ state: 'ready', tag, note: 'switched', from: from || null })
    return tag
  }

  /** Remove version directories beyond keepVersions, never the current one or one in use. */
  prune(): PruneResult {
    const installed = this.refresh()
    const { current, keepVersions } = this.opts.llamacpp()
    const protect = this.inUse()
    if (current) protect.add(current)
    for (const t of this.opts.protect?.() ?? []) protect.add(t)
    const result: PruneResult = { removed: [], failed: [] }
    const base = versionsDir(this.opts.dataDir, this.opts.target)
    mkdirSync(base, { recursive: true })
    for (const tag of pruneCandidates(installed, keepVersions, protect)) {
      // Rename first: on Windows this fails while any file inside is open (a process we do not
      // know about), so a directory is either removed as a whole or left intact - never half.
      const trash = join(base, `.del-${tag}-${process.pid}-${Date.now()}`)
      try {
        renameSync(installedDir(this.opts.dataDir, tag, this.opts.target), trash)
      } catch (e) {
        result.failed.push({ tag, detail: (e as Error).message })
        continue
      }
      result.removed.push(tag)
      try { rmSync(trash, { recursive: true, force: true }) } catch { /* cleared on the next start */ }
    }
    this.refresh()
    if (result.removed.length || result.failed.length) this.opts.onPrune?.(result)
    return result
  }

  private set(s: RuntimeStatus): RuntimeStatus {
    this.status = s
    this.opts.onStatus?.(s)
    return s
  }

  /** Startup check (single flight). Never throws: failures end in an `error` status. */
  run(): Promise<RuntimeStatus> {
    this.running ??= this.check().finally(() => { this.running = null })
    return this.running
  }

  /** Shutdown: cancel the network work of a running check and wait until it has cleaned up. */
  async stop(): Promise<void> {
    this.abort.abort(new Error('shutdown'))
    await this.running?.catch(() => {})
  }

  private async check(): Promise<RuntimeStatus> {
    const { dataDir, platform } = this.opts
    clearLeftovers(dataDir, this.opts.target)
    const installed = this.refresh()
    let current = this.opts.llamacpp().current
    // Keep a valid setting; adopt the newest installed version when it is empty or stale.
    if (!installed.includes(current)) {
      current = installed[0] ?? ''
      if (current) this.opts.setCurrent(current)
    }
    const cfg = this.opts.llamacpp()
    if (!cfg.autoUpdate) {
      this.safePrune()
      return this.set(current ? { state: 'ready', tag: current, note: 'auto-off' } : { state: 'disabled' })
    }

    const before = current
    try {
      if (this.opts.selectionError) throw new RuntimeError('asset-missing', 'Choose runtime acceleration in settings.json and restart', this.opts.selectionError)
      this.set({ state: 'working', step: 'resolve', detail: '' })
      const fetchFn = this.opts.fetch ?? fetch
      const net: NetOptions = { ...this.opts.net, signal: this.abort.signal }
      const latest = await resolveLatest(fetchFn, cfg.cudaRuntime, platform, net, this.opts.target)
      if (this.refresh().includes(latest.tag)) {
        // Already installed. A version picked by hand (rollback) stays current.
        const now = this.opts.llamacpp().current
        this.safePrune()
        return this.set({ state: 'ready', tag: now, note: now === latest.tag ? 'latest' : 'pinned', latest: latest.tag })
      }
      await installBuild(latest, {
        dataDir, cudaRuntime: cfg.cudaRuntime, fetch: this.opts.fetch, extract: this.opts.extract, platform, target: this.opts.target, net,
        onStep: (step, detail) => this.set({ state: 'working', step, detail, tag: latest.tag }),
      })
      const installedNow = this.refresh()
      const now = this.opts.llamacpp().current
      // Switched by hand while downloading: keep that choice, the new version is just installed.
      const picked = now !== before && installedNow.includes(now)
      if (!picked) this.opts.setCurrent(latest.tag)
      this.safePrune()
      const tag = picked ? now : latest.tag
      return this.set(picked
        ? { state: 'ready', tag, note: 'pinned', latest: latest.tag }
        : { state: 'ready', tag, note: 'updated', from: before || null, latest: latest.tag })
    } catch (e) {
      const using = this.opts.llamacpp().current
      const usable = this.refresh().includes(using) ? using : null
      const code = e instanceof RuntimeError ? e.code : 'unknown'
      const detail = e instanceof RuntimeError ? (e.detail ?? e.message) : (e as Error).message
      return this.set({ state: 'error', code, detail, using: usable })
    }
  }

  private safePrune(): void {
    try { this.prune() } catch { /* listing failed: nothing removed */ }
  }
}
