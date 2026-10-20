// Embedding engine (decision 64): one llama-server started with `--embedding` for one embedding model. It runs next to
// the scheduler, not inside it: it does not count toward the online limit, is never unloaded to make room for a chat
// model, and never unloads one. `/v1/*` requests whose `model` is the engine's name go to it (a local model of the same
// name wins). CPU / GPU is a device switch on the same llama.cpp build (`--device none --n-gpu-layers 0` for CPU).
// Pure module: the process start is injected (the service passes the shared Runner, so ports and pids.json are shared).
import { existsSync } from 'node:fs'
import type { FileRef, ModelDir } from './types'
import { resolveFileRef } from './scanner'
import type { Lease } from './scheduler'

export type EmbeddingDevice = 'gpu' | 'cpu'

export interface EmbeddingDoc {
  version: number
  /** Off = not routed, not started; a running engine is stopped when it is switched off. */
  enabled: boolean
  /** Model name clients send in `model`. */
  name: string
  /** The GGUF file, in one of the model directories; null = none chosen yet. */
  file: FileRef | null
  device: EmbeddingDevice
  /** Start with llama-web; off = start on the first request (or by hand). */
  autoStart: boolean
  /** Context size; batch and micro-batch are the same, so one input may use all of it. */
  ctxSize: number
}

export const EMBEDDING_VERSION = 1
export const EMBEDDING_TAG = 'embedding'
export const MIN_CTX = 512
export const MAX_CTX = 131072
export const DEFAULT_CTX = 8192
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function defaultEmbedding(): EmbeddingDoc {
  return { version: EMBEDDING_VERSION, enabled: false, name: '', file: null, device: 'gpu', autoStart: false, ctxSize: DEFAULT_CTX }
}

export type EmbeddingErrorCode =
  | 'bad-name' | 'bad-file' | 'bad-device' | 'bad-ctx' | 'name-local-conflict' | 'incomplete'
  // runtime
  | 'disabled' | 'no-file' | 'file-missing' | 'no-runtime' | 'blocked' | 'aborted' | 'crashed' | 'load-failed'

export class EmbeddingError extends Error {
  constructor(public code: EmbeddingErrorCode, message: string = code, public tail: string[] = []) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

export const validName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v)

function cleanFile(v: unknown): FileRef | null {
  if (v === null || v === undefined) return null
  if (!isObj(v) || typeof v.dirId !== 'string' || !v.dirId || typeof v.rel !== 'string' || !/\.gguf$/i.test(v.rel)) throw new EmbeddingError('bad-file')
  return { dirId: v.dirId, rel: v.rel.replace(/\\/g, '/') }
}

/** Store validation: fills missing fields with defaults, rejects wrong types. */
export function normalizeEmbedding(doc: EmbeddingDoc): EmbeddingDoc {
  if (!isObj(doc)) throw new Error('embedding must be an object')
  const d = defaultEmbedding()
  const out: EmbeddingDoc = {
    version: doc.version,
    enabled: typeof doc.enabled === 'boolean' ? doc.enabled : d.enabled,
    name: typeof doc.name === 'string' ? doc.name.trim() : d.name,
    file: cleanFile(doc.file),
    device: doc.device === 'cpu' || doc.device === 'gpu' ? doc.device : d.device,
    autoStart: typeof doc.autoStart === 'boolean' ? doc.autoStart : d.autoStart,
    ctxSize: Number.isInteger(doc.ctxSize) && doc.ctxSize >= MIN_CTX && doc.ctxSize <= MAX_CTX ? doc.ctxSize : d.ctxSize,
  }
  if (out.name && !validName(out.name)) throw new Error(`invalid embedding model name "${out.name}"`)
  if (out.enabled && (!out.name || !out.file)) out.enabled = false
  return out
}

/** Fields the management API may change. */
export interface EmbeddingEdit {
  enabled?: unknown
  name?: unknown
  file?: unknown
  device?: unknown
  autoStart?: unknown
  ctxSize?: unknown
}

/**
 * Apply an edit from the management API to `draft` (throws EmbeddingError on bad input). `localNames` are the names of
 * the configured chat models: the engine cannot take one of them (the local model would win the route).
 */
export function applyEmbeddingEdit(draft: EmbeddingDoc, edit: EmbeddingEdit, localNames: readonly string[]): EmbeddingDoc {
  if (!isObj(edit)) throw new EmbeddingError('incomplete')
  if (edit.name !== undefined) {
    const name = typeof edit.name === 'string' ? edit.name.trim() : ''
    if (name && !validName(name)) throw new EmbeddingError('bad-name')
    if (name && localNames.some(n => n.toLowerCase() === name.toLowerCase())) throw new EmbeddingError('name-local-conflict')
    draft.name = name
  }
  if (edit.file !== undefined) draft.file = cleanFile(edit.file)
  if (edit.device !== undefined) {
    if (edit.device !== 'gpu' && edit.device !== 'cpu') throw new EmbeddingError('bad-device')
    draft.device = edit.device
  }
  if (edit.ctxSize !== undefined) {
    const n = Number(edit.ctxSize)
    if (!Number.isInteger(n) || n < MIN_CTX || n > MAX_CTX) throw new EmbeddingError('bad-ctx')
    draft.ctxSize = n
  }
  if (edit.autoStart !== undefined) draft.autoStart = edit.autoStart === true
  if (edit.enabled !== undefined) draft.enabled = edit.enabled === true
  if (draft.enabled && (!draft.name || !draft.file)) throw new EmbeddingError('incomplete')
  return draft
}

/** Fields whose change needs a restart of a running engine. */
export const launchKey = (d: EmbeddingDoc) => JSON.stringify([d.file, d.device, d.ctxSize])

/** llama-server arguments (without the executable). `--host` / `--port` are always llama-web's. */
export function embeddingArgs(o: { file: string, device: EmbeddingDevice, ctxSize: number, host: string, port: number }): string[] {
  const n = String(o.ctxSize)
  const args = ['--model', o.file, '--embedding', '--ctx-size', n, '--batch-size', n, '--ubatch-size', n]
  if (o.device === 'cpu') args.push('--device', 'none', '--n-gpu-layers', '0')
  else args.push('--n-gpu-layers', '999')
  args.push('--host', o.host, '--port', String(o.port))
  return args
}

export interface EmbeddingLaunch {
  exe: string
  args: (port: number) => string[]
  tag: string
  device: EmbeddingDevice
  loadTimeoutMs: number
}

/** Resolve the saved configuration into a launch; throws EmbeddingError when something is missing. */
export function planEmbedding(cfg: EmbeddingDoc, input: { dirs: ModelDir[], exe: string | null, host: string, loadTimeoutMs: number, exists?: (p: string) => boolean }): EmbeddingLaunch {
  const exists = input.exists ?? existsSync
  if (!cfg.file) throw new EmbeddingError('no-file')
  const file = resolveFileRef(input.dirs, cfg.file)
  if (!file || !exists(file)) throw new EmbeddingError('file-missing')
  if (!input.exe || !exists(input.exe)) throw new EmbeddingError('no-runtime')
  const { device, ctxSize } = cfg
  return { exe: input.exe, tag: EMBEDDING_TAG, device, loadTimeoutMs: input.loadTimeoutMs, args: port => embeddingArgs({ file, device, ctxSize, host: input.host, port }) }
}

// ---------------------------------------------------------------------------------------
// Engine

/** The parts of a started process the engine uses (RunningProcess fits). */
export interface EmbeddingProc {
  port: number
  ready: Promise<void>
  exited: Promise<{ code: number | null, requested: boolean }>
  stop(): Promise<unknown>
  tail(n?: number): string[]
}

export type EmbeddingState = 'stopped' | 'loading' | 'ready' | 'failed'

export interface EmbeddingView {
  enabled: boolean
  name: string
  device: EmbeddingDevice
  state: EmbeddingState
  /** Device of the process that runs (or loads) now; null when none. */
  runningDevice: EmbeddingDevice | null
  /** The saved configuration differs from what runs: a restart applies it. */
  restartNeeded: boolean
  inflight: number
  /** Time of the last state change (ms). */
  since: number
  error: { code: string, message: string, tail: string[] } | null
}

export interface EngineDeps {
  config(): EmbeddingDoc
  plan(cfg: EmbeddingDoc): EmbeddingLaunch
  spawn(launch: EmbeddingLaunch): Promise<EmbeddingProc>
  /** Name of an external upstream that holds the machine for itself (decision 56); nothing starts meanwhile. */
  blocked?(): string | null
  onChange?(): void
  log?(msg: string): void
  now?(): number
}

export class EmbeddingEngine {
  private state: EmbeddingState = 'stopped'
  private error: EmbeddingView['error'] = null
  private since: number
  private proc: EmbeddingProc | null = null
  private running: { device: EmbeddingDevice, key: string } | null = null
  private loading: Promise<void> | null = null
  private stopping: Promise<void> = Promise.resolve()
  private gen = 0
  private inflight = 0
  private ac = new AbortController()

  constructor(private deps: EngineDeps) {
    this.since = this.now()
  }

  private now() { return this.deps.now?.() ?? Date.now() }

  private set(state: EmbeddingState, error: unknown = null) {
    this.state = state
    this.since = this.now()
    if (state === 'failed') {
      const e = error instanceof EmbeddingError ? error : null
      const le = error as { code?: unknown, message?: unknown, tail?: unknown } | null
      this.error = {
        code: e?.code ?? (typeof le?.code === 'string' ? le.code : 'load-failed'),
        message: String(le?.message ?? error),
        tail: Array.isArray(le?.tail) ? (le.tail as string[]).slice(-30) : [],
      }
    } else this.error = null
    this.deps.onChange?.()
  }

  /** True while a process runs or loads. */
  get active(): boolean { return this.proc !== null || this.loading !== null }

  /** Name requests must use, or null while the engine is off. */
  routeName(): string | null {
    const c = this.deps.config()
    return c.enabled && c.name ? c.name : null
  }

  view(): EmbeddingView {
    const c = this.deps.config()
    return {
      enabled: c.enabled, name: c.name, device: c.device, state: this.state,
      runningDevice: this.running?.device ?? null,
      restartNeeded: this.running !== null && this.running.key !== launchKey(c),
      inflight: this.inflight, since: this.since, error: this.error,
    }
  }

  /** Start (or join the start in progress). Resolves when the engine is ready. */
  start(): Promise<void> {
    if (this.state === 'ready' && this.proc) return Promise.resolve()
    if (this.loading) return this.loading
    const gen = ++this.gen
    const run = this.launch(gen)
    this.loading = run
    const clear = () => { if (this.loading === run) this.loading = null }
    run.then(clear, clear)
    return run
  }

  private async launch(gen: number): Promise<void> {
    await this.stopping
    if (gen !== this.gen) throw new EmbeddingError('aborted')
    const cfg = this.deps.config()
    let launch: EmbeddingLaunch
    try {
      if (!cfg.enabled) throw new EmbeddingError('disabled')
      const holder = this.deps.blocked?.()
      if (holder) throw new EmbeddingError('blocked', holder)
      launch = this.deps.plan(cfg)
    } catch (e) {
      this.set('failed', e)
      throw e
    }
    this.set('loading')
    this.running = { device: launch.device, key: launchKey(cfg) }
    this.deps.log?.(`embedding: starting ${cfg.name} on ${launch.device}`)
    let proc: EmbeddingProc
    try {
      proc = await this.deps.spawn(launch)
    } catch (e) {
      if (gen === this.gen) { this.running = null; this.set('failed', e) }
      throw e
    }
    if (gen !== this.gen) {
      await proc.stop()
      throw new EmbeddingError('aborted')
    }
    this.proc = proc
    const ac = this.ac = new AbortController()
    void proc.exited.then((x) => {
      if (this.proc !== proc) return
      this.proc = null
      this.running = null
      ac.abort(new EmbeddingError('crashed'))
      if (this.state === 'ready') {
        this.deps.log?.(`embedding: exited (code ${x.code ?? '-'})`)
        if (x.requested) this.set('stopped')
        else this.set('failed', new EmbeddingError('crashed', `Exited with code ${x.code ?? '-'}`, proc.tail(30)))
      }
    })
    try {
      await proc.ready
    } catch (e) {
      if (gen !== this.gen) throw new EmbeddingError('aborted')
      if (this.proc === proc) { this.proc = null; this.running = null }
      this.deps.log?.(`embedding: load failed: ${(e as Error)?.message ?? e}`)
      this.set('failed', e)
      throw e
    }
    if (gen !== this.gen) throw new EmbeddingError('aborted')
    this.deps.log?.(`embedding: ready on port ${proc.port}`)
    this.set('ready')
  }

  /** Stop the process (requests running on it are interrupted). */
  async stop(): Promise<void> {
    this.gen++
    this.loading = null
    const p = this.proc
    this.proc = null
    this.running = null
    this.ac.abort(new EmbeddingError('aborted'))
    const s = p ? p.stop().then(() => {}, () => {}) : Promise.resolve()
    this.stopping = s
    await s
    if (this.state !== 'stopped') this.set('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Lease the engine for one request, starting it first when needed. */
  async acquire(signal?: AbortSignal): Promise<Lease> {
    if (!this.deps.config().enabled) throw new EmbeddingError('disabled')
    if (!(this.state === 'ready' && this.proc)) {
      const started = this.start()
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal.reason)
          if (signal.aborted) return onAbort()
          signal.addEventListener('abort', onAbort, { once: true })
          started.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
        })
      } else await started
    }
    const proc = this.proc
    if (!proc || this.state !== 'ready') throw new EmbeddingError('aborted')
    this.inflight++
    this.deps.onChange?.()
    let released = false
    return {
      target: { modelId: EMBEDDING_TAG, profile: '-' },
      port: proc.port,
      signal: this.ac.signal,
      release: () => {
        if (released) return
        released = true
        this.inflight--
        this.deps.onChange?.()
      },
    }
  }
}
