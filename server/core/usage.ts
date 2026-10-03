// Usage log (decision 40): per-day aggregates under data/logs/usage/YYYY-MM-DD.json, bucketed by
// hour x model x profile x source x key name. Counters only: no conversation content, no
// parameters. Fed by the same request record as the request log (one source of truth), kept in
// memory and written atomically on a timer and at shutdown (a crash loses at most one interval).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayStamp } from './logs'
import type { RequestRecord, RequestSource } from './request-log'

export const USAGE_KEEP_CHOICES = [7, 14, 30] as const
export const USAGE_KEEP_MAX = 30
export const USAGE_MAX_RANGE_DAYS = 62

/** Smallest allowed retention (7 / 14 / 30) that is not below the wanted days; anything unusable = 30. */
export function normalizeUsageKeepDays(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return USAGE_KEEP_MAX
  return USAGE_KEEP_CHOICES.find(c => c >= v) ?? USAGE_KEEP_MAX
}

export interface UsageCounters {
  requests: number
  ok: number
  error: number
  aborted: number
  promptTokens: number
  completionTokens: number
  /** Sum of request durations (ms). */
  durationMs: number
  images: number
}

export interface UsageRow extends UsageCounters {
  /** Local hour of the request, 0-23. */
  hour: number
  modelId: string | null
  modelName: string | null
  profile: string | null
  source: RequestSource
  keyName: string | null
}

interface UsageFile {
  version: 1
  day: string
  rows: UsageRow[]
}

export type UsageGroupBy = 'model' | 'profile' | 'source' | 'key'

export interface UsageGroup extends UsageCounters {
  /** Stable key (model id / profile / source / key name; empty string = none). */
  key: string
  /** Display name for models, otherwise the key. */
  label: string
}

export interface UsageDay extends UsageCounters {
  day: string
}

export interface UsageReport {
  from: string
  to: string
  daily: UsageDay[]
  total: UsageCounters
  by: Record<UsageGroupBy, UsageGroup[]>
}

export class UsageError extends Error {
  constructor(public code: 'bad-range', message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface UsageStoreOptions {
  /** `data/logs/usage`. */
  dir: string
  /** Read on every prune, so hand edits of settings.json apply. */
  keepDays: () => number
  now?: () => Date
  /** Interval between writes of changed days. */
  flushMs?: number
}

const FILE_NAME = /^(\d{4})-(\d{2})-(\d{2})\.json$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const zero = (): UsageCounters => ({ requests: 0, ok: 0, error: 0, aborted: 0, promptTokens: 0, completionTokens: 0, durationMs: 0, images: 0 })

function add(into: UsageCounters, from: UsageCounters): void {
  into.requests += from.requests
  into.ok += from.ok
  into.error += from.error
  into.aborted += from.aborted
  into.promptTokens += from.promptTokens
  into.completionTokens += from.completionTokens
  into.durationMs += from.durationMs
  into.images += from.images
}

const rowKey = (r: Pick<UsageRow, 'hour' | 'modelId' | 'profile' | 'source' | 'keyName'>) =>
  JSON.stringify([r.hour, r.modelId, r.profile, r.source, r.keyName])

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** A row read from disk, or null when it is not usable. Unknown fields are dropped. */
function cleanRow(raw: unknown): UsageRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const hour = r.hour
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (r.source !== 'local' && r.source !== 'lan' && r.source !== 'public') return null
  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    hour, source: r.source, modelId: text(r.modelId), modelName: text(r.modelName), profile: text(r.profile), keyName: text(r.keyName),
    requests: num(r.requests), ok: num(r.ok), error: num(r.error), aborted: num(r.aborted),
    promptTokens: num(r.promptTokens), completionTokens: num(r.completionTokens), durationMs: num(r.durationMs), images: num(r.images),
  }
}

/** Rows of one day file; a missing, half-written or foreign file yields nothing. */
function readDayFile(file: string): UsageRow[] {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Partial<UsageFile>
    if (!doc || !Array.isArray(doc.rows)) return []
    return doc.rows.map(cleanRow).filter((r): r is UsageRow => r !== null)
  } catch {
    return []
  }
}

export class UsageStore {
  private readonly days = new Map<string, Map<string, UsageRow>>()
  private readonly dirty = new Set<string>()
  private readonly now: () => Date
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPruneDay = ''
  private closed = false

  constructor(private readonly opts: UsageStoreOptions) {
    this.now = opts.now ?? (() => new Date())
  }

  get dir(): string {
    return this.opts.dir
  }

  // -------------------------------------------------------------------------------------
  // Writing

  /** Start the periodic write (and the day-change cleanup). */
  start(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.tick(), this.opts.flushMs ?? 30_000)
    this.timer.unref?.()
  }

  /** Add one finished request. Never throws. */
  record(r: RequestRecord): void {
    if (this.closed) return
    try {
      const at = new Date(r.at)
      const day = dayStamp(at)
      const rows = this.loadDay(day)
      const base = { hour: at.getHours(), modelId: r.modelId, profile: r.profile, source: r.source, keyName: r.keyName }
      const key = rowKey(base)
      let row = rows.get(key)
      if (!row) {
        row = { ...base, modelName: r.modelName, ...zero() }
        rows.set(key, row)
      }
      row.modelName = r.modelName ?? row.modelName
      row.requests++
      row[r.outcome]++
      row.promptTokens += num(r.promptTokens)
      row.completionTokens += num(r.completionTokens)
      row.durationMs += num(r.durationMs)
      row.images += num(r.images?.count)
      this.dirty.add(day)
    } catch { /* usage must never break a request */ }
  }

  /** Write every changed day atomically (temp file, then rename). */
  flush(): void {
    for (const day of [...this.dirty]) {
      const rows = this.days.get(day)
      if (!rows) { this.dirty.delete(day); continue }
      try {
        mkdirSync(this.opts.dir, { recursive: true })
        const file = join(this.opts.dir, `${day}.json`)
        const tmp = `${file}.tmp`
        const doc: UsageFile = { version: 1, day, rows: [...rows.values()] }
        writeFileSync(tmp, JSON.stringify(doc), 'utf8')
        renameSync(tmp, file)
        this.dirty.delete(day)
      } catch { /* try again on the next tick */ }
    }
  }

  /** Final write at shutdown; later records are ignored. */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
    this.closed = true
  }

  private tick(): void {
    this.flush()
    if (dayStamp(this.now()) !== this.lastPruneDay) this.prune()
    // Days that are written and no longer today's stay out of memory; reads go to disk.
    const today = dayStamp(this.now())
    for (const day of [...this.days.keys()]) {
      if (day !== today && !this.dirty.has(day)) this.days.delete(day)
    }
  }

  /** Rows of a day for writing: loaded from disk once (a restart on the same day continues the file). */
  private loadDay(day: string): Map<string, UsageRow> {
    let rows = this.days.get(day)
    if (!rows) {
      rows = new Map()
      for (const r of readDayFile(join(this.opts.dir, `${day}.json`))) rows.set(rowKey(r), r)
      this.days.set(day, rows)
    }
    return rows
  }

  // -------------------------------------------------------------------------------------
  // Retention

  /** Delete day files older than the kept days. Only `YYYY-MM-DD.json` names are touched. */
  prune(): void {
    const now = this.now()
    this.lastPruneDay = dayStamp(now)
    const keep = normalizeUsageKeepDays(this.opts.keepDays())
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keep - 1))
    let names: string[]
    try { names = readdirSync(this.opts.dir) } catch { return }
    for (const name of names) {
      const m = FILE_NAME.exec(name)
      if (!m) continue
      if (new Date(+m[1]!, +m[2]! - 1, +m[3]!) >= cutoff) continue
      try { rmSync(join(this.opts.dir, name), { force: true }) } catch { /* in use or gone */ }
      this.days.delete(name.slice(0, 10))
      this.dirty.delete(name.slice(0, 10))
    }
  }

  // -------------------------------------------------------------------------------------
  // Reading

  /** Rows of one day: memory when this process holds it (it is newer than the file), else the file. */
  rowsOf(day: string): UsageRow[] {
    const mem = this.days.get(day)
    if (mem) return [...mem.values()]
    const file = join(this.opts.dir, `${day}.json`)
    return existsSync(file) ? readDayFile(file) : []
  }

  /** Summary of `from`..`to` (inclusive, `YYYY-MM-DD`); defaults to the kept window ending today. */
  report(from?: string, to?: string): UsageReport {
    const today = this.now()
    const end = to ?? dayStamp(today)
    const start = from ?? dayStamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (USAGE_KEEP_MAX - 1)))
    const days = dayRange(start, end)
    const daily: UsageDay[] = []
    const total = zero()
    const maps: Record<UsageGroupBy, Map<string, UsageGroup>> = { model: new Map(), profile: new Map(), source: new Map(), key: new Map() }
    for (const day of days) {
      const d: UsageDay = { day, ...zero() }
      for (const r of this.rowsOf(day)) {
        add(d, r)
        group(maps.model, r.modelId ?? '', r.modelName ?? r.modelId ?? '', r)
        group(maps.profile, r.profile ?? '', r.profile ?? '', r)
        group(maps.source, r.source, r.source, r)
        group(maps.key, r.keyName ?? '', r.keyName ?? '', r)
      }
      add(total, d)
      daily.push(d)
    }
    const sorted = (m: Map<string, UsageGroup>) => [...m.values()].sort((a, b) =>
      (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens) || b.requests - a.requests || a.key.localeCompare(b.key))
    return {
      from: start, to: end, daily, total,
      by: { model: sorted(maps.model), profile: sorted(maps.profile), source: sorted(maps.source), key: sorted(maps.key) },
    }
  }

  /** CSV of `from`..`to`: the hourly rows as stored, or one row per day and group when `groupBy` is given. */
  csv(from: string | undefined, to: string | undefined, groupBy?: UsageGroupBy): string {
    const today = this.now()
    const end = to ?? dayStamp(today)
    const start = from ?? dayStamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (USAGE_KEEP_MAX - 1)))
    const counters = ['requests', 'ok', 'error', 'aborted', 'promptTokens', 'completionTokens', 'durationMs', 'images'] as const
    const out: string[] = []
    if (!groupBy) {
      out.push(['day', 'hour', 'model', 'profile', 'source', 'key', ...counters].join(','))
      for (const day of dayRange(start, end)) {
        const rows = this.rowsOf(day).sort((a, b) => a.hour - b.hour || rowKey(a).localeCompare(rowKey(b)))
        for (const r of rows) {
          out.push([day, r.hour, r.modelName ?? r.modelId ?? '', r.profile ?? '', r.source, r.keyName ?? '', ...counters.map(c => r[c])].map(csvCell).join(','))
        }
      }
    } else {
      out.push(['day', groupBy, ...counters].join(','))
      for (const day of dayRange(start, end)) {
        const m = new Map<string, UsageGroup>()
        for (const r of this.rowsOf(day)) {
          if (groupBy === 'model') group(m, r.modelId ?? '', r.modelName ?? r.modelId ?? '', r)
          else if (groupBy === 'profile') group(m, r.profile ?? '', r.profile ?? '', r)
          else if (groupBy === 'source') group(m, r.source, r.source, r)
          else group(m, r.keyName ?? '', r.keyName ?? '', r)
        }
        for (const g of [...m.values()].sort((a, b) => a.key.localeCompare(b.key))) {
          out.push([day, g.label, ...counters.map(c => g[c])].map(csvCell).join(','))
        }
      }
    }
    return out.join('\r\n') + '\r\n'
  }
}

function group(m: Map<string, UsageGroup>, key: string, label: string, r: UsageCounters): void {
  let g = m.get(key)
  if (!g) { g = { key, label, ...zero() }; m.set(key, g) }
  add(g, r)
}

/** One CSV cell: quoted when needed, and a leading `= + - @` is defused (names are user-controlled). */
export function csvCell(v: unknown): string {
  let s = String(v ?? '')
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Every day from `from` to `to`, inclusive. Throws `bad-range` for malformed, reversed or too long ranges. */
export function dayRange(from: string, to: string): string[] {
  const a = DAY.exec(from)
  const b = DAY.exec(to)
  if (!a || !b) throw new UsageError('bad-range', 'dates must be YYYY-MM-DD')
  const start = new Date(+a[1]!, +a[2]! - 1, +a[3]!)
  const end = new Date(+b[1]!, +b[2]! - 1, +b[3]!)
  if (dayStamp(start) !== from || dayStamp(end) !== to) throw new UsageError('bad-range', 'not a calendar date')
  if (end < start) throw new UsageError('bad-range', 'from is after to')
  const out: string[] = []
  for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(dayStamp(d))
    if (out.length > USAGE_MAX_RANGE_DAYS) throw new UsageError('bad-range', 'range too long')
  }
  return out
}
