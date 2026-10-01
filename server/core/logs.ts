// Log files under data/logs (plan「配置与数据」):
//   models/<model>/YYYY-MM-DD_HH-mm-ss.log   one file per llama-server start
//   events/YYYY-MM-DD.jsonl                  activity events (state changes, ...)
//   requests/YYYY-MM-DD.jsonl                request records (never conversation content)
// Pure module (node:fs only). Retention follows settings.logs; the files of a run that is
// still open are never pruned. Reads are confined to the log root.
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, lstatSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

export type LogKind = 'model' | 'events' | 'requests'

export interface LogRetention {
  keepRunsPerModel: number
  keepDays: number
}

export interface LogStoreOptions {
  /** `data/logs`. */
  dir: string
  /** Read on every prune, so hand edits of settings.json apply. */
  retention: () => LogRetention
  now?: () => Date
  /** Model output is buffered and written at most this often (and always on close). */
  flushMs?: number
}

export interface LogFileInfo {
  name: string
  size: number
  /** Epoch ms of the last write. */
  mtime: number
}

export interface LogListing {
  /** Model output, by model id (newest file first). */
  models: Array<{ model: string, files: LogFileInfo[] }>
  events: LogFileInfo[]
  requests: LogFileInfo[]
}

export interface LogRead {
  lines: string[]
  /** True when the file is larger than what was returned (the beginning is cut off). */
  truncated: boolean
  size: number
}

export class LogError extends Error {
  constructor(public code: 'bad-name' | 'not-found', message: string) {
    super(message)
    this.name = 'LogError'
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
export const dayStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const runStamp = (d: Date) => `${dayStamp(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

const FILE_NAME = /^\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2})?(?:-\d+)?\.(?:log|jsonl)$/
const SAFE_CHAR = /[A-Za-z0-9_-]/

/** Newest first: by timestamp, then by the `-N` suffix of same-second files. */
function newestFirst(a: { name: string }, b: { name: string }): number {
  const key = (n: string) => {
    const m = /^(\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2})?)(?:-(\d+))?\.(?:log|jsonl)$/.exec(n)
    return [m?.[1] ?? n, Number(m?.[2] ?? 1)] as const
  }
  const [sa, na] = key(a.name)
  const [sb, nb] = key(b.name)
  return sa === sb ? nb - na : sa < sb ? 1 : -1
}

/** Model id -> directory name. Anything outside `[A-Za-z0-9_-]` becomes `~<hex code>~` (reversible, no dots). */
export function modelDirName(modelId: string): string {
  let out = ''
  for (const ch of modelId) out += SAFE_CHAR.test(ch) ? ch : `~${ch.codePointAt(0)!.toString(16)}~`
  return out || '~~'
}

export function modelIdFromDir(dir: string): string {
  if (dir === '~~') return ''
  return dir.replace(/~([0-9a-f]+)~/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

/** One llama-server start. Lines are buffered; `close()` flushes. */
export class RunLog {
  private buf: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(readonly file: string, private readonly flushMs: number, private readonly onClose: () => void = () => {}) {}

  append(text: string): void {
    if (this.closed) return
    this.buf.push(text)
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs)
      this.timer.unref?.()
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.buf.length) return
    const data = this.buf.join('\n') + '\n'
    this.buf = []
    try { appendFileSync(this.file, data, 'utf8') } catch { /* logging must never break the model */ }
  }

  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    this.onClose()
  }

  get isOpen(): boolean {
    return !this.closed
  }
}

export class LogStore {
  private readonly open = new Set<RunLog>()
  private readonly now: () => Date
  private lastPruneDay = ''

  constructor(private readonly opts: LogStoreOptions) {
    this.now = opts.now ?? (() => new Date())
  }

  get dir(): string {
    return this.opts.dir
  }

  // -------------------------------------------------------------------------------------
  // Writing

  /** Create the log file of a new run (`<model dir>/<timestamp>.log`) and prune old ones. */
  startRun(modelId: string): RunLog {
    const dir = join(this.opts.dir, 'models', modelDirName(modelId))
    mkdirSync(dir, { recursive: true })
    const stamp = runStamp(this.now())
    let file = join(dir, `${stamp}.log`)
    for (let i = 2; existsSync(file); i++) file = join(dir, `${stamp}-${i}.log`)
    appendFileSync(file, '', 'utf8')
    const run: RunLog = new RunLog(file, this.opts.flushMs ?? 200, () => { this.open.delete(run) })
    this.open.add(run)
    this.prune()
    return run
  }

  appendEvent(event: unknown): void {
    this.appendLine('events', event)
  }

  appendRequest(record: unknown): void {
    this.appendLine('requests', record)
  }

  private appendLine(sub: 'events' | 'requests', value: unknown): void {
    try {
      const day = dayStamp(this.now())
      const dir = join(this.opts.dir, sub)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(value) + '\n', 'utf8')
      if (day !== this.lastPruneDay) this.prune()
    } catch { /* logging must never break a request */ }
  }

  /** Flush and close every open run (shutdown). */
  closeAll(): void {
    for (const r of [...this.open]) r.close()
  }

  // -------------------------------------------------------------------------------------
  // Retention

  /** Keep the newest `keepRunsPerModel` files per model and `keepDays` days of jsonl files. */
  prune(): void {
    const { keepRunsPerModel, keepDays } = this.opts.retention()
    const now = this.now()
    this.lastPruneDay = dayStamp(now)
    const busy = new Set([...this.open].map(r => r.file))

    const modelsRoot = join(this.opts.dir, 'models')
    for (const d of safeDirs(modelsRoot)) {
      const dir = join(modelsRoot, d)
      const files = listFiles(dir).filter(f => f.name.endsWith('.log')).sort(newestFirst)
      const keep = Math.max(1, Math.floor(keepRunsPerModel) || 1)
      for (const f of files.slice(keep)) {
        const p = join(dir, f.name)
        if (!busy.has(p)) rmQuiet(p)
      }
    }

    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(1, Math.floor(keepDays) || 1))
    for (const sub of ['events', 'requests'] as const) {
      const dir = join(this.opts.dir, sub)
      for (const f of listFiles(dir)) {
        const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(f.name)
        if (!day) continue
        if (new Date(+day[1]!, +day[2]! - 1, +day[3]!) < cutoff) rmQuiet(join(dir, f.name))
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Reading

  list(): LogListing {
    const modelsRoot = join(this.opts.dir, 'models')
    const byNewest = newestFirst
    return {
      models: safeDirs(modelsRoot)
        .map(d => ({ model: modelIdFromDir(d), files: listFiles(join(modelsRoot, d)).sort(byNewest) }))
        .filter(m => m.files.length)
        .sort((a, b) => a.model.localeCompare(b.model)),
      events: listFiles(join(this.opts.dir, 'events')).sort(byNewest),
      requests: listFiles(join(this.opts.dir, 'requests')).sort(byNewest),
    }
  }

  /** Last `maxLines` lines of one log file (at most `maxBytes` read from its end). */
  read(kind: LogKind, name: string, model?: string, opts: { maxLines?: number, maxBytes?: number } = {}): LogRead {
    if (!FILE_NAME.test(name)) throw new LogError('bad-name', 'bad file name')
    if (kind === 'model' && !model) throw new LogError('bad-name', 'model is required')
    const dir = kind === 'model'
      ? join(this.opts.dir, 'models', modelDirName(model!))
      : join(this.opts.dir, kind)
    const file = join(dir, name)
    let size: number
    try {
      // lstat: a link with a valid name must not lead outside the log directory.
      const st = lstatSync(file)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      throw new LogError('not-found', 'no such log file')
    }
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      let got = 0
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, start + got)
        if (n <= 0) break
        got += n
      }
    } finally {
      closeSync(fd)
    }
    let lines = buf.toString('utf8').split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    let truncated = start > 0
    if (truncated) lines.shift() // the first line is most likely cut in half
    const maxLines = opts.maxLines ?? 5000
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines)
      truncated = true
    }
    return { lines, truncated, size }
  }
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
}

function listFiles(dir: string): LogFileInfo[] {
  try {
    const out: LogFileInfo[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !FILE_NAME.test(e.name)) continue
      const st = statSync(join(dir, e.name))
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs })
    }
    return out
  } catch {
    return []
  }
}

function rmQuiet(file: string): void {
  try { rmSync(file, { force: true }) } catch { /* in use or already gone */ }
}
