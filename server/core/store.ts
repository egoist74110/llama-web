// JSON config store: atomic writes, timestamped backups, versioned migrations,
// and file watching for hand edits. Pure Node APIs, no Nitro dependency.
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, watch, writeFileSync, type FSWatcher,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type StoreErrorCode = 'corrupt' | 'newer-version' | 'invalid'

export class StoreError extends Error {
  constructor(public code: StoreErrorCode, public file: string, message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

/** Data directory: `LLAMA_WEB_DATA` if set, otherwise `<cwd>/data`. */
export function resolveDataDir(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  return env.LLAMA_WEB_DATA ? resolve(env.LLAMA_WEB_DATA) : join(cwd, 'data')
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let tmpCounter = 0

/** Write to a temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    // Windows can briefly refuse to replace a file another process is reading.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        return
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
        sleepSync(20 * (attempt + 1))
      }
    }
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw e
  }
}

export interface VersionedDoc {
  version: number
}

export interface StoreOptions<T extends VersionedDoc> {
  dataDir: string
  /** File name inside dataDir, e.g. `settings.json`. */
  name: string
  /** Current schema version. */
  version: number
  /** Used only when the file does not exist yet. */
  defaults: () => T
  /** `migrations[n]` converts a version-n document into version n + 1. */
  migrations?: Record<number, (old: any) => any>
  /** Optional check/normalisation after migration; throw to reject the document. */
  validate?: (doc: T) => T
  /** Backups kept per file (default 20). */
  keepBackups?: number
  /** Clock used for backup names (tests). */
  now?: () => Date
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0')
}

function timestamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
}

/** Sort key for a backup name: timestamp, then numeric collision suffix (none = 0). */
function backupKey(stamp: string, suffix: string | undefined): [string, number] {
  return [stamp, suffix ? Number(suffix) : 0]
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class JsonStore<T extends VersionedDoc> {
  readonly file: string
  private readonly backupDir: string
  private readonly baseName: string
  private readonly keep: number
  private current: T | null = null
  private lastWritten: string | null = null
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: StoreOptions<T>) {
    this.file = join(opts.dataDir, opts.name)
    this.backupDir = join(opts.dataDir, 'backups')
    this.baseName = opts.name.replace(/\.json$/i, '')
    this.keep = opts.keepBackups ?? 20
  }

  /** Read the file (creating it from defaults if missing), migrating if needed. */
  load(): T {
    if (!existsSync(this.file)) {
      const doc = this.opts.defaults()
      doc.version = this.opts.version
      this.write(doc, false)
      return doc
    }
    const { doc, migrated } = this.parse(readFileSync(this.file, 'utf8'))
    this.current = doc
    if (migrated) this.save(doc)
    else this.lastWritten = this.serialize(doc)
    return doc
  }

  get(): T {
    return this.current ?? this.load()
  }

  /** Replace the document. The previous file is backed up first. */
  save(next: T): void {
    const doc = this.opts.validate ? this.opts.validate(next) : next
    doc.version = this.opts.version
    this.write(doc, true)
  }

  /** Mutate a deep copy (return a new value or mutate in place) and save it. */
  update(fn: (draft: T) => T | void): T {
    const draft = structuredClone(this.get())
    const next = fn(draft) ?? draft
    this.save(next)
    return next
  }

  /** Watch the file for external edits. Own writes are ignored. Failed reloads keep the old value. */
  watch(onChange: (next: T, prev: T | null) => void, onError?: (e: unknown) => void): void {
    this.close()
    mkdirSync(this.opts.dataDir, { recursive: true })
    this.watcher = watch(this.opts.dataDir, { persistent: false }, (_event, filename) => {
      if (filename !== this.opts.name) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        try {
          if (!existsSync(this.file)) return
          const text = readFileSync(this.file, 'utf8')
          if (text === this.lastWritten) return
          const { doc, migrated } = this.parse(text)
          const prev = this.current
          this.current = doc
          if (migrated) this.save(doc)
          else this.lastWritten = text
          onChange(doc, prev)
        } catch (e) {
          onError?.(e)
        }
      }, 100)
    })
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  private serialize(doc: T) {
    return JSON.stringify(doc, null, 2) + '\n'
  }

  private write(doc: T, backup: boolean) {
    const text = this.serialize(doc)
    if (backup && existsSync(this.file)) this.backup()
    writeFileAtomic(this.file, text)
    this.current = doc
    this.lastWritten = text
  }

  private parse(text: string): { doc: T, migrated: boolean } {
    let raw: any
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw new StoreError('corrupt', this.file, `Invalid JSON in ${this.opts.name}: ${(e as Error).message}`)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isInteger(raw.version)) {
      throw new StoreError('invalid', this.file, `${this.opts.name} has no integer "version" field`)
    }
    if (raw.version > this.opts.version) {
      throw new StoreError('newer-version', this.file, `${this.opts.name} is version ${raw.version}, newer than supported ${this.opts.version}`)
    }
    let migrated = false
    while (raw.version < this.opts.version) {
      const step = this.opts.migrations?.[raw.version]
      if (!step) throw new StoreError('invalid', this.file, `No migration from ${this.opts.name} version ${raw.version}`)
      const from = raw.version
      raw = step(raw)
      raw.version = from + 1
      migrated = true
    }
    let doc = raw as T
    if (this.opts.validate) {
      try {
        doc = this.opts.validate(doc)
      } catch (e) {
        throw new StoreError('invalid', this.file, `${this.opts.name} failed validation: ${(e as Error).message}`)
      }
    }
    return { doc, migrated }
  }

  private backup() {
    mkdirSync(this.backupDir, { recursive: true })
    const re = new RegExp(`^${escapeRegExp(this.baseName)}\\.(\\d{8}-\\d{6}-\\d{3})(?:-(\\d+))?\\.json$`)
    const list = () => readdirSync(this.backupDir)
      .map(f => ({ f, m: re.exec(f) }))
      .filter((x): x is { f: string, m: RegExpExecArray } => x.m !== null)
      .map(({ f, m }) => ({ f, key: backupKey(m[1]!, m[2]) }))
      // Oldest first: same-millisecond collisions order by numeric suffix, not as strings.
      .sort((a, b) => a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 : a.key[1] - b.key[1])
    const stamp = timestamp(this.opts.now?.())
    // Next suffix is one past the highest existing one for this stamp, so a pruned
    // low slot is never reused for a newer backup.
    const used = list().filter(b => b.key[0] === stamp).map(b => b.key[1])
    const seq = used.length ? Math.max(...used) + 1 : 0
    copyFileSync(this.file, join(this.backupDir, `${this.baseName}.${stamp}${seq ? `-${seq}` : ''}.json`))
    const all = list()
    for (const old of all.slice(0, Math.max(0, all.length - this.keep))) {
      try { unlinkSync(join(this.backupDir, old.f)) } catch { /* ignore */ }
    }
  }
}
