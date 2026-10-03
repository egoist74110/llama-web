// Runtime registry (decisions 34 / 35): which llama.cpp builds exist on this machine and how a
// model's `runtime` reference turns into a concrete llama-server executable.
//
// - Official builds are found by scanning data/runtime/llama.cpp/<os-arch-accel>/<tag>/ (they are
//   not registered). Reference: `cuda:b11146` / `cpu:b11146` / `metal:b11146`.
// - Hand-added builds live in data/runtime/llama.cpp/custom/<id>/ and are listed in
//   data/runtimes.json. Reference: `custom:<id>`. The executable path is always derived from the
//   id, never read from the file, so a hand-edited registry cannot point outside data/runtime.
// - Platform isolation: entries and references that belong to another os / architecture are
//   hidden and resolve as "other platform" (never deleted, never launched).
// Pure module (no Nitro): everything the host provides comes in through RuntimeEnv.
import { existsSync, readdirSync, readFileSync, renameSync, openSync, readSync, closeSync, copyFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, posix, win32 } from 'node:path'
import { installedDir, listInstalled, serverExeName, versionsDir } from './llamacpp'
import type { RuntimeTarget } from './platform'
import { isInsideDir } from './residue'
import { JsonStore, StoreError } from './store'

export type RuntimeAccel = RuntimeTarget['acceleration']
export const RUNTIME_ACCELS: RuntimeAccel[] = ['cuda', 'cpu', 'metal']

export type RuntimeSourceKind = 'dir' | 'archive' | 'github'

export interface RuntimeEntry {
  /** Lower-case letters, digits and `-`; names the directory under custom/. */
  id: string
  label: string
  /** Where it came from (display only). */
  source: { kind: RuntimeSourceKind, from: string }
  os: NodeJS.Platform
  arch: string
  accel: RuntimeAccel
  /** `b11146` when the build number could be read, else empty. */
  tag: string
  addedAt: string
  /** SHA-256 of the downloaded / chosen archive (not set for directories). */
  sha256?: string
}

export interface RuntimesDoc {
  version: number
  entries: RuntimeEntry[]
}

export const RUNTIMES_VERSION = 1
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const OFFICIAL_REF_RE = /^(cuda|cpu|metal):(b\d+)$/
const CUSTOM_REF_RE = /^custom:([a-z0-9][a-z0-9-]{0,31})$/

export type RuntimeRef =
  | { kind: 'official', accel: RuntimeAccel, tag: string }
  | { kind: 'custom', id: string }

export function parseRuntimeRef(ref: unknown): RuntimeRef | null {
  if (typeof ref !== 'string') return null
  const o = OFFICIAL_REF_RE.exec(ref)
  if (o) return { kind: 'official', accel: o[1] as RuntimeAccel, tag: o[2]! }
  const c = CUSTOM_REF_RE.exec(ref)
  return c ? { kind: 'custom', id: c[1]! } : null
}
export const officialRef = (accel: RuntimeAccel, tag: string) => `${accel}:${tag}`
export const customRef = (id: string) => `custom:${id}`

/** Official channels that exist for a host: Windows x64 has CUDA and CPU, Apple silicon Metal, Intel Mac CPU. */
export function channelsFor(host: { os: NodeJS.Platform, arch: string }): RuntimeAccel[] {
  if (host.os === 'win32' && host.arch === 'x64') return ['cuda', 'cpu']
  if (host.os === 'darwin') return [host.arch === 'arm64' ? 'metal' : 'cpu']
  return []
}

/** An entry can run here only on the same os and the same architecture (no Rosetta, no emulation). */
export const entryRunsHere = (e: Pick<RuntimeEntry, 'os' | 'arch'>, host: { os: NodeJS.Platform, arch: string }) =>
  e.os === host.os && e.arch === host.arch

export const customDir = (dataDir: string, id: string) => join(versionsDir(dataDir), 'custom', id)
export const customExe = (dataDir: string, entry: Pick<RuntimeEntry, 'id' | 'os'>) => join(customDir(dataDir, entry.id), serverExeName(entry.os))

export const newRuntimeId = () => `r${randomBytes(5).toString('hex')}`

// ---------------------------------------------------------------------------------------------
// Executable headers: the platform of a binary is decided by its content, never by its name.

export interface BinaryKind {
  os: NodeJS.Platform
  /** `x64`, `arm64` or `ia32`; a universal Mach-O lists every slice. */
  archs: string[]
}

export function sniffBinary(head: Buffer): BinaryKind | null {
  if (head.length >= 64 && head[0] === 0x4d && head[1] === 0x5a) { // MZ
    const pe = head.readUInt32LE(0x3c)
    if (pe + 6 > head.length || head.readUInt32LE(pe) !== 0x00004550) return null
    const machine = head.readUInt16LE(pe + 4)
    const arch = machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : machine === 0x14c ? 'ia32' : null
    return arch ? { os: 'win32', archs: [arch] } : null
  }
  if (head.length >= 20 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) { // ELF
    const le = head[5] === 1
    const machine = le ? head.readUInt16LE(0x12) : head.readUInt16BE(0x12)
    const arch = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null
    return arch ? { os: 'linux', archs: [arch] } : null
  }
  if (head.length >= 8) {
    const cpu = (n: number) => n === 0x01000007 ? 'x64' : n === 0x0100000c ? 'arm64' : null
    const magicLe = head.readUInt32LE(0)
    if (magicLe === 0xfeedfacf) { const a = cpu(head.readUInt32LE(4)); return a ? { os: 'darwin', archs: [a] } : null } // thin 64-bit
    if (head.readUInt32BE(0) === 0xfeedfacf) { const a = cpu(head.readUInt32BE(4)); return a ? { os: 'darwin', archs: [a] } : null }
    if (head.readUInt32BE(0) === 0xcafebabe) { // universal; a Java class has a version number where the slice count is
      const n = head.readUInt32BE(4)
      if (n < 1 || n > 8 || head.length < 8 + n * 20) return null
      const archs = new Set<string>()
      for (let i = 0; i < n; i++) { const a = cpu(head.readUInt32BE(8 + i * 20)); if (a) archs.add(a) }
      return archs.size ? { os: 'darwin', archs: [...archs] } : null
    }
  }
  return null
}

export function sniffFile(file: string): BinaryKind | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return sniffBinary(buf.subarray(0, n))
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

export const binaryRunsHere = (b: BinaryKind, host: { os: NodeJS.Platform, arch: string }) => b.os === host.os && b.archs.includes(host.arch)

// ---------------------------------------------------------------------------------------------
// data/runtimes.json

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const clean = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : '')

/** Keep valid entries only (a hand edit with a bad id cannot reach the file system); never throws on content. */
export function normalizeRuntimes(doc: RuntimesDoc): RuntimesDoc {
  const entries: RuntimeEntry[] = []
  const seen = new Set<string>()
  for (const e of Array.isArray(doc?.entries) ? doc.entries : []) {
    if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id) || seen.has(e.id)) continue
    if (!['win32', 'darwin', 'linux'].includes(e.os) || typeof e.arch !== 'string' || !/^[a-z0-9_]{2,10}$/.test(e.arch)) continue
    if (!RUNTIME_ACCELS.includes(e.accel)) continue
    const src = isObj(e.source) && ['dir', 'archive', 'github'].includes(e.source.kind) ? { kind: e.source.kind as RuntimeSourceKind, from: clean(e.source.from, 500) } : null
    if (!src) continue
    seen.add(e.id)
    const tag = typeof e.tag === 'string' && /^b\d{1,9}$/.test(e.tag) ? e.tag : ''
    const sha = typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256) ? e.sha256 : undefined
    entries.push({
      id: e.id, label: clean(e.label, 80) || e.id, source: src, os: e.os, arch: e.arch, accel: e.accel, tag,
      addedAt: clean(e.addedAt, 40), ...(sha ? { sha256: sha } : {}),
    })
  }
  return { version: RUNTIMES_VERSION, entries }
}

export class RuntimeRegistry {
  private store: JsonStore<RuntimesDoc> | null = null
  private cache: RuntimesDoc = { version: RUNTIMES_VERSION, entries: [] }
  /** Set when runtimes.json is from a newer llama-web and was left alone. */
  unavailable: string | null = null
  /** Set when a broken file was moved aside (and the newest readable backup restored, if any). */
  recovered: { movedTo: string, fromBackup: string | null } | null = null

  constructor(private readonly dataDir: string) {
    const mk = () => new JsonStore<RuntimesDoc>({
      dataDir, name: 'runtimes.json', version: RUNTIMES_VERSION, defaults: () => ({ version: RUNTIMES_VERSION, entries: [] }), validate: normalizeRuntimes,
    })
    try {
      const s = mk()
      this.cache = s.load()
      this.store = s
    } catch (e) {
      if (!(e instanceof StoreError) || e.code === 'newer-version') {
        this.unavailable = (e as Error).message
        return
      }
      this.recover()
    }
  }

  /** Corrupt / invalid file: keep it as `.bad-<time>`, restore the newest readable backup, else start empty. */
  private recover(): void {
    const file = join(this.dataDir, 'runtimes.json')
    const movedTo = `${file}.bad-${Date.now()}`
    try { renameSync(file, movedTo) } catch { /* cannot move: the new file replaces it below */ }
    let fromBackup: string | null = null
    const backups = join(this.dataDir, 'backups')
    try {
      const names = readdirSync(backups).filter(n => /^runtimes\.\d{8}-\d{6}-\d{3}(?:-\d+)?\.json$/.test(n)).sort().reverse()
      for (const n of names) {
        try {
          JSON.parse(readFileSync(join(backups, n), 'utf8'))
          copyFileSync(join(backups, n), file)
          const s = new JsonStore<RuntimesDoc>({ dataDir: this.dataDir, name: 'runtimes.json', version: RUNTIMES_VERSION, defaults: () => ({ version: RUNTIMES_VERSION, entries: [] }), validate: normalizeRuntimes })
          this.cache = s.load()
          this.store = s
          fromBackup = n
          break
        } catch { try { renameSync(file, `${file}.bad-${Date.now()}`) } catch { /* ignore */ } }
      }
    } catch { /* no backups directory */ }
    if (!this.store) {
      mkdirSync(this.dataDir, { recursive: true })
      const s = new JsonStore<RuntimesDoc>({ dataDir: this.dataDir, name: 'runtimes.json', version: RUNTIMES_VERSION, defaults: () => ({ version: RUNTIMES_VERSION, entries: [] }), validate: normalizeRuntimes })
      this.cache = s.load()
      this.store = s
    }
    this.recovered = { movedTo, fromBackup }
  }

  /** Every entry, including ones of other platforms. Re-reads the file; a broken hand edit keeps the last good list. */
  list(): RuntimeEntry[] {
    if (this.store) { try { this.cache = this.store.refresh() } catch { /* keep the cached list */ } }
    return this.cache.entries
  }
  get(id: string): RuntimeEntry | undefined {
    return this.list().find(e => e.id === id)
  }
  add(entry: RuntimeEntry): void {
    if (!this.store) throw new Error(this.unavailable ?? 'runtimes.json is unavailable')
    this.store.update((d) => { d.entries.push(entry) })
    this.cache = this.store.get()
  }
  remove(id: string): void {
    if (!this.store) throw new Error(this.unavailable ?? 'runtimes.json is unavailable')
    this.store.update((d) => { d.entries = d.entries.filter(e => e.id !== id) })
    this.cache = this.store.get()
  }
  close(): void {
    this.store?.close()
  }
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface RuntimeEnv {
  dataDir: string
  /** The host (os / arch) and the global channel. */
  target: RuntimeTarget
  entries: RuntimeEntry[]
  /** Installed official tags of a channel, newest first (default: scan the directories). */
  installed?: (accel: RuntimeAccel) => string[]
  exists?: (path: string) => boolean
}

export type FallbackReason = 'missing' | 'other-platform' | 'invalid'

export interface ResolvedRuntime {
  ref: string
  exe: string
  /** `b11146` for official builds, the entry's label for hand-added ones. */
  label: string
  /** Set when the requested reference could not be used: what was asked, why, and what runs instead. */
  fallback: null | { from: string, reason: FallbackReason, to: string }
}

export class RuntimeResolveError extends Error {
  constructor(public code: 'no-official', public channel: RuntimeAccel) {
    super(`No official llama.cpp build is installed for the ${channel} channel`)
    this.name = 'RuntimeResolveError'
  }
}

export function installedOfficial(env: RuntimeEnv, accel: RuntimeAccel): string[] {
  if (env.installed) return env.installed(accel)
  const t: RuntimeTarget = { os: env.target.os, arch: env.target.arch, acceleration: accel }
  return listInstalled(env.dataDir, t.os, t)
}

export function officialExe(env: Pick<RuntimeEnv, 'dataDir' | 'target'>, accel: RuntimeAccel, tag: string): string {
  const t: RuntimeTarget = { os: env.target.os, arch: env.target.arch, acceleration: accel }
  return join(installedDir(env.dataDir, tag, t), serverExeName(t.os))
}

/**
 * Turn a reference into an executable. A reference that is missing (deleted, hand-edited, data
 * directory from another machine), invalid or from another platform falls back to the newest
 * official build of the same channel; the saved configuration is not touched. Throws
 * RuntimeResolveError only when that channel has no official build at all.
 */
export function resolveRuntimeRef(ref: string, env: RuntimeEnv): ResolvedRuntime {
  const exists = env.exists ?? existsSync
  const p = parseRuntimeRef(ref)
  const host = env.target
  const fallback = (reason: FallbackReason): ResolvedRuntime => {
    const channel = p?.kind === 'official' && channelsFor(host).includes(p.accel) ? p.accel : host.acceleration
    const tag = installedOfficial(env, channel)[0]
    if (!tag) throw new RuntimeResolveError('no-official', channel)
    const to = officialRef(channel, tag)
    return { ref: to, exe: officialExe(env, channel, tag), label: tag, fallback: { from: ref, reason, to } }
  }
  if (!p) return fallback('invalid')
  if (p.kind === 'official') {
    if (!channelsFor(host).includes(p.accel)) return fallback('other-platform')
    if (!installedOfficial(env, p.accel).includes(p.tag)) return fallback('missing')
    return { ref, exe: officialExe(env, p.accel, p.tag), label: p.tag, fallback: null }
  }
  const e = env.entries.find(x => x.id === p.id)
  if (!e) return fallback('missing')
  if (!entryRunsHere(e, host)) return fallback('other-platform')
  const exe = customExe(env.dataDir, e)
  if (!exists(exe)) return fallback('missing')
  return { ref, exe, label: e.label, fallback: null }
}

/** True when a reference can be chosen on this machine (a visible official channel / entry), for saving a selection. */
export function selectableHere(ref: string, env: Pick<RuntimeEnv, 'target' | 'entries'>): boolean {
  const p = parseRuntimeRef(ref)
  if (!p) return false
  if (p.kind === 'official') return channelsFor(env.target).includes(p.accel)
  const e = env.entries.find(x => x.id === p.id)
  return !!e && entryRunsHere(e, env.target)
}

/**
 * Reference of a launched executable under data/runtime/llama.cpp/, or null. Used to protect
 * versions that a running / starting process uses.
 */
export function refOfExe(dataDir: string, exe: string, platform = process.platform): string | null {
  const base = versionsDir(dataDir)
  if (!isInsideDir(exe, base, platform)) return null
  const path = platform === 'win32' ? win32 : posix
  const parts = path.relative(base, exe).split(/[\\/]/)
  const first = (platform === 'win32' ? parts[0]?.toLowerCase() : parts[0]) ?? ''
  if (first === 'custom') return CUSTOM_REF_RE.test(`custom:${parts[1]}`) ? `custom:${parts[1]}` : null
  const tagOf = (s: string | undefined) => (/^b\d+$/.test(s?.toLowerCase() ?? '') ? s!.toLowerCase() : null)
  if (tagOf(first)) return officialRef('cuda', tagOf(first)!) // the old flat layout is the Windows CUDA build
  const m = /^(win32|darwin)-(x64|arm64)-(cuda|cpu|metal)$/.exec(first)
  const tag = tagOf(parts[1])
  return m && tag ? officialRef(m[3] as RuntimeAccel, tag) : null
}
