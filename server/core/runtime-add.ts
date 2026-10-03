// Adding a llama.cpp build by hand (decision 34): a local directory, a local archive or a GitHub
// release. External binaries and archives are a trust boundary, so every source goes through the
// same two steps:
//   1. preview: stage a private copy under data/runtime/llama.cpp/custom/.stage-<n>/ (copy /
//      extract / download), check paths, links, sizes, disk space and the executable header
//      (platform and architecture by content), run `llama-server --version` with a time limit and
//      report what was found. Nothing is registered yet.
//   2. confirm: only for a staged preview; the staged directory is renamed into custom/<id>/ and
//      the entry written to runtimes.json. A build without a published SHA-256 needs an explicit
//      "accept the computed value".
// A failure at any point removes the staging directory: no half-installed build is ever visible.
import { spawn } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, statfsSync, symlinkSync,
} from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { checkExtractedTree, extractArchive, safeArchivePath, type ArchiveOptions } from './archive'
import { download, getBody, RuntimeError, serverExeName, sha256File, versionsDir, type FetchFn, type ReleaseAsset } from './llamacpp'
import type { RuntimeTarget } from './platform'
import { killTree } from './runner'
import {
  binaryRunsHere, customDir, newRuntimeId, sniffFile, type RuntimeAccel, type RuntimeEntry, type RuntimeRegistry, type RuntimeSourceKind,
} from './runtimes'

export type AddErrorCode =
  | 'bad-source' | 'not-found' | 'bad-url' | 'network' | 'no-asset' | 'no-server-exe' | 'wrong-platform' | 'unsafe'
  | 'too-large' | 'disk-space' | 'run-failed' | 'digest-mismatch' | 'needs-digest-confirm' | 'stale-stage' | 'busy' | 'unavailable' | 'failed'

export class AddError extends Error {
  constructor(public code: AddErrorCode, message: string, public detail?: string) {
    super(message)
    this.name = 'AddError'
  }
}

/** Limits: a CUDA build with its runtime is below 1 GiB; these leave room for custom builds, not for bombs. */
export const ADD_LIMITS = {
  /** Total size of a staged tree. */
  maxTreeBytes: 6 * 1024 ** 3,
  maxFiles: 5000,
  maxDownloadBytes: 3 * 1024 ** 3,
  /** Free space needed, as a multiple of the archive / tree size. */
  archiveSpaceFactor: 3,
  dirSpaceFactor: 2,
  versionTimeoutMs: 10_000,
  stageTtlMs: 30 * 60_000,
}

export type AddInput =
  | { kind: 'dir', path: string }
  | { kind: 'archive', path: string }
  | { kind: 'github', url: string, accel?: RuntimeAccel }

export interface AddPreview {
  stageId: string
  kind: RuntimeSourceKind
  /** Path or URL as given (display only). */
  source: string
  /** Bytes of the staged files. */
  bytes: number
  files: number
  os: NodeJS.Platform
  arch: string
  accel: RuntimeAccel
  /** First line of `llama-server --version`. */
  version: string
  tag: string
  suggestedLabel: string
  /** SHA-256 of each downloaded / chosen archive; empty for a directory. */
  digests: Array<{ name: string, sha256: string, verified: boolean }>
  /** Confirming needs `acceptUnverified` (a downloaded file without a published SHA-256). */
  needsDigestConfirm: boolean
  /** Items the caller should show next to the confirmation (`no-cudart`, `no-shared-libs`). */
  warnings: string[]
}

interface Stage {
  id: string
  /** `.stage-<n>` directory (contains `out/` and `dl/`). */
  dir: string
  /** The directory that becomes custom/<id>/. */
  root: string
  preview: AddPreview
  created: number
}

export interface InstallerOptions {
  dataDir: string
  target: RuntimeTarget
  registry: RuntimeRegistry
  fetch?: FetchFn
  extract?: (file: string, dest: string, options?: ArchiveOptions) => Promise<void>
  /** Run `llama-server --version`; returns the combined output. Tests replace it. */
  runVersion?: (exe: string, cwd: string, timeoutMs: number) => Promise<string>
  /** Free bytes on the volume of `dir`, or null when unknown (then the check is skipped). */
  freeBytes?: (dir: string) => number | null
  /** HTTP / extraction limits (tests). */
  net?: Omit<ArchiveOptions, 'signal'>
  limits?: Partial<typeof ADD_LIMITS>
  now?: () => number
  /** macOS: remove the quarantine attribute of the copied files. */
  clearQuarantine?: (dir: string) => Promise<void>
}

/** Where the build number appears in `llama-server --version`: `version: 0.5.0-dev (build 11146, commit …)`. */
export function parseVersionOutput(out: string): { line: string, tag: string } {
  const line = out.split(/\r?\n/).find(l => /^version:/i.test(l.trim()))?.trim() ?? ''
  const num = /build (\d+)/i.exec(line)?.[1] ?? /^version:\s*(\d+)\b/i.exec(line)?.[1]
  return { line, tag: num ? `b${num}` : '' }
}

export function defaultRunVersion(exe: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(exe, ['--version'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false })
    let out = '', done = false, timedOut = false
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn() } }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid).catch(() => {}).finally(() => child.kill('SIGKILL'))
    }, timeoutMs)
    const take = (d: Buffer) => { if (out.length < 64_000) out += d.toString('utf8') }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', e => finish(() => rej(new AddError('run-failed', 'Cannot run llama-server', e.message))))
    child.on('close', code => finish(() => {
      if (timedOut) rej(new AddError('run-failed', 'llama-server --version timed out'))
      else if (code !== 0) rej(new AddError('run-failed', `llama-server --version exited with code ${code}`, out.slice(-500)))
      else res(out)
    }))
  })
}

function defaultFreeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** The directory (root or its only sub-directory) that holds the server executable. */
function findRoot(dir: string, exe: string): string | null {
  if (!existsSync(dir)) return null
  if (existsSync(join(dir, exe))) return dir
  const subs = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory())
  return subs.length === 1 && existsSync(join(dir, subs[0]!, exe)) ? join(dir, subs[0]!) : null
}

/** Size and file count of a tree, refusing anything that is not a plain file / directory / inside-link. */
function measureTree(dir: string, limits: typeof ADD_LIMITS): { bytes: number, files: number, libs: number } {
  let bytes = 0, files = 0, libs = 0
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n), st = lstatSync(f)
      if (st.isDirectory()) walk(f)
      else if (st.isFile() || st.isSymbolicLink()) {
        files++
        if (st.isFile()) bytes += st.size
        if (/\.(dll|dylib|so(\.\d+)*)$/i.test(n)) libs++
        if (files > limits.maxFiles || bytes > limits.maxTreeBytes) throw new AddError('too-large', 'The build is too large')
      } else throw new AddError('unsafe', 'Unsupported file type in the build')
    }
  }
  walk(dir)
  return { bytes, files, libs }
}

/** Copy a tree without following links; relative links that stay inside are recreated, others are refused. */
function copyTree(src: string, dest: string, root = src): void {
  mkdirSync(dest, { recursive: true })
  for (const n of readdirSync(src)) {
    const from = join(src, n), to = join(dest, n), st = lstatSync(from)
    if (st.isDirectory()) copyTree(from, to, root)
    else if (st.isSymbolicLink()) {
      const target = readlinkSync(from)
      if (isAbsolute(target) || !safeArchivePath(target)) throw new AddError('unsafe', 'The build contains a link that leaves its directory')
      const real = realpathSync(from)
      const rootReal = realpathSync(root)
      if (!(real + '/').replaceAll('\\', '/').startsWith(rootReal.replaceAll('\\', '/') + '/')) throw new AddError('unsafe', 'The build contains a link that leaves its directory')
      symlinkSync(target, to)
    } else if (st.isFile()) copyFileSync(from, to)
    else throw new AddError('unsafe', 'Unsupported file type in the build')
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub sources

export interface GithubSource {
  owner: string
  repo: string
  /** Release tag; null = the latest release. */
  tag: string | null
}

/** Only https://github.com/<owner>/<repo>[/releases[/latest|/tag/<tag>]]; anything else is refused. */
export function parseGithubSource(raw: string): GithubSource {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new AddError('bad-url', 'Not a valid address') }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port) {
    throw new AddError('bad-url', 'Only https://github.com/ addresses are accepted')
  }
  const seg = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s) } catch { return '\u0000' } })
  const [owner, rawRepo, ...rest] = seg
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!owner || !repo || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw new AddError('bad-url', 'Expected https://github.com/<owner>/<repo>')
  }
  if (rest.length === 0 || (rest.length === 1 && rest[0] === 'releases') || (rest.length === 2 && rest[0] === 'releases' && rest[1] === 'latest')) {
    return { owner, repo, tag: null }
  }
  if (rest.length === 3 && rest[0] === 'releases' && rest[1] === 'tag' && /^[A-Za-z0-9._+-]{1,100}$/.test(rest[2]!)) return { owner, repo, tag: rest[2]! }
  throw new AddError('bad-url', 'Use the repository address or a Release page')
}

export interface AssetChoice {
  bin: string
  cudart?: string
  accel: RuntimeAccel
}

/**
 * The asset of this host: Windows x64 `...-bin-win-(cpu|cuda-X.Y)-x64.zip` (+ the matching
 * `cudart-...` when present), macOS `...-bin-macos-<arch>.tar.gz|zip` with exactly the host's arch.
 * `wanted` picks CUDA or CPU on Windows; default CUDA when the host runs it.
 */
export function pickAsset(names: string[], host: { os: NodeJS.Platform, arch: string }, wanted: RuntimeAccel): AssetChoice | null {
  if (host.os === 'win32' && host.arch === 'x64') {
    if (wanted === 'cpu') {
      const bin = names.find(n => /^llama-[^/\\]+-bin-win-cpu-x64\.zip$/.test(n))
      return bin ? { bin, accel: 'cpu' } : null
    }
    const cuda = names
      .map(n => /^llama-[^/\\]+-bin-win-cuda-(\d+)\.(\d+)-x64\.zip$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]))
    const withRt = cuda.find(m => names.includes(`cudart-llama-bin-win-cuda-${m[1]}.${m[2]}-x64.zip`)) ?? cuda[0]
    if (!withRt) return null
    const rt = `cudart-llama-bin-win-cuda-${withRt[1]}.${withRt[2]}-x64.zip`
    return { bin: withRt[0], accel: 'cuda', ...(names.includes(rt) ? { cudart: rt } : {}) }
  }
  if (host.os === 'darwin') {
    const bin = names.find(n => new RegExp(`^llama-[^/\\\\]+-bin-macos-${host.arch}\\.(tar\\.gz|zip)$`).test(n))
    return bin ? { bin, accel: host.arch === 'arm64' ? 'metal' : 'cpu' } : null
  }
  return null
}

// ---------------------------------------------------------------------------------------------

export class RuntimeInstaller {
  private stage: Stage | null = null
  private working = false
  private readonly limits: typeof ADD_LIMITS
  private abort = new AbortController()

  constructor(private readonly opts: InstallerOptions) {
    this.limits = { ...ADD_LIMITS, ...opts.limits }
  }

  private get now() { return this.opts.now?.() ?? Date.now() }
  private get baseDir() { return join(versionsDir(this.opts.dataDir), 'custom') }

  /** Remove staging / trash leftovers of an earlier run (call at startup, before anything is staged). */
  clearLeftovers(): void {
    let names: string[]
    try { names = readdirSync(this.baseDir) } catch { return }
    for (const n of names) {
      if (n.startsWith('.stage-') || n.startsWith('.del-')) {
        try { rmSync(join(this.baseDir, n), { recursive: true, force: true }) } catch { /* locked: next start */ }
      }
    }
  }

  /** Drop the staged preview (if any) and stop a running download. */
  cancel(stageId?: string): void {
    if (this.stage && (!stageId || this.stage.id === stageId)) this.discard()
  }

  dispose(): void {
    this.abort.abort(new Error('shutdown'))
    this.discard()
  }

  private discard(): void {
    const s = this.stage
    this.stage = null
    if (s) { try { rmSync(s.dir, { recursive: true, force: true }) } catch { /* cleared at the next start */ } }
  }

  private expire(): void {
    if (this.stage && this.now - this.stage.created > this.limits.stageTtlMs) this.discard()
  }

  private checkSpace(need: number): void {
    const free = (this.opts.freeBytes ?? defaultFreeBytes)(this.baseDirExisting())
    if (free !== null && free < need) throw new AddError('disk-space', 'Not enough free disk space', String(need))
  }
  private baseDirExisting(): string {
    mkdirSync(this.baseDir, { recursive: true })
    return this.baseDir
  }

  /** Stage a source and describe it. Replaces an earlier staged preview. Only one runs at a time. */
  async preview(input: AddInput): Promise<AddPreview> {
    if (this.opts.registry.unavailable) throw new AddError('unavailable', 'runtimes.json cannot be used', this.opts.registry.unavailable)
    if (this.working) throw new AddError('busy', 'Another add is in progress')
    this.working = true
    this.discard()
    const dir = join(this.baseDirExisting(), `.stage-${process.pid}-${this.now}`)
    try {
      mkdirSync(join(dir, 'out'), { recursive: true })
      let source = '', digests: AddPreview['digests'] = [], accelHint: RuntimeAccel | undefined
      let needCheck = false
      if (input.kind === 'dir') {
        source = this.stageDir(input.path, dir)
      } else if (input.kind === 'archive') {
        const r = await this.stageArchive(input.path, dir)
        source = r.source
        digests = r.digests
      } else if (input.kind === 'github') {
        const r = await this.stageGithub(input.url, input.accel, dir)
        source = r.source
        digests = r.digests
        accelHint = r.accel
        needCheck = r.digests.some(d => !d.verified)
      } else throw new AddError('bad-source', 'Unknown source kind')

      const out = join(dir, 'out')
      const exe = serverExeName(this.opts.target.os)
      const root = findRoot(out, exe)
      if (!root) throw new AddError('no-server-exe', `${exe} not found in the chosen source`)
      checkExtractedTree(root)
      const measured = measureTree(root, this.limits)

      const header = sniffFile(join(root, exe))
      if (!header) throw new AddError('wrong-platform', 'The file is not a recognised executable')
      if (!binaryRunsHere(header, this.opts.target)) {
        throw new AddError('wrong-platform', 'The build is for another platform', `${header.os}/${header.archs.join(',')}`)
      }
      if (this.opts.target.os !== 'win32') {
        try { chmodSync(join(root, exe), 0o755) } catch { /* reported by the run below */ }
        if (this.opts.target.os === 'darwin') await (this.opts.clearQuarantine ?? defaultClearQuarantine)(root).catch(() => {})
      }
      const warnings: string[] = []
      if (measured.libs === 0) warnings.push('no-shared-libs')
      const out2 = await (this.opts.runVersion ?? defaultRunVersion)(join(root, exe), root, this.limits.versionTimeoutMs)
      const { line, tag } = parseVersionOutput(out2)
      if (!line) throw new AddError('run-failed', 'llama-server --version printed no version')

      const accel = accelHint ?? detectAccel(root, this.opts.target)
      const cudart = input.kind === 'github' && accel === 'cuda' && !digests.some(d => d.name.startsWith('cudart-'))
      if (cudart) warnings.push('no-cudart')
      const stageId = newRuntimeId()
      const preview: AddPreview = {
        stageId, kind: input.kind, source, bytes: measured.bytes, files: measured.files,
        os: this.opts.target.os, arch: this.opts.target.arch, accel, version: line, tag,
        suggestedLabel: defaultLabel(tag, accel, input, source), digests, needsDigestConfirm: needCheck, warnings,
      }
      this.stage = { id: stageId, dir, root, preview, created: this.now }
      return preview
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* cleared at the next start */ }
      if (e instanceof AddError) throw e
      if (e instanceof RuntimeError) throw new AddError(e.code === 'extract-failed' ? 'unsafe' : e.code === 'network' ? 'network' : e.code === 'digest-mismatch' ? 'digest-mismatch' : 'failed', e.message, e.detail)
      throw new AddError('failed', 'Adding the build failed', (e as Error)?.message)
    } finally {
      this.working = false
    }
  }

  private stageDir(path: string, dir: string): string {
    const src = resolve(path)
    let st
    try { st = lstatSync(src) } catch { throw new AddError('not-found', 'The directory does not exist') }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AddError('bad-source', 'Choose a real directory')
    // Existing links must stay inside, the size is bounded, and there must be room for the copy.
    checkExtractedTree(src)
    const m = measureTree(src, this.limits)
    this.checkSpace(m.bytes * this.limits.dirSpaceFactor)
    copyTree(src, join(dir, 'out'))
    return src
  }

  private async stageArchive(path: string, dir: string): Promise<{ source: string, digests: AddPreview['digests'] }> {
    const file = resolve(path)
    let st
    try { st = statSync(file) } catch { throw new AddError('not-found', 'The file does not exist') }
    if (!st.isFile()) throw new AddError('bad-source', 'Choose an archive file')
    if (!/\.(zip|tar\.gz|tgz)$/i.test(file)) throw new AddError('bad-source', 'Only .zip and .tar.gz archives are supported')
    if (st.size > this.limits.maxDownloadBytes) throw new AddError('too-large', 'The archive is too large')
    this.checkSpace(st.size * this.limits.archiveSpaceFactor)
    const sha = await sha256File(file)
    await this.extractInto(file, join(dir, 'out'))
    return { source: file, digests: [{ name: basename(file), sha256: sha, verified: false }] }
  }

  private async extractInto(file: string, dest: string): Promise<void> {
    const extract = this.opts.extract ?? extractArchive
    try {
      await extract(file, dest, { ...this.opts.net, signal: this.abort.signal })
    } catch (e) {
      if (e instanceof RuntimeError) throw new AddError(e.code === 'extract-failed' ? 'unsafe' : 'failed', e.message, e.detail)
      throw e
    }
    measureTree(dest, this.limits) // refuses a bomb before anything else touches it
  }

  private async stageGithub(url: string, wantedAccel: RuntimeAccel | undefined, dir: string) {
    const src = parseGithubSource(url)
    const fetchFn = this.opts.fetch ?? fetch
    const net = { ...this.opts.net, signal: this.abort.signal }
    const api = `https://api.github.com/repos/${src.owner}/${src.repo}/releases/${src.tag ? `tags/${encodeURIComponent(src.tag)}` : 'latest'}`
    let rel: { assets?: ReleaseAsset[] }
    try { rel = await getBody(fetchFn, api, 'json', net) as { assets?: ReleaseAsset[] } } catch (e) {
      throw new AddError('network', 'Cannot read the release', (e as RuntimeError).detail ?? (e as Error).message)
    }
    const assets = (rel.assets ?? []).filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    const wanted: RuntimeAccel = wantedAccel ?? (this.opts.target.acceleration === 'cuda' ? 'cuda' : 'cpu')
    const choice = pickAsset(assets.map(a => a.name), this.opts.target, this.opts.target.os === 'darwin' ? (this.opts.target.arch === 'arm64' ? 'metal' : 'cpu') : wanted)
    if (!choice) throw new AddError('no-asset', 'The release has no build for this computer', `${this.opts.target.os}-${this.opts.target.arch}`)
    const picked = [choice.bin, choice.cudart].filter((n): n is string => !!n).map(n => assets.find(a => a.name === n)!)
    let total = 0
    for (const a of picked) {
      let u: URL
      try { u = new URL(a.browser_download_url) } catch { throw new AddError('bad-url', 'The release lists an invalid download address') }
      if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new AddError('bad-url', 'The release lists a download address outside github.com')
      if (a.size !== undefined && (!Number.isFinite(a.size) || a.size < 0 || a.size > this.limits.maxDownloadBytes)) throw new AddError('too-large', 'The download is too large')
      total += a.size ?? 0
    }
    this.checkSpace(total * this.limits.archiveSpaceFactor)
    const digests: AddPreview['digests'] = []
    mkdirSync(join(dir, 'dl'), { recursive: true })
    for (const a of picked) {
      if (a.name !== basename(a.name) || !/\.(zip|tar\.gz|tgz)$/.test(a.name)) throw new AddError('unsafe', 'Invalid archive name')
      const file = join(dir, 'dl', a.name)
      let tooLarge = false
      const ac = new AbortController()
      const onOuter = () => ac.abort(this.abort.signal.reason)
      this.abort.signal.addEventListener('abort', onOuter, { once: true })
      try {
        const sha = await download(fetchFn, a, file, {
          ...net, signal: ac.signal,
          onProgress: (got) => { if (got > this.limits.maxDownloadBytes && !tooLarge) { tooLarge = true; ac.abort(new Error('too large')) } },
        }, true)
        digests.push({ name: a.name, sha256: sha, verified: /^sha256:[0-9a-f]{64}$/i.test(a.digest ?? '') })
      } catch (e) {
        if (tooLarge) throw new AddError('too-large', 'The download is too large')
        if (e instanceof RuntimeError) throw new AddError(e.code === 'digest-mismatch' ? 'digest-mismatch' : 'network', e.message, e.detail)
        throw e
      } finally {
        this.abort.signal.removeEventListener('abort', onOuter)
      }
      await this.extractInto(file, join(dir, 'out'))
      rmSync(file, { force: true })
    }
    return { source: `https://github.com/${src.owner}/${src.repo}${src.tag ? `/releases/tag/${src.tag}` : ''}`, digests, accel: choice.accel }
  }

  /**
   * Make the staged preview a registered build. `acceptUnverified` is required when a downloaded file
   * had no published SHA-256. Returns the new entry.
   */
  confirm(stageId: string, opts: { label?: string, acceptUnverified?: boolean } = {}): RuntimeEntry {
    this.expire()
    const s = this.stage
    if (!s || s.id !== stageId) throw new AddError('stale-stage', 'The preview is gone; add the build again')
    if (s.preview.needsDigestConfirm && opts.acceptUnverified !== true) throw new AddError('needs-digest-confirm', 'The SHA-256 value must be confirmed')
    const id = newRuntimeId()
    const dest = customDir(this.opts.dataDir, id)
    const label = (typeof opts.label === 'string' ? opts.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '') || s.preview.suggestedLabel
    const p = s.preview
    const entry: RuntimeEntry = {
      id, label, source: { kind: p.kind, from: p.source.slice(0, 500) }, os: p.os, arch: p.arch, accel: p.accel, tag: p.tag,
      addedAt: new Date(this.now).toISOString(), ...(p.digests[0] ? { sha256: p.digests[0].sha256 } : {}),
    }
    renameSync(s.root, dest)
    try {
      this.opts.registry.add(entry)
    } catch (e) {
      try { renameSync(dest, s.root) } catch { rmSync(dest, { recursive: true, force: true }) }
      throw new AddError('failed', 'Cannot save runtimes.json', (e as Error).message)
    }
    this.stage = null
    try { rmSync(s.dir, { recursive: true, force: true }) } catch { /* cleared at the next start */ }
    return entry
  }
}

function detectAccel(root: string, target: RuntimeTarget): RuntimeAccel {
  if (target.os === 'darwin') return target.arch === 'arm64' ? 'metal' : 'cpu'
  return readdirSync(root).some(n => /^(lib)?ggml-cuda/i.test(n)) ? 'cuda' : 'cpu'
}

function defaultLabel(tag: string, accel: RuntimeAccel, input: AddInput, source: string): string {
  const name = input.kind === 'github' ? source.replace('https://github.com/', '') : basename(source).replace(/\.(zip|tar\.gz|tgz)$/i, '')
  return [tag, accel === 'metal' ? '' : accel.toUpperCase(), name === tag ? '' : name].filter(Boolean).join(' · ').slice(0, 80)
}

async function defaultClearQuarantine(root: string): Promise<void> {
  await new Promise<void>((res) => {
    const c = spawn('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', root], { stdio: 'ignore', shell: false })
    c.on('error', () => res())
    c.on('close', () => res())
  })
}
