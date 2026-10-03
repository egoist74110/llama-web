// Cloudflare tunnel hosting (plan 阶段 4, 4-4): find (or download) cloudflared, run
// `cloudflared tunnel run` with the tunnel token and watch it. Pure module (no Nitro).
// Quick mode (阶段 7, decision 31) runs `cloudflared tunnel --url http://127.0.0.1:<port>` instead:
// no token, no account; the random *.trycloudflare.com address is read from its output.
//
// - The token comes from data/secrets.json and is handed to the child through the TUNNEL_TOKEN
//   environment variable (same effect as `--token`, but not visible in the process list).
//   It never appears in status, events or output: every line is redacted before it is kept.
// - The executable that runs always lives under data/runtime/cloudflared/ (a detected system
//   install is copied there), so the startup residue cleanup, which only kills processes whose
//   executable is under data/runtime/, also covers a tunnel left behind by a hard kill.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { download, getBody, RuntimeError, type FetchFn, type NetOptions, type ReleaseAsset } from './llamacpp'
import type { TunnelMode, TunnelProtocol } from './config'
import type { PublicStatus } from './public-entry'
import { killTree, type PidRegistry } from './runner'
import { cloudflaredAssetName } from './platform'
import { extractArchive, type ArchiveOptions } from './archive'

// ---------------------------------------------------------------------------------------
// Token

export type TunnelErrorCode = 'bad-token' | 'download-failed' | 'prepare-failed' | 'spawn-failed' | 'exited'

export class TunnelError extends Error {
  constructor(public code: TunnelErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'TunnelError'
  }
}

const TOKEN_IN_TEXT = /eyJ[A-Za-z0-9+/_-]{16,}={0,2}/
const MAX_PASTE = 4000

/** Decoded `{ a: account, t: tunnel id, s: secret }` of a tunnel token, or null when it is not one. */
function decodeToken(token: string): { a: string, t: string, s: string } | null {
  try {
    const o = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<string, unknown>
    return typeof o.a === 'string' && typeof o.t === 'string' && typeof o.s === 'string' && o.s ? { a: o.a, t: o.t, s: o.s } : null
  } catch {
    return null
  }
}

/** Tunnel id inside a tunnel token (a UUID), or null. */
export function tunnelIdOf(token: string | null | undefined): string | null {
  const t = token ? decodeToken(token)?.t : null
  return t && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) ? t.toLowerCase() : null
}

/**
 * The tunnel token inside what the user pasted. The Cloudflare page shows it inside a command
 * (`cloudflared.exe service install eyJ…`); both the bare token and the whole command work.
 * Throws `bad-token` (never echoing the input).
 */
export function extractToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_PASTE) throw new TunnelError('bad-token')
  const m = TOKEN_IN_TEXT.exec(raw.trim())
  if (!m || !decodeToken(m[0])) throw new TunnelError('bad-token')
  return m[0]
}

/** `eyJh…wxYz`: enough to recognise which token is saved, not enough to use it. */
export function maskToken(token: string): string {
  return token.length < 12 ? '…' : `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** Remove the token (and its secret part), anything shaped like one, and `--token x` / `TUNNEL_TOKEN=x`. */
export function redact(text: string, token?: string | null): string {
  let out = text
  if (token) {
    out = out.split(token).join('[token]')
    const secret = decodeToken(token)?.s
    if (secret && secret.length >= 8) out = out.split(secret).join('[secret]')
  }
  return out
    .replace(/eyJ[A-Za-z0-9+/_=-]{16,}/g, '[token]')
    .replace(/(TUNNEL_TOKEN=|--token[= ])\S+/gi, '$1[token]')
}

// ---------------------------------------------------------------------------------------
// Finding / installing cloudflared

export const cloudflaredName = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
export const cloudflaredDir = (dataDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch) => join(dataDir, 'runtime', 'cloudflared', `${platform}-${arch}`)
export const cloudflaredPath = (dataDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch) => join(cloudflaredDir(dataDir, platform, arch), cloudflaredName(platform))

/** Places a system-wide cloudflared usually lives: PATH first, then the common install locations. */
export function candidatePaths(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === 'win32' ? win32 : posix
  const name = cloudflaredName(platform)
  const out: string[] = []
  const pathVar = env.PATH ?? env.Path ?? env.path ?? ''
  for (const dir of pathVar.split(p.delimiter)) if (dir.trim()) out.push(p.join(dir.trim().replace(/^"(.*)"$/, '$1'), name))
  const add = (base: string | undefined, ...rest: string[]) => { if (base) out.push(p.join(base, ...rest, name)) }
  if (platform === 'win32') {
    add(env.ProgramFiles, 'cloudflared')
    add(env['ProgramFiles(x86)'], 'cloudflared')
    add(env.ProgramFiles, 'Cloudflare', 'Cloudflared')
    add(env.LOCALAPPDATA, 'cloudflared')
    add(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')
    add(env.USERPROFILE, 'cloudflared')
    add(env.USERPROFILE, 'scoop', 'shims')
    add(env.USERPROFILE, 'scoop', 'apps', 'cloudflared', 'current')
  } else {
    for (const d of ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']) out.push(p.join(d, name))
  }
  return [...new Set(out)]
}

export interface FindOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
  /** Paths to ignore (our own copy). */
  skip?: string[]
}

/** First existing cloudflared outside data/runtime, or null. */
export function findCloudflared(opts: FindOptions = {}): string | null {
  const exists = opts.exists ?? ((f: string) => { try { return statSync(f).isFile() } catch { return false } })
  const platform = opts.platform ?? process.platform
  const norm = (f: string) => (platform === 'win32' ? f.toLowerCase() : f)
  const skip = new Set((opts.skip ?? []).map(norm))
  return candidatePaths(opts.env, platform).find(f => !skip.has(norm(f)) && exists(f)) ?? null
}

const REPO = 'cloudflare/cloudflared'

export const releaseAssetName = cloudflaredAssetName

/** The official latest release's asset for this machine (with the SHA-256 GitHub publishes for it). */
export async function resolveCloudflared(fetchFn: FetchFn, platform: NodeJS.Platform = process.platform, net: NetOptions = {}, arch: string = process.arch): Promise<ReleaseAsset> {
  const name = releaseAssetName(platform, arch)
  if (!name) throw new RuntimeError('asset-missing', 'No cloudflared build for this platform', `${platform}/${process.arch}`)
  const rel = await getBody(fetchFn, `https://api.github.com/repos/${REPO}/releases/latest`, 'json', net) as { assets?: ReleaseAsset[] }
  const asset = rel.assets?.find(a => a.name === name)
  if (!asset) throw new RuntimeError('asset-missing', 'Release asset not found', name)
  return asset
}

export interface PrepareOptions {
  dataDir: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  arch?: string
  extract?: typeof extractArchive
  fetch?: FetchFn
  exists?: (file: string) => boolean
  /** Time limits and the cancel signal of the download. */
  net?: ArchiveOptions
  onStep?(step: 'find' | 'download', detail: string): void
}

let workSeq = 0

export interface PreparedCloudflared {
  /** Always under data/runtime/cloudflared/. */
  exe: string
  /** `system`: copied from an installation found on this machine; `downloaded`: official Release. */
  source: 'system' | 'downloaded'
}

function sizeAndTime(file: string): { size: number, mtimeMs: number } | null {
  try {
    const s = statSync(file)
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null
  } catch { return null }
}

/**
 * Get a runnable cloudflared under data/runtime/cloudflared/: copy an installed one (PATH, common
 * locations) when found, else keep what is there, else download the official build and verify its SHA-256.
 */
export async function prepareCloudflared(opts: PrepareOptions): Promise<PreparedCloudflared> {
  const platform = opts.platform ?? process.platform
  const dest = cloudflaredPath(opts.dataDir, platform, opts.arch)
  opts.onStep?.('find', '')
  const legacy = join(opts.dataDir, 'runtime', 'cloudflared', 'cloudflared.exe')
  const found = findCloudflared({ env: opts.env, platform, exists: opts.exists, skip: [dest] })
    ?? (platform === 'win32' && (opts.arch ?? process.arch) === 'x64' && sizeAndTime(legacy) ? legacy : null)
  if (found) {
    const src = sizeAndTime(found)
    const have = sizeAndTime(dest)
    // Copy again only when the installed one changed (size differs or it is newer than our copy).
    if (!have || (src && (src.size !== have.size || src.mtimeMs > have.mtimeMs))) {
      try {
        mkdirSync(dirname(dest), { recursive: true })
        const tmp = `${dest}.${process.pid}.tmp`
        copyFileSync(found, tmp)
        if (platform !== 'win32') chmodSync(tmp, 0o755)
        try { renameSync(tmp, dest) } catch (e) { rmSync(tmp, { force: true }); throw e }
      } catch (e) {
        if (!have) throw new TunnelError('prepare-failed', (e as Error).message)
        // The old copy is in use or locked: it still works.
      }
    }
    return { exe: dest, source: 'system' }
  }
  if (sizeAndTime(dest)) return { exe: dest, source: 'downloaded' }

  const fetchFn = opts.fetch ?? fetch
  // Unique per call: two overlapping preparations never share (or delete) each other's file.
  const work = `${dest}.${process.pid}.${++workSeq}.dl`
  const unpack = `${work}.out`
  try {
    opts.onStep?.('download', '')
    const asset = await resolveCloudflared(fetchFn, platform, opts.net, opts.arch)
    mkdirSync(dirname(dest), { recursive: true })
    const archive = /\.(tgz|tar\.gz|zip)$/.test(asset.name)
    const payload = archive ? `${work}.tgz` : work
    try {
      await download(fetchFn, asset, payload, opts.net)
      let binary = payload
      if (archive) {
        await (opts.extract ?? extractArchive)(payload, unpack, opts.net)
        binary = join(unpack, cloudflaredName(platform))
        if (!sizeAndTime(binary)) throw new RuntimeError('extract-failed', 'cloudflared not found in archive')
      }
      if (opts.net?.signal?.aborted) throw new RuntimeError('extract-failed', 'Preparation cancelled')
      if (platform !== 'win32') chmodSync(binary, 0o755)
      renameSync(binary, dest)
    } finally { rmSync(payload, { force: true }) }
    return { exe: dest, source: 'downloaded' }
  } catch (e) {
    if (e instanceof TunnelError) throw e
    if (e instanceof RuntimeError) throw new TunnelError('download-failed', `${e.code}: ${e.message}`)
    throw new TunnelError('prepare-failed', (e as Error).message)
  } finally {
    rmSync(work, { force: true })
    rmSync(unpack, { recursive: true, force: true })
  }
}

/** `cloudflared --version` → `2025.9.1`, or null. */
export function cloudflaredVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : /version\s+(\S+)/i.exec(String(stdout))?.[1] ?? null)
    })
  })
}

// ---------------------------------------------------------------------------------------
// Process management

export type TunnelOffReason = 'disabled' | 'no-token' | 'public-off' | 'public-unavailable' | 'public-error'

export type TunnelStatus =
  | { state: 'off', reason: TunnelOffReason }
  | { state: 'preparing', step: 'find' | 'download' }
  /** Process running, no connection to Cloudflare yet. `lastError` is the latest ERR line (redacted). */
  | { state: 'starting', lastError: string | null }
  | { state: 'connected', connections: number }
  /** `retryAt` (epoch ms) is when it starts again by itself; null = needs the user (bad token). */
  | { state: 'error', code: TunnelErrorCode, detail: string, retryAt: number | null, tail: string[] }

export interface TunnelInfo {
  status: TunnelStatus
  /** Mode of the tunnel that is (or was last) set up; null before the first start. */
  mode: TunnelMode | null
  cloudflared: { source: 'system' | 'downloaded', version: string | null } | null
  /**
   * Host names the tunnel routes to this public entry, from the configuration cloudflared
   * received from Cloudflare (null = not seen yet for this token).
   */
  hostnames: string[] | null
  /**
   * Quick mode: the *.trycloudflare.com host name of the running process, from its output.
   * Null while none was printed yet; cleared on every (re)start and when the process ends.
   */
  quickHost: string | null
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * Host names in a cloudflared `Updated to new configuration config="{…}"` line whose service is
 * this machine's public entry port. Null when the line is not such an update (or cannot be read).
 */
export function ingressHostnames(line: string, port: number): string[] | null {
  if (!/Updated to new configuration/i.test(line)) return null
  const m = /config="((?:[^"\\]|\\.)*)"/.exec(line)
  if (!m) return null
  let cfg: unknown
  try {
    cfg = JSON.parse(JSON.parse(`"${m[1]}"`))
  } catch {
    return null
  }
  const ingress = (cfg as { ingress?: unknown })?.ingress
  if (!Array.isArray(ingress)) return null
  const local = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/?$`, 'i')
  const out: string[] = []
  for (const r of ingress) {
    const host = typeof r?.hostname === 'string' ? r.hostname.toLowerCase() : ''
    if (HOST.test(host) && typeof r.service === 'string' && local.test(r.service) && !out.includes(host)) out.push(host)
  }
  return out
}

/**
 * The quick tunnel's host name in a cloudflared output line (`|  https://a-b-c.trycloudflare.com  |`),
 * or null. Only a single label under trycloudflare.com counts, never the API host
 * (`api.trycloudflare.com`, which shows up in error lines), and never in an error / warning line.
 */
export function quickTunnelHost(line: string): string | null {
  if (/\b(?:ERR|WRN|error)\b/i.test(line)) return null
  const m = /\bhttps:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9.-])/i.exec(line)
  const label = m?.[1]?.toLowerCase()
  return label && label !== 'api' ? `${label}.trycloudflare.com` : null
}

/**
 * Configuration file handed to a quick tunnel with `--config`, so a `~/.cloudflared/config.yml`
 * left by another (named) tunnel is not read: with a `tunnel:` key in it cloudflared refuses to
 * start a quick tunnel. Lives next to our cloudflared copy and is deleted with the data directory.
 */
export const quickConfigPath = (dataDir: string) => join(dataDir, 'runtime', 'cloudflared', 'quick-tunnel.yml')
const QUICK_CONFIG = '# Written by llama-web for the quick tunnel: keeps cloudflared from reading ~/.cloudflared/config.yml.\n{}\n'

/** Write the (empty) quick tunnel configuration when it is missing or different. */
export function ensureQuickConfig(dataDir: string): string {
  const file = quickConfigPath(dataDir)
  let same = false
  try { same = readFileSync(file, 'utf8') === QUICK_CONFIG } catch { /* missing */ }
  if (!same) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, QUICK_CONFIG)
    try { renameSync(tmp, file) } catch (e) { rmSync(tmp, { force: true }); throw e }
  }
  return file
}

/** cloudflared arguments (an array, never a shell string). Token mode passes the token in the environment. */
export function tunnelArgs(mode: TunnelMode, port: number, configFile: string, protocol: TunnelProtocol): string[] {
  const common = ['tunnel', '--no-autoupdate', '--protocol', protocol]
  return mode === 'quick'
    ? [...common, '--config', configFile, '--url', `http://127.0.0.1:${port}`]
    : [...common, 'run']
}

export interface TunnelConfig {
  /** settings.public.tunnelEnabled */
  tunnelEnabled: boolean
  /** settings.public.tunnelMode */
  mode: TunnelMode
  /** settings.public.tunnelProtocol */
  protocol: TunnelProtocol
  /** settings.public.enabled and what the listener is doing. */
  publicEnabled: boolean
  publicState: PublicStatus['state']
  /** The saved tunnel token ('' = none; not used in quick mode). */
  token: string
  /** Public entry port: recorded in pids.json; in quick mode also the tunnel's target. */
  port: number
}

/** What the running process was started with. A different launch means a restart. */
interface Launch {
  mode: TunnelMode
  /** '' in quick mode. */
  token: string
  port: number
  protocol: TunnelProtocol
}

/** Token mode follows the token (the port is in the remote configuration); quick mode its port. Both the protocol. */
const launchKey = (l: Launch) => `${l.protocol}:${l.mode === 'quick' ? `quick:${l.port}` : `token:${l.token}`}`

export interface TunnelManagerOptions {
  dataDir: string
  registry?: PidRegistry
  /** Resolves when startup residue cleanup is done (a fresh process must not be mistaken for residue). */
  ready?: Promise<unknown>
  prepare?: (o: PrepareOptions) => Promise<PreparedCloudflared>
  version?: (exe: string) => Promise<string | null>
  spawn?: typeof spawn
  fetch?: FetchFn
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** Replaces the cloudflared arguments (tests). */
  buildArgs?: (launch: { mode: TunnelMode, port: number, protocol: TunnelProtocol }) => string[]
  /** Waits before automatic restarts after an unexpected exit. */
  retryDelaysMs?: number[]
  /** A connection that lasted this long resets the retry delays. */
  stableMs?: number
  now?: () => number
  onStatus?(info: TunnelInfo): void
  /** Redacted output lines (for logs). */
  onLine?(line: string): void
}

const TAIL_LINES = 200
const ERROR_TAIL = 15
const BAD_TOKEN = /Provided Tunnel token is not valid|Unauthorized: Invalid tunnel secret|invalid tunnel secret|failed to (?:unmarshal|decode|parse) tunnel token/i

export class TunnelManager {
  private cfg: TunnelConfig | null = null
  private active: Launch | null = null
  private gen = 0
  private child: ChildProcess | null = null
  private childDone: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private lines: string[] = []
  private info: TunnelInfo = { status: { state: 'off', reason: 'disabled' }, mode: null, cloudflared: null, hostnames: null, quickHost: null }
  private lastKey = ''
  private hostsToken: string | null = null
  /** The running preparation (find / download cloudflared) and the way to cancel it. */
  private preparing: Promise<unknown> | null = null
  private prepareAbort: AbortController | null = null
  /** A process we killed because it could not be recorded: the next start waits for it. */
  private killing: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: TunnelManagerOptions) {}

  status(): TunnelInfo {
    return this.info
  }

  /** Last redacted output lines. */
  tail(n = ERROR_TAIL): string[] {
    return this.lines.slice(-n)
  }

  /** Bring the tunnel in line with the settings: called at startup and after every settings / token change. */
  apply(cfg: TunnelConfig): void {
    this.cfg = cfg
    this.queue = this.queue.then(() => this.reconcile()).catch(() => {})
  }

  /** Start again now (after an error, instead of waiting for the automatic retry). */
  retry(): void {
    this.queue = this.queue.then(async () => {
      if (this.closed || !this.active || this.child || this.info.status.state === 'preparing') return
      this.attempt = 0
      this.begin()
    }).catch(() => {})
  }

  /** Stop the process and refuse further starts (shutdown). */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.queue
    await this.teardown()
  }

  private offReason(c: TunnelConfig): TunnelOffReason | null {
    if (!c.tunnelEnabled) return 'disabled'
    if (c.mode !== 'quick' && !c.token) return 'no-token'
    if (!c.publicEnabled) return 'public-off'
    if (c.publicState === 'unavailable') return 'public-unavailable'
    if (c.publicState !== 'listening') return 'public-error'
    return null
  }

  private async reconcile(): Promise<void> {
    const cfg = this.cfg
    if (!cfg || this.closed) return
    const reason = this.offReason(cfg)
    if (reason) {
      if (this.active !== null || this.info.status.state !== 'off') await this.teardown()
      this.active = null
      if (!cfg.token) this.forgetHosts()
      this.set({ state: 'off', reason })
      return
    }
    const protocol: TunnelProtocol = cfg.protocol === 'quic' ? 'quic' : 'http2'
    const launch: Launch = cfg.mode === 'quick'
      ? { mode: 'quick', token: '', port: cfg.port, protocol }
      : { mode: 'token', token: cfg.token, port: cfg.port, protocol }
    if (this.active && launchKey(this.active) === launchKey(launch)) return
    await this.teardown()
    this.active = launch
    // Host names belong to a tunnel: a different token may be a different tunnel. A quick tunnel
    // routes none of the user's own host names, so none are shown while it runs (they come back
    // with the configuration cloudflared receives when the own tunnel starts again).
    if (launch.mode === 'quick' || this.hostsToken !== launch.token) this.forgetHosts()
    if (launch.mode === 'token') this.hostsToken = launch.token
    this.info = { ...this.info, mode: launch.mode }
    this.attempt = 0
    this.begin()
  }

  /** Stop the child (if any), cancel timers and invalidate in-flight work. */
  private async teardown(): Promise<void> {
    this.gen++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    // Cancel a download in progress and wait until it has cleaned up: a later start must not overlap it.
    this.prepareAbort?.abort(new Error('stopped'))
    await this.preparing?.catch(() => {})
    await this.killing
    const child = this.child
    if (child) {
      if (child.pid) await killTree(child.pid)
      const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3000)
      await this.childDone
      clearTimeout(t)
    }
    await this.opts.registry?.flushIdentities()
    this.child = null
    this.childDone = null
    this.active = null
    this.info = { ...this.info, quickHost: null }
  }

  private begin(): void {
    const gen = ++this.gen
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    void this.run(gen)
  }

  private async run(gen: number): Promise<void> {
    const launch = this.active
    if (!launch || !this.cfg) return
    const token = launch.token || null
    const stale = () => gen !== this.gen || this.closed
    try {
      await this.opts.ready
      await this.killing
      if (stale()) return
      this.set({ state: 'preparing', step: 'find' })
      const prepare = this.opts.prepare ?? prepareCloudflared
      const abort = new AbortController()
      this.prepareAbort = abort
      const task = prepare({
        dataDir: this.opts.dataDir, env: this.opts.env, platform: this.opts.platform, fetch: this.opts.fetch,
        net: { signal: abort.signal },
        onStep: step => { if (!stale()) this.set({ state: 'preparing', step }) },
      })
      this.preparing = task
      let prepared: PreparedCloudflared
      try {
        prepared = await task
      } finally {
        if (this.preparing === task) { this.preparing = null; this.prepareAbort = null }
      }
      if (stale()) return
      const version = await (this.opts.version ?? cloudflaredVersion)(prepared.exe)
      if (stale()) return
      this.info = { ...this.info, cloudflared: { source: prepared.source, version } }
      const configFile = launch.mode === 'quick' ? ensureQuickConfig(this.opts.dataDir) : ''
      this.spawnChild(gen, prepared.exe, launch, configFile)
    } catch (e) {
      if (stale()) return
      const code: TunnelErrorCode = e instanceof TunnelError ? e.code : 'prepare-failed'
      const detail = redact(e instanceof TunnelError ? e.detail : (e as Error).message, token)
      this.fail(gen, code, detail, [])
    }
  }

  private spawnChild(gen: number, exe: string, launch: Launch, configFile: string): void {
    const { mode, port, protocol } = launch
    const token = launch.token || null
    const args = this.opts.buildArgs?.({ mode, port, protocol }) ?? tunnelArgs(mode, port, configFile, protocol)
    // Quick mode: no token at all, not even one inherited from llama-web's own environment.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.TUNNEL_TOKEN
    if (mode === 'token' && token) env.TUNNEL_TOKEN = token
    // Every start (and restart) gets a new quick address: the old one is gone.
    this.info = { ...this.info, quickHost: null }
    let child: ChildProcess
    try {
      child = (this.opts.spawn ?? spawn)(exe, args, {
        cwd: dirname(exe),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
    } catch (e) {
      this.fail(gen, 'spawn-failed', redact((e as Error).message, token), [])
      return
    }
    let spawnFailed = false
    // Emitted when the executable cannot be started (no pid, no 'exit' follows).
    child.on('error', (e) => { if (!child.pid) { spawnFailed = true; this.fail(gen, 'spawn-failed', redact(e.message, token), []) } })
    if (!child.pid) return
    const pid = child.pid
    // A process that cannot be recorded would be invisible to the residue cleanup: do not keep it.
    // It is not kept as `this.child` either, so a retry (manual or automatic) starts clean.
    try {
      const record = { pid, exe, port, tag: 'tunnel', startedAt: new Date().toISOString(),
        ownerPid: process.pid, pgid: process.platform !== 'win32' ? pid : undefined }
      this.opts.registry?.add(record)
      const identified = this.opts.registry?.identify(record, child) ?? Promise.resolve()
      void identified.catch(e => {
        if (this.child === child) {
          this.killing = killTree(pid).catch(() => {})
          this.fail(gen, 'spawn-failed', redact(`Cannot record process identity: ${(e as Error).message}`, token), [])
        }
      })
    } catch (e) {
      this.killing = killTree(pid).catch(() => {})
      this.fail(gen, 'spawn-failed', redact(`Cannot record pid: ${(e as Error).message}`, token), [])
      return
    }
    this.child = child
    this.lines = []
    this.set({ state: 'starting', lastError: null })

    // Registered connections by connIndex (a repeated line for one index counts once).
    const registered = new Set<string>()
    let anon = 0
    let connections = 0
    let connectedAt = 0
    let badToken = false
    let lastError: string | null = null
    const now = this.opts.now ?? Date.now

    const onLine = (raw: string) => {
      const line = redact(raw, token)
      this.lines.push(line)
      if (this.lines.length > TAIL_LINES) this.lines.splice(0, this.lines.length - TAIL_LINES)
      try { this.opts.onLine?.(line) } catch { /* listeners must not break capture */ }
      if (gen !== this.gen) return
      if (mode === 'quick') {
        const quick = this.info.quickHost ? null : quickTunnelHost(line)
        if (quick) {
          this.info = { ...this.info, quickHost: quick }
          this.set(this.info.status)
        }
      } else if (BAD_TOKEN.test(line)) badToken = true
      const hosts = mode === 'token' ? ingressHostnames(line, port) : null
      if (hosts) {
        this.info = { ...this.info, hostnames: hosts }
        this.set(this.info.status)
      }
      const index = /\bconnIndex=(\d+)/.exec(line)?.[1]
      // "Unregistered tunnel connection" contains "registered tunnel connection": it is tested first, on word boundaries.
      if (/\bUnregistered tunnel connection\b/i.test(line)) {
        registered.delete(index ?? [...registered][0] ?? '')
        connections = registered.size
        if (connections === 0) { connectedAt = 0; this.set({ state: 'starting', lastError }) } else this.set({ state: 'connected', connections })
      } else if (/\bRegistered tunnel connection\b/i.test(line)) {
        registered.add(index ?? `anon${++anon}`)
        connections = registered.size
        if (!connectedAt) connectedAt = now()
        this.set({ state: 'connected', connections })
      } else if (/\bERR\b/.test(line)) {
        const msg = line.replace(/^\S+\s+ERR\s+/, '')
        lastError = msg.length > 300 ? `${msg.slice(0, 300)}…` : msg
        if (connections === 0) this.set({ state: 'starting', lastError })
      }
    }
    pipeLines(child.stdout, onLine)
    pipeLines(child.stderr, onLine)

    let done: () => void
    this.childDone = new Promise<void>((res) => { done = res })
    let exited = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      clearTimeout(exitTimer)
      if (exited) return
      exited = true
      try { this.opts.registry?.remove(pid) } catch { /* registry is best effort */ }
      if (this.child === child) {
        this.child = null
        // The quick address died with the process.
        if (this.info.quickHost) {
          this.info = { ...this.info, quickHost: null }
          this.set(this.info.status)
        }
      }
      done()
      // Stopped on purpose (settings change, shutdown) or replaced: nothing to report.
      if (gen !== this.gen || this.closed || spawnFailed) return
      const stable = connectedAt > 0 && now() - connectedAt >= (this.opts.stableMs ?? 60_000)
      if (stable) this.attempt = 0
      this.fail(gen, badToken ? 'bad-token' : 'exited', badToken ? '' : `exit code ${code ?? '-'}`, this.tail(), !badToken)
    }
    let pending: { code: number | null } | null = null
    // 'exit' can arrive before the last output is read; wait for 'close' but not forever.
    let groupDone: Promise<void> = Promise.resolve()
    child.on('exit', (code) => {
      pending = { code }
      if (process.platform !== 'win32') groupDone = killTree(pid)
      void groupDone.then(() => { if (!exited) { exitTimer = setTimeout(() => finish(pending?.code ?? null), 1000); exitTimer.unref?.() } }, () => finish(pending?.code ?? null))
    })
    child.on('close', code => { void groupDone.then(() => finish(pending?.code ?? code), () => finish(pending?.code ?? code)) })
  }

  private fail(gen: number, code: TunnelErrorCode, detail: string, tail: string[], retry = true): void {
    if (gen !== this.gen || this.closed) return
    const delays = this.opts.retryDelaysMs ?? [5_000, 15_000, 45_000, 120_000, 300_000]
    const delay = retry && code !== 'bad-token' ? delays[Math.min(this.attempt, delays.length - 1)]! : null
    this.attempt++
    const now = this.opts.now ?? Date.now
    this.set({ state: 'error', code, detail, retryAt: delay === null ? null : now() + delay, tail: tail.slice(-ERROR_TAIL) })
    if (delay !== null) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; if (gen === this.gen && !this.closed) this.begin() }, delay)
      this.retryTimer.unref?.()
    }
  }

  private forgetHosts(): void {
    this.hostsToken = null
    this.info = { ...this.info, hostnames: null }
  }

  private set(status: TunnelStatus): void {
    const key = JSON.stringify([status, this.info.mode, this.info.cloudflared, this.info.hostnames, this.info.quickHost])
    this.info = { ...this.info, status }
    if (key === this.lastKey) return
    this.lastKey = key
    try { this.opts.onStatus?.(this.info) } catch { /* listeners must not break the manager */ }
  }
}

/** Split a stream into lines (also handles a last line without newline). */
function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  const decoder = new TextDecoder()
  let buf = ''
  stream.on('data', (chunk: Buffer) => {
    buf += decoder.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''))
      buf = buf.slice(i + 1)
    }
  })
  stream.on('end', () => {
    buf += decoder.decode()
    if (buf) onLine(buf.replace(/\r$/, ''))
    buf = ''
  })
}
