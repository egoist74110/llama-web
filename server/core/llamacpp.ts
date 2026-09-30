// llama.cpp runtime acquisition: find installed versions under data/runtime/llama.cpp and, when
// there is none, download the latest official Release (CUDA build + cudart), verify SHA-256 and
// unpack into a version directory. The version directory only appears (by rename) once it is
// complete, so a failed download never leaves a half-installed version. The full update /
// rollback flow is stage 4 (updater); this module is the initial-fetch part.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'ggml-org/llama.cpp'
const TAG_RE = /^b\d+$/

export type RuntimeErrorCode =
  | 'network' | 'no-nightly-tag' | 'bad-tag' | 'asset-missing' | 'no-digest' | 'digest-mismatch' | 'extract-failed' | 'no-server-exe'

export class RuntimeError extends Error {
  constructor(public code: RuntimeErrorCode, message: string, public detail?: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}

export const versionsDir = (dataDir: string) => join(dataDir, 'runtime', 'llama.cpp')
export const serverExeName = (platform = process.platform) => (platform === 'win32' ? 'llama-server.exe' : 'llama-server')

/** Installed version tags (`b1234`) that contain a llama-server binary, newest first. */
export function listInstalled(dataDir: string, platform = process.platform): string[] {
  const dir = versionsDir(dataDir)
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

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  /** `sha256:<hex>` as published by GitHub. */
  digest?: string | null
}

export interface LatestBuild {
  tag: string
  bin: ReleaseAsset
  cudart: ReleaseAsset
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const HEADERS = { 'User-Agent': 'llama-web', Accept: 'application/vnd.github+json' }

async function getOk(fetchFn: FetchFn, url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: HEADERS })
  } catch (e) {
    throw new RuntimeError('network', `Cannot reach ${new URL(url).host}`, (e as Error).message)
  }
  if (!res.ok) throw new RuntimeError('network', `${new URL(url).host} answered ${res.status}`, url)
  return res
}

/**
 * The official "latest" release only carries a pointer (nightly-tag.txt) to the newest binary
 * build; resolve it, then pick that build's CUDA assets.
 */
export async function resolveLatest(fetchFn: FetchFn, cudaRuntime: string, platform = process.platform): Promise<LatestBuild> {
  const stable = await (await getOk(fetchFn, `https://api.github.com/repos/${REPO}/releases/latest`)).json() as { assets?: ReleaseAsset[] }
  const pointer = stable.assets?.find(a => a.name === 'nightly-tag.txt')
  if (!pointer) throw new RuntimeError('no-nightly-tag', 'nightly-tag.txt not found in the latest release')
  const tag = (await (await getOk(fetchFn, pointer.browser_download_url)).text()).trim()
  if (!TAG_RE.test(tag)) throw new RuntimeError('bad-tag', 'Unexpected nightly tag', tag)
  const rel = await (await getOk(fetchFn, `https://api.github.com/repos/${REPO}/releases/tags/${tag}`)).json() as { assets?: ReleaseAsset[] }
  const os = platform === 'win32' ? 'win' : 'linux'
  const binName = `llama-${tag}-bin-${os}-cuda-${cudaRuntime}-x64.zip`
  const dllName = `cudart-llama-bin-${os}-cuda-${cudaRuntime}-x64.zip`
  const bin = rel.assets?.find(a => a.name === binName)
  const cudart = rel.assets?.find(a => a.name === dllName)
  if (!bin) throw new RuntimeError('asset-missing', 'Release asset not found', binName)
  if (!cudart) throw new RuntimeError('asset-missing', 'Release asset not found', dllName)
  return { tag, bin, cudart }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

async function download(fetchFn: FetchFn, asset: ReleaseAsset, file: string): Promise<void> {
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (!expected) throw new RuntimeError('no-digest', 'Release asset has no SHA-256 digest', asset.name)
  const res = await getOk(fetchFn, asset.browser_download_url)
  if (!res.body) throw new RuntimeError('network', 'Empty response body', asset.name)
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file))
  } catch (e) {
    throw new RuntimeError('network', `Download interrupted: ${asset.name}`, (e as Error).message)
  }
  const actual = await sha256File(file)
  if (actual !== expected) throw new RuntimeError('digest-mismatch', `SHA-256 mismatch: ${asset.name}`)
}

/** Unzip with the system tool (bsdtar ships with Windows 10+; `unzip` elsewhere). No extra dependency. */
export function extractZip(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  const [cmd, args] = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]
    : ['unzip', ['-q', '-o', zip, '-d', dest]]
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', e => reject(new RuntimeError('extract-failed', `Cannot run ${cmd}`, e.message)))
    p.on('close', code => (code === 0 ? resolve() : reject(new RuntimeError('extract-failed', `Extract failed (${code})`, err.trim().slice(0, 500)))))
  })
}

export interface InstallOptions {
  dataDir: string
  cudaRuntime: string
  fetch?: FetchFn
  extract?: (zip: string, dest: string) => Promise<void>
  platform?: NodeJS.Platform
  onStep?: (step: 'resolve' | 'download' | 'extract', detail: string) => void
}

/** Where the binaries ended up: the root of the extraction, or its only sub-directory. */
function findRoot(dir: string, exe: string): string | null {
  if (!existsSync(dir)) return null
  if (existsSync(join(dir, exe))) return dir
  const subs = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory())
  return subs.length === 1 && existsSync(join(dir, subs[0]!, exe)) ? join(dir, subs[0]!) : null
}

/** Download and install the latest build; returns its tag. Already installed => no download. */
export async function installLatest(opts: InstallOptions): Promise<string> {
  const platform = opts.platform ?? process.platform
  const fetchFn = opts.fetch ?? fetch
  const extract = opts.extract ?? extractZip
  const exe = serverExeName(platform)
  const base = versionsDir(opts.dataDir)
  mkdirSync(base, { recursive: true })

  // Leftovers of an interrupted install never count as a version; clear them.
  for (const n of readdirSync(base)) if (n.startsWith('.tmp-')) rmSync(join(base, n), { recursive: true, force: true })

  opts.onStep?.('resolve', '')
  const latest = await resolveLatest(fetchFn, opts.cudaRuntime, platform)
  const dest = join(base, latest.tag)
  if (existsSync(join(dest, exe))) return latest.tag

  const work = join(base, `.tmp-${latest.tag}-${process.pid}`)
  try {
    mkdirSync(join(work, 'dl'), { recursive: true })
    const extracted = join(work, 'out')
    for (const asset of [latest.bin, latest.cudart]) {
      const zip = join(work, 'dl', asset.name)
      opts.onStep?.('download', asset.name)
      await download(fetchFn, asset, zip)
      opts.onStep?.('extract', asset.name)
      await extract(zip, extracted)
    }
    const root = findRoot(extracted, exe)
    if (!root) throw new RuntimeError('no-server-exe', `${exe} not found in the downloaded archive`)
    rmSync(dest, { recursive: true, force: true }) // an incomplete directory without the exe
    renameSync(root, dest)
    return latest.tag
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export type RuntimeStatus =
  | { state: 'idle' }
  | { state: 'disabled' }
  | { state: 'working', step: 'resolve' | 'download' | 'extract', detail: string }
  | { state: 'ready', tag: string }
  | { state: 'error', code: string, detail: string }

export interface EnsureOptions extends Omit<InstallOptions, 'onStep'> {
  /** Current `llamacpp.current` from settings. */
  current: string
  /** Initial download is allowed (settings.llamacpp.autoUpdate). */
  allowDownload: boolean
  setCurrent: (tag: string) => void
  onStatus?: (s: RuntimeStatus) => void
}

/**
 * Make sure `llamacpp.current` points at an installed version. Keeps a valid setting, adopts
 * an installed version when the setting is empty or stale, and downloads only when none exists.
 */
export async function ensureRuntime(opts: EnsureOptions): Promise<RuntimeStatus> {
  const platform = opts.platform ?? process.platform
  const set = (s: RuntimeStatus) => { opts.onStatus?.(s); return s }
  const installed = listInstalled(opts.dataDir, platform)
  if (opts.current && installed.includes(opts.current)) return set({ state: 'ready', tag: opts.current })
  if (installed.length > 0) {
    opts.setCurrent(installed[0]!)
    return set({ state: 'ready', tag: installed[0]! })
  }
  if (!opts.allowDownload) return set({ state: 'disabled' })
  try {
    const tag = await installLatest({ ...opts, onStep: (step, detail) => set({ state: 'working', step, detail }) })
    opts.setCurrent(tag)
    return set({ state: 'ready', tag })
  } catch (e) {
    if (e instanceof RuntimeError) return set({ state: 'error', code: e.code, detail: e.detail ?? e.message })
    return set({ state: 'error', code: 'unknown', detail: (e as Error).message })
  }
}
