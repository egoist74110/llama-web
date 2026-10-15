// Outbound management traffic only. Never wrap upstream forwarding or llama-server traffic.
import { execFile } from 'node:child_process'
import type { Settings } from './config'
import type { FetchFn } from './llamacpp'
import { MIRRORS, customMirror, mirrorById, mirrorFetch, type Mirror } from './mirrors'

export type NetworkSettings = Settings['network']
export type DigestSource = 'github' | 'mirror'
export const DEFAULT_NETWORK: NetworkSettings = { proxy: { mode: 'system', url: '' }, downloadSource: 'ask', mirror: '' }

/** Bun 1.3 supports HTTP(S), not SOCKS. Never include the rejected value in an error. */
export function normalizeProxyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null
  try {
    const u = new URL(raw)
    return ['http:', 'https:'].includes(u.protocol) && u.hostname && u.pathname === '/' && !u.search && !u.hash ? u.href : null
  } catch { return null }
}

export function envProxy(env: Record<string, string | undefined>, https = true): string | null {
  const keys = https ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  for (const key of keys) if (env[key]) return normalizeProxyUrl(env[key])
  return null
}

const address = (raw: string): string | null => normalizeProxyUrl(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)

/** PAC / AutoConfigURL are intentionally ignored: only an enabled static proxy is supported. */
export function windowsProxy(text: string, https = true): string | null {
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+(?:0x0*1|1)\s*$/mi.test(text)) return null
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/mi.exec(text)?.[1]?.trim()
  if (!server) return null
  if (!server.includes('=')) return address(server)
  const entries = Object.fromEntries(server.split(';').map(s => s.trim().split('=').map(s => s.trim())))
  const selected = https ? entries.https ?? entries.http : entries.http
  return selected ? address(selected) : null
}

export function macProxy(text: string, https = true): string | null {
  const values = Object.fromEntries([...text.matchAll(/^\s*(\w+)\s*:\s*(.*?)\s*$/gm)].map(m => [m[1]!, m[2]!]))
  for (const prefix of https ? ['HTTPS', 'HTTP'] : ['HTTP']) {
    if (values[`${prefix}Enable`] !== '1') continue
    const host = values[`${prefix}Proxy`], port = values[`${prefix}Port`]
    if (!host || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) continue
    const u = address(`${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`)
    if (u) return u
  }
  return null
}

const loopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) || /^127\./.test(u.hostname)
const allowed = (u: URL, custom: string) => u.protocol === 'https:' && (['github.com', 'api.github.com', 'api.cloudflare.com'].includes(u.hostname)
  || u.hostname.endsWith('.githubusercontent.com') || MIRRORS.some(m => new URL(m.base).hostname === u.hostname)
  || (!!customMirror(custom) && new URL(customMirror(custom)!.base).hostname === u.hostname))

export interface NetworkOptions {
  settings(): NetworkSettings
  customMirror?(): string
  fetch?: FetchFn
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  now?(): number
  run?: (exe: string, args: string[]) => Promise<string>
  probeMs?: number
}

const runCommand = (exe: string, args: string[]): Promise<string> => new Promise(resolve => {
  execFile(exe, args, { timeout: 5000, maxBuffer: 64_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
})

interface SourceInfo { direct: FetchFn, source: () => DigestSource, failed: () => void, fallback: () => boolean }
const sources = new WeakMap<FetchFn, SourceInfo>()

export const canMirror = (fetchFn: FetchFn): boolean => sources.get(fetchFn)?.fallback() ?? false
export const sourceFailed = (fetchFn: FetchFn): void => sources.get(fetchFn)?.failed()

/** Metadata/digests must try the official API and web fallback before trusting a mirror. */
export async function officialFirst<T>(fetchFn: FetchFn, read: (f: FetchFn) => Promise<T>, complete: (value: T) => boolean = () => true): Promise<{ value: T, digestSource: DigestSource }> {
  const info = sources.get(fetchFn)
  if (!info) return { value: await read(fetchFn), digestSource: 'github' }
  try {
    const value = await read(info.direct)
    if (!complete(value) && info.fallback()) throw new Error('Official metadata is incomplete')
    return { value, digestSource: 'github' }
  }
  catch (e) {
    if (!info.fallback()) throw e
    const value = await read(fetchFn)
    return { value, digestSource: info.source() }
  }
}

/** A process-owned proxy cache (60s) and bounded mirror ordering cache (10min). */
export class NetworkAccess {
  private system: { at: number, text: string } | null = null
  private reading: Promise<string> | null = null
  private orders = new Map<string, { at: number, ids: string[] }>()
  private probes = new Map<string, Promise<Mirror[]>>()
  constructor(private readonly o: NetworkOptions) {}
  get sourceMode(): NetworkSettings['downloadSource'] { return this.o.settings().downloadSource }
  private get now() { return this.o.now?.() ?? Date.now() }

  private async proxy(url: URL): Promise<string> {
    const p = this.o.settings().proxy
    if (loopback(url) || p.mode === 'off') return ''
    if (p.mode === 'manual') return normalizeProxyUrl(p.url) ?? ''
    const env = this.o.env ?? process.env
    const fromEnv = envProxy(env, url.protocol === 'https:')
    if (fromEnv) return fromEnv
    const os = this.o.platform ?? process.platform
    if (os !== 'win32' && os !== 'darwin') return ''
    if (!this.system || this.now - this.system.at >= 60_000) {
      this.reading ??= (this.o.run ?? runCommand)(os === 'win32' ? 'reg' : '/usr/sbin/scutil', os === 'win32'
        ? ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'] : ['--proxy'])
        .catch(() => '').then(text => { this.system = { at: this.now, text }; return text }).finally(() => { this.reading = null })
      await this.reading
    }
    return (os === 'win32' ? windowsProxy : macProxy)(this.system?.text ?? '', url.protocol === 'https:') ?? ''
  }

  readonly direct: FetchFn = async (url, init) => {
    const u = new URL(url)
    // Explicit '' disables Bun's own environment proxy handling, including for loopback.
    const proxy = allowed(u, this.o.customMirror?.() ?? '') && !loopback(u) ? await this.proxy(u) : ''
    try {
      if (init?.signal?.aborted) throw new Error('Cancelled')
      const signal = init?.signal
      return await new Promise<Response>((resolve, reject) => {
        const stop = () => reject(new Error('Cancelled'))
        signal?.addEventListener('abort', stop, { once: true })
        Promise.resolve().then(() => (this.o.fetch ?? fetch)(url, { ...init, proxy } as RequestInit)).then(res => {
          signal?.removeEventListener('abort', stop)
          if (signal?.aborted) { void res.body?.cancel().catch(() => {}); reject(new Error('Cancelled')) }
          else resolve(res)
        }, () => { signal?.removeEventListener('abort', stop); reject(new Error('Outbound request failed')) })
      })
    }
    catch { throw new Error('Outbound request failed') } // proxy credentials never escape in native errors
  }

  private mirrors(): Mirror[] {
    const custom = customMirror(this.o.customMirror?.())
    return [...MIRRORS, ...(custom ? [custom] : [])]
  }

  /** Concurrent one-byte probes; no file bodies or persistent timers survive a probe. */
  async orderedMirrors(url: string, signal?: AbortSignal): Promise<Mirror[]> {
    const all = this.mirrors()
    const key = `${url}|${all.map(m => m.base).join('|')}`
    const cached = this.orders.get(key)
    if (cached && this.now - cached.at < 600_000) return cached.ids.map(id => all.find(m => m.id === id)!).filter(Boolean)
    const existing = this.probes.get(key)
    if (existing) return existing
    const probe = async () => {
      const measured = await Promise.all(all.map(async (m, i) => {
        const start = this.now
        const ac = new AbortController()
        const stop = () => ac.abort(signal?.reason)
        signal?.addEventListener('abort', stop, { once: true })
        if (signal?.aborted) stop()
        const timer = setTimeout(() => ac.abort(), this.o.probeMs ?? 5000)
        let time = Infinity
        try {
          const res = await mirrorFetch(m, this.direct)(url, { headers: { Range: 'bytes=0-0' }, signal: ac.signal })
          if (res.ok) time = this.now - start
          await res.body?.cancel()
        } catch { /* Keep failed mirrors last as a later attempt might work. */ }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
        return { m, time, i }
      }))
      const sorted = measured.sort((a, b) => a.time - b.time || a.i - b.i).map(x => x.m)
      // Keep the memory cache bounded even when release URLs keep changing.
      if (this.orders.size >= 64) this.orders.delete(this.orders.keys().next().value!)
      this.orders.set(key, { at: this.now, ids: sorted.map(m => m.id) })
      return sorted
    }
    const pending = probe().finally(() => this.probes.delete(key))
    this.probes.set(key, pending)
    return pending
  }

  /** One action's fetch policy; an explicit choice is scoped to this action in ask mode. */
  source(mirrorId?: string, allowLoopback = false): FetchFn {
    let last: DigestSource = 'github'
    let skipDirect = false
    let lastMirror = ''
    const failedMirrors = new Set<string>()
    const fetchFn: FetchFn = async (url, init) => {
      const cfg = this.o.settings()
      const original = new URL(url)
      if (!['github.com', 'api.github.com'].includes(original.hostname)) {
        if ((cfg.downloadSource !== 'ask' || mirrorId) && !(allowLoopback && loopback(original))) throw new TypeError('Refusing a non-GitHub download URL')
        return this.direct(url, init)
      }
      const selected = mirrorById(mirrorId ?? cfg.mirror, this.o.customMirror?.()) ?? MIRRORS[0]!
      if (cfg.downloadSource === 'ask') {
        last = mirrorId ? 'mirror' : 'github'
        return mirrorId ? mirrorFetch(selected, this.direct)(url, init) : this.direct(url, init)
      }
      const tryRequest = async (f: FetchFn, mirrored = false) => {
        const res = await f(url, init)
        if (res.status >= 500 || res.status === 429 || res.status === 403 || mirrored && !res.ok) {
          await res.body?.cancel().catch(() => {})
          throw new Error('Retryable outbound response')
        }
        return res
      }
      let error: unknown
      if (cfg.downloadSource === 'auto' && !skipDirect && !mirrorId) {
        try { last = 'github'; return await tryRequest(this.direct) } catch (e) { error = e }
        if (init?.signal?.aborted) throw error
      }
      const ordered = await this.orderedMirrors(url, init?.signal ?? undefined)
      const mirrors = (cfg.downloadSource === 'mirror' || mirrorId ? [selected, ...ordered.filter(m => m.id !== selected.id)] : ordered).filter(m => !failedMirrors.has(m.id))
      for (const m of mirrors) {
        if (init?.signal?.aborted) throw error ?? new Error('Cancelled')
        try { last = 'mirror'; lastMirror = m.id; return await tryRequest(mirrorFetch(m, this.direct), true) } catch (e) { error = e }
      }
      if (cfg.downloadSource === 'mirror' && !init?.signal?.aborted) { last = 'github'; return this.direct(url, init) }
      throw error ?? new Error('No download source available')
    }
    sources.set(fetchFn, { direct: this.direct, source: () => last, failed: () => { skipDirect = true; if (last === 'mirror') failedMirrors.add(lastMirror) }, fallback: () => this.o.settings().downloadSource !== 'ask' || !!mirrorId })
    return fetchFn
  }
}
