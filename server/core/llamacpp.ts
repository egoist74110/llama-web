// llama.cpp runtime acquisition: find installed versions under data/runtime/llama.cpp and, when
// there is none, download the latest official Release (CUDA build + cudart), verify SHA-256 and
// unpack into a version directory. The version directory only appears (by rename) once it is
// complete, so a failed download never leaves a half-installed version. The full update /
// rollback flow is stage 4 (updater); this module is the initial-fetch part.
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkExtractedTree, extractArchive, type ArchiveOptions } from './archive'
import { pickCuda, type CudaLimits } from './cuda'
import { legacyWindows, targetKey, type RuntimeTarget } from './platform'

const REPO = 'ggml-org/llama.cpp'
const TAG_RE = /^b\d+$/

export type RuntimeErrorCode =
  | 'network' | 'no-nightly-tag' | 'bad-tag' | 'asset-missing' | 'no-digest' | 'digest-mismatch' | 'extract-failed' | 'no-server-exe' | 'no-compatible-cuda'

export class RuntimeError extends Error {
  constructor(public code: RuntimeErrorCode, message: string, public detail?: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}

export const versionsDir = (dataDir: string, target?: RuntimeTarget) => join(dataDir, 'runtime', 'llama.cpp', ...(target ? [targetKey(target)] : []))
export const serverExeName = (platform = process.platform) => (platform === 'win32' ? 'llama-server.exe' : 'llama-server')

/** Installed version tags (`b1234`) that contain a llama-server binary, newest first. */
export function listInstalled(dataDir: string, platform = process.platform, target?: RuntimeTarget): string[] {
  if (target) return [...new Set([
    ...listTags(versionsDir(dataDir, target), target.os),
    ...(legacyWindows(target) ? listTags(versionsDir(dataDir), 'win32') : []),
  ])].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
  return listTags(versionsDir(dataDir), platform)
}
function listTags(dir: string, platform: NodeJS.Platform): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter(n => TAG_RE.test(n) && existsSync(join(dir, n, serverExeName(platform))))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
}
export function installedDir(dataDir: string, tag: string, target?: RuntimeTarget): string {
  const scoped = join(versionsDir(dataDir, target), tag)
  if (target && legacyWindows(target) && !existsSync(join(scoped, serverExeName(target.os)))) {
    const old = join(versionsDir(dataDir), tag)
    if (existsSync(join(old, 'llama-server.exe'))) return old
  }
  return scoped
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  /** `sha256:<hex>` as published by GitHub. */
  digest?: string | null
  /** Size in bytes as published by GitHub (absent in test fixtures). */
  size?: number
}

export interface LatestBuild {
  tag: string
  bin: ReleaseAsset
  cudart?: ReleaseAsset
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const HEADERS = { 'User-Agent': 'llama-web', Accept: 'application/vnd.github+json' }

/**
 * Limits for the update / download HTTP calls. `signal` cancels everything (shutdown). `timeoutMs`
 * bounds a whole small request (answer and body); `stallMs` bounds the wait for the answer of a
 * download and then the silence between two chunks of its body (a big file may take as long as it needs).
 */
export interface NetOptions {
  signal?: AbortSignal
  timeoutMs?: number
  stallMs?: number
  /** Download progress: bytes received so far and the announced size (null when unknown). */
  onProgress?: (received: number, total: number | null) => void
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_STALL_MS = 30_000

/**
 * Settles like `p`, but rejects as soon as `signal` aborts (also when `p` itself ignores the signal).
 * `p` always gets its handlers first, so a rejection of `p` after the abort is never unhandled.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Controller that aborts with the outer signal or after `ms` of `arm`ed time. Own timers: Bun's AbortSignal.timeout does not keep tests honest. */
function guard(outer: AbortSignal | undefined, ms: number) {
  const ac = new AbortController()
  const onOuter = () => ac.abort(outer!.reason ?? new Error('aborted'))
  if (outer?.aborted) onOuter()
  else outer?.addEventListener('abort', onOuter, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms2 = ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => ac.abort(new Error('timeout')), ms2)
  }
  arm()
  return {
    signal: ac.signal,
    arm,
    done() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    },
  }
}

async function fetchChecked(fetchFn: FetchFn, url: string, signal: AbortSignal): Promise<Response> {
  let res: Response
  try {
    // Already cancelled (shutdown while an earlier step was still running): do not start a request at all.
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    res = await abortable(fetchFn(url, { headers: HEADERS, signal }), signal)
  } catch (e) {
    throw new RuntimeError('network', `Cannot reach ${new URL(url).host}`, (e as Error)?.message ?? String(e))
  }
  if (!res.ok) throw new RuntimeError('network', `${new URL(url).host} answered ${res.status}`, url)
  return res
}

/** GET with a limit on the wait for the answer; the body is the caller's (see `download`). */
export async function getOk(fetchFn: FetchFn, url: string, net: NetOptions = {}): Promise<Response> {
  const g = guard(net.signal, net.stallMs ?? net.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    return await fetchChecked(fetchFn, url, g.signal)
  } finally {
    g.done()
  }
}

/** GET and read the whole body as JSON / text within `timeoutMs`. */
export async function getBody(fetchFn: FetchFn, url: string, kind: 'json' | 'text', net: NetOptions = {}): Promise<unknown> {
  const g = guard(net.signal, net.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchChecked(fetchFn, url, g.signal)
    try {
      return await abortable(kind === 'json' ? res.json() : res.text(), g.signal)
    } catch (e) {
      throw new RuntimeError('network', `Cannot read ${new URL(url).host}`, (e as Error)?.message ?? String(e))
    }
  } finally {
    g.done()
  }
}

/**
 * The official "latest" release only carries a pointer (nightly-tag.txt) to the newest binary
 * build; resolve it, then pick that build's CUDA assets.
 */
export async function resolveLatest(fetchFn: FetchFn, cudaRuntime: string, platform = process.platform, net: NetOptions = {}, target?: RuntimeTarget, limits?: CudaLimits | null): Promise<LatestBuild> {
  const stable = await getBody(fetchFn, `https://api.github.com/repos/${REPO}/releases/latest`, 'json', net) as { assets?: ReleaseAsset[] }
  const pointer = stable.assets?.find(a => a.name === 'nightly-tag.txt')
  if (!pointer) throw new RuntimeError('no-nightly-tag', 'nightly-tag.txt not found in the latest release')
  const tag = String(await getBody(fetchFn, pointer.browser_download_url, 'text', net)).trim()
  if (!TAG_RE.test(tag)) throw new RuntimeError('bad-tag', 'Unexpected nightly tag', tag)
  const rel = await getBody(fetchFn, `https://api.github.com/repos/${REPO}/releases/tags/${tag}`, 'json', net) as { assets?: ReleaseAsset[] }
  const os = platform === 'win32' ? 'win' : 'linux'
  const assets = rel.assets ?? []
  if (target && target.acceleration !== 'cuda') {
    const name = target.os === 'win32' ? `llama-${tag}-bin-win-cpu-${target.arch}.zip`
      : target.os === 'darwin' ? `llama-${tag}-bin-macos-${target.arch}.tar.gz` : ''
    const bin = assets.find(a => a.name === name)
    if (!bin) throw new RuntimeError('asset-missing', 'Release asset not found', name || `${target.os}/${target.arch}`)
    return { tag, bin }
  }
  if (target && (target.os !== 'win32' || target.arch !== 'x64')) throw new RuntimeError('asset-missing', 'Unsupported CUDA target')
  const pair = (cuda: string) => ({
    bin: assets.find(a => a.name === `llama-${tag}-bin-${os}-cuda-${cuda}-x64.zip`),
    cudart: assets.find(a => a.name === `cudart-llama-bin-${os}-cuda-${cuda}-x64.zip`),
  })
  const names = assets.map(a => a.name)
  // Empty `cudaRuntime` = automatic: the newest runtime the driver and GPU can run (decision 37); a value is the user's override.
  const cuda = cudaRuntime ? pickCudaVersion(names, tag, os, cudaRuntime) : pickCuda(cudaVersions(names, tag, os), limits ?? null)
  const { bin, cudart } = pair(cuda ?? cudaRuntime)
  if (!bin) throw new RuntimeError('asset-missing', 'Release asset not found', `llama-${tag}-bin-${os}-cuda-${cudaRuntime}-x64.zip`)
  if (!cudart) throw new RuntimeError('asset-missing', 'Release asset not found', `cudart-llama-bin-${os}-cuda-${cudaRuntime}-x64.zip`)
  return { tag, bin, cudart }
}

/** CUDA versions (`13.3`) a release ships with both the build and its cudart. */
export function cudaVersions(names: string[], tag: string, os: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const binRe = new RegExp(`^llama-${esc(tag)}-bin-${os}-cuda-(\\d+)\\.(\\d+)-x64\\.zip$`)
  return names
    .map(n => binRe.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .filter(m => names.includes(`cudart-llama-bin-${os}-cuda-${m[1]}.${m[2]}-x64.zip`))
    .map(m => `${m[1]}.${m[2]}`)
}

/**
 * CUDA version to download: the configured one when the release has it, otherwise the newest
 * minor of the same major (CUDA minor-version compatibility; releases move e.g. 13.3 → 13.4).
 * Only versions that ship both the build and the matching cudart count. Null when none fits.
 */
export function pickCudaVersion(names: string[], tag: string, os: string, wanted: string): string | null {
  const available = cudaVersions(names, tag, os).map(v => ({ v, major: Number(v.split('.')[0]), minor: Number(v.split('.')[1]) }))
  if (available.some(a => a.v === wanted)) return wanted
  const major = Number(wanted.split('.')[0])
  const same = available.filter(a => a.major === major).sort((a, b) => b.minor - a.minor)
  return same[0]?.v ?? null
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

/**
 * Download one asset to `file` and check its SHA-256; returns the SHA-256 of the file. A stalled
 * connection or a shutdown ends it as `network`. Without a published digest it fails (`no-digest`)
 * unless `allowMissingDigest` is set (hand-added sources: the caller shows the value and asks).
 */
export async function download(fetchFn: FetchFn, asset: ReleaseAsset, file: string, net: NetOptions = {}, allowMissingDigest = false): Promise<string> {
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (!expected && !allowMissingDigest) throw new RuntimeError('no-digest', 'Release asset has no SHA-256 digest', asset.name)
  const stall = net.stallMs ?? DEFAULT_STALL_MS
  const g = guard(net.signal, stall)
  try {
    const res = await fetchChecked(fetchFn, asset.browser_download_url, g.signal)
    if (!res.body) throw new RuntimeError('network', 'Empty response body', asset.name)
    try {
      const src = Readable.fromWeb(res.body as never)
      const size = Number(res.headers.get('content-length'))
      const total = Number.isSafeInteger(size) && size > 0 ? size : null
      let received = 0
      g.arm()
      src.on('data', (chunk: Buffer) => {
        g.arm()
        received += chunk.length
        net.onProgress?.(received, total)
      })
      await pipeline(src, createWriteStream(file), { signal: g.signal })
    } catch (e) {
      throw new RuntimeError('network', `Download interrupted: ${asset.name}`, (e as Error).message)
    }
  } finally {
    g.done()
  }
  const actual = await sha256File(file)
  if (expected && actual !== expected) throw new RuntimeError('digest-mismatch', `SHA-256 mismatch: ${asset.name}`)
  return actual
}

/** Compatibility alias for the bounded system archive installer. */
export const extractZip = extractArchive

export interface InstallOptions {
  dataDir: string
  /** Empty = automatic (newest runtime the machine can run, see cuda.ts). */
  cudaRuntime: string
  cudaLimits?: CudaLimits | null
  fetch?: FetchFn
  extract?: (zip: string, dest: string, options?: ArchiveOptions) => Promise<void>
  platform?: NodeJS.Platform
  target?: RuntimeTarget
  /** Time limits and the shutdown signal of the HTTP calls. */
  net?: ArchiveOptions
  onStep?: (step: 'resolve' | 'download' | 'extract', detail: string) => void
}

/** Where the binaries ended up: the root of the extraction, or its only sub-directory. */
function findRoot(dir: string, exe: string): string | null {
  if (!existsSync(dir)) return null
  if (existsSync(join(dir, exe))) return dir
  const subs = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory())
  return subs.length === 1 && existsSync(join(dir, subs[0]!, exe)) ? join(dir, subs[0]!) : null
}

/** Leftovers of an interrupted install (`.tmp-`) or removal (`.del-`) never count as a version; clear them. */
export function clearLeftovers(dataDir: string, target?: RuntimeTarget): void {
  if (target && legacyWindows(target)) clearLeftovers(dataDir)
  const base = versionsDir(dataDir, target)
  let names: string[]
  try { names = readdirSync(base) } catch { return }
  for (const n of names) {
    if (n.startsWith('.tmp-') || n.startsWith('.del-')) {
      try { rmSync(join(base, n), { recursive: true, force: true }) } catch { /* still locked: next start */ }
    }
  }
}

/**
 * Download, verify and install one resolved build; returns its tag. Already installed => no download.
 * Everything happens in a `.tmp-` work directory; the version directory only appears by the final
 * rename, so an interrupted download / extract never leaves a usable-looking half version.
 */
export async function installBuild(build: LatestBuild, opts: InstallOptions): Promise<string> {
  const platform = opts.target?.os ?? opts.platform ?? process.platform
  const fetchFn = opts.fetch ?? fetch
  const extract = opts.extract ?? extractZip
  const exe = serverExeName(platform)
  if (!TAG_RE.test(build.tag)) throw new RuntimeError('bad-tag', 'Invalid build tag')
  const base = versionsDir(opts.dataDir, opts.target)
  mkdirSync(base, { recursive: true })
  const dest = join(base, build.tag)
  if (listInstalled(opts.dataDir, platform, opts.target).includes(build.tag)) return build.tag

  const work = join(base, `.tmp-${build.tag}-${process.pid}`)
  try {
    mkdirSync(join(work, 'dl'), { recursive: true })
    const extracted = join(work, 'out')
    for (const asset of [build.bin, build.cudart].filter((a): a is ReleaseAsset => !!a)) {
      if (asset.name !== asset.name.split(/[\\/]/).pop() || !/\.(zip|tar\.gz|tgz)$/.test(asset.name)) throw new RuntimeError('extract-failed', 'Invalid archive name')
      const zip = join(work, 'dl', asset.name)
      opts.onStep?.('download', asset.name)
      await download(fetchFn, asset, zip, opts.net)
      opts.onStep?.('extract', asset.name)
      await extract(zip, extracted, opts.net)
      if (opts.net?.signal?.aborted) throw new RuntimeError('extract-failed', 'Extraction cancelled')
    }
    const root = findRoot(extracted, exe)
    if (!root) throw new RuntimeError('no-server-exe', `${exe} not found in the downloaded archive`)
    checkExtractedTree(root)
    if (platform !== 'win32') chmodSync(join(root, exe), 0o755)
    rmSync(dest, { recursive: true, force: true }) // an incomplete directory without the exe
    renameSync(root, dest)
    return build.tag
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Resolve the latest build and install it; returns its tag. */
export async function installLatest(opts: InstallOptions): Promise<string> {
  clearLeftovers(opts.dataDir, opts.target)
  opts.onStep?.('resolve', '')
  const latest = await resolveLatest(opts.fetch ?? fetch, opts.cudaRuntime, opts.platform ?? process.platform, opts.net, opts.target, opts.cudaLimits)
  return installBuild(latest, opts)
}

/**
 * llama.cpp status shown on the page. `ready.note`: `latest` = the current version is the newest
 * release; `updated` = it was just downloaded (from the previous `from`); `pinned` = a version picked
 * by hand stays current although `latest` is installed; `auto-off` = no check (autoUpdate off);
 * `switched` = picked on the settings page just now (rollback).
 * `error.using` is the installed version that keeps being used after a failed check / download.
 */
export type RuntimeStatus =
  | { state: 'idle' }
  | { state: 'disabled' }
  | { state: 'working', step: 'resolve' | 'download' | 'extract', detail: string, tag?: string }
  | { state: 'ready', tag: string, note?: 'latest' | 'updated' | 'pinned' | 'auto-off' | 'switched', from?: string | null, latest?: string }
  | { state: 'error', code: string, detail: string, using?: string | null }
