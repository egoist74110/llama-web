// Async job ids of external upstreams (decision 59). A create request (POST /v1/videos) carries `model` and is
// forwarded to an external upstream; its follow-ups (GET /v1/videos/{id}, GET /v1/videos/{id}/content,
// DELETE /v1/videos/{id}) carry none. The id from the create response is remembered here with the upstream it went
// to and who created it, so the follow-ups reach the same upstream. Persisted in data/jobs.json (versioned, atomic
// write, backup), pruned on every write. Pure module: no Nitro.
import { JsonStore } from './store'
import type { RequestMeta } from './request-log'
import { sourceOf } from './request-log'

/** One async API: which request creates a job, and which paths address it afterwards. */
export interface AsyncJobApi {
  kind: string
  /** Path of the create request (POST), e.g. `/v1/videos`. */
  createPath: string
}

/** Only /v1/videos for now; another async API is one more entry (its follow-ups are `<createPath>/{id}[/...]`). */
export const ASYNC_JOB_APIS: readonly AsyncJobApi[] = [
  { kind: 'videos', createPath: '/v1/videos' },
]

const FOLLOW_UP_METHODS = new Set(['GET', 'HEAD', 'DELETE'])

/** Ids that are safe to put back into a path and to keep: no slashes, dots-only or escapes. */
const ID_RE = /^[\w.:~-]{1,200}$/

export function isJobId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v) && !/^\.+$/.test(v)
}

/** The API a create request belongs to, or null. */
export function matchJobCreate(method: string, pathname: string, apis: readonly AsyncJobApi[] = ASYNC_JOB_APIS): AsyncJobApi | null {
  if (method !== 'POST') return null
  const p = pathname.replace(/\/$/, '')
  return apis.find(a => a.createPath === p) ?? null
}

/** `<createPath>/{id}` or `<createPath>/{id}/<anything>` with a follow-up method, or null. */
export function matchJobFollowUp(method: string, pathname: string, apis: readonly AsyncJobApi[] = ASYNC_JOB_APIS): { api: AsyncJobApi, id: string } | null {
  if (!FOLLOW_UP_METHODS.has(method)) return null
  for (const api of apis) {
    const prefix = `${api.createPath}/`
    if (!pathname.startsWith(prefix)) continue
    const seg = pathname.slice(prefix.length).split('/')[0]!
    let id: string
    try { id = decodeURIComponent(seg) } catch { return null }
    return isJobId(id) ? { api, id } : null
  }
  return null
}

/** Who created a job. Public callers are told apart by API key name; local and LAN callers form one trusted group. */
export type JobOwner = { source: 'public', keyName: string } | { source: 'private' }

export function jobOwnerOf(meta: RequestMeta | undefined): JobOwner {
  const { source, keyName } = sourceOf(meta)
  return source === 'public' && keyName ? { source: 'public', keyName } : { source: 'private' }
}

/** A public caller sees only jobs made with the same key; local / LAN callers only jobs made locally or on the LAN. */
export function sameOwner(a: JobOwner, b: JobOwner): boolean {
  if (a.source === 'public') return b.source === 'public' && a.keyName === b.keyName
  return b.source !== 'public'
}

export interface JobEntry {
  kind: string
  id: string
  upstreamId: string
  /** The model name the client used (`<prefix>-<id>`), for the request record. */
  model: string
  owner: JobOwner
  /** Epoch ms of the create response. */
  at: number
}

export interface JobsDoc {
  version: number
  jobs: JobEntry[]
}

export const JOBS_VERSION = 1
export const JOB_TTL_MS = 7 * 24 * 3600 * 1000
export const MAX_JOBS = 2000

export function defaultJobs(): JobsDoc {
  return { version: JOBS_VERSION, jobs: [] }
}

function isOwner(v: any): v is JobOwner {
  return !!v && (v.source === 'private' || (v.source === 'public' && typeof v.keyName === 'string' && v.keyName !== ''))
}

/** Drops entries that are malformed, so a hand edit cannot route a follow-up to a wrong place. */
export function normalizeJobs(doc: JobsDoc): JobsDoc {
  const jobs = Array.isArray(doc.jobs) ? doc.jobs : []
  return {
    version: doc.version,
    jobs: jobs.filter((j: any) => j && typeof j.kind === 'string' && isJobId(j.id) && typeof j.upstreamId === 'string' && j.upstreamId
      && typeof j.model === 'string' && isOwner(j.owner) && Number.isFinite(j.at)),
  }
}

/** Entries younger than `ttlMs`, newest `max` kept (the doc is ordered oldest first). */
export function pruneJobs(jobs: readonly JobEntry[], now: number, ttlMs = JOB_TTL_MS, max = MAX_JOBS): JobEntry[] {
  const fresh = jobs.filter(j => now - j.at < ttlMs && j.at <= now + 60_000)
  return fresh.slice(Math.max(0, fresh.length - max))
}

/** What the proxy needs. */
export interface JobRegistry {
  /** Remember a job; the registry stamps `at` with its own clock. */
  record(entry: Omit<JobEntry, 'at'>): void
  lookup(kind: string, id: string): JobEntry | null
}

export interface JobStoreOptions {
  dataDir: string
  ttlMs?: number
  max?: number
  now?: () => number
  /** A failed read or write (the mapping still works in memory until the next restart). */
  onError?(e: unknown): void
}

/** data/jobs.json behind a JobRegistry. A corrupt file is kept in the backups and replaced on the next write. */
export class JobStore implements JobRegistry {
  private readonly store: JsonStore<JobsDoc>
  private doc: JobsDoc
  private readonly ttlMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(private readonly opts: JobStoreOptions) {
    this.ttlMs = opts.ttlMs ?? JOB_TTL_MS
    this.max = opts.max ?? MAX_JOBS
    this.now = opts.now ?? Date.now
    this.store = new JsonStore<JobsDoc>({
      dataDir: opts.dataDir, name: 'jobs.json', version: JOBS_VERSION, defaults: defaultJobs, validate: normalizeJobs, keepBackups: 3,
    })
    try {
      this.doc = this.store.load()
    } catch (e) {
      opts.onError?.(e)
      this.doc = defaultJobs()
    }
  }

  record(entry: Omit<JobEntry, 'at'>): void {
    const now = this.now()
    const rest = this.doc.jobs.filter(j => !(j.kind === entry.kind && j.id === entry.id))
    this.doc = { version: JOBS_VERSION, jobs: pruneJobs([...rest, { ...entry, at: now }], now, this.ttlMs, this.max) }
    try {
      this.store.save(this.doc)
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  lookup(kind: string, id: string): JobEntry | null {
    const j = this.doc.jobs.find(x => x.kind === kind && x.id === id)
    if (!j) return null
    const age = this.now() - j.at
    return age < this.ttlMs && age > -60_000 ? j : null
  }
}
