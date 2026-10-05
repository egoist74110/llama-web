// OpenAI-compatible forwarding for /v1/* and raw pass-through for /upstream/:model/*.
// Works on standard Request / Response so it runs under the custom Bun entry (production)
// and behind a Nitro route (nuxt dev) alike.
//
// Invariants:
// - Every lease is released exactly once: when the upstream body ends, errors, or the
//   client goes away (req.signal abort or response body cancel). Otherwise draining never ends.
// - Streaming bodies are passed through chunk by chunk (pull-driven, no buffering).
// - While a streaming request waits for a model load, `: loading` SSE comments keep the
//   connection alive every heartbeat interval.
import type { ModelsDoc, Settings } from './config'
import { fmt, t } from './i18n'
import { resolvePreprocessOptions, runPreprocess, type PreprocessResult } from './preprocess'
import { sourceOf, summarizeImages, summarizeParams, UsageTap, type RequestMeta, type RequestRecord } from './request-log'
import { findModel, hasImages, listModelNames, resolveTarget, type RouteResult } from './routing'
import { diagnose } from './errors'
import { effectiveReasoning, forceThinkingOff } from './thinking-guard'
import type { SpeedMeter } from './speed'
import { SchedulerError, type Lease, type NoRoomDetail, type Scheduler, type Target } from './scheduler'

/** Request body limit for /v1 and /upstream (bytes). */
export const MAX_BODY_BYTES = 100 * 1024 * 1024

export type ProxyEvent =
  | { type: 'preprocess', target: Target, result: PreprocessResult }
  | { type: 'upstream-error', target: Target, error: unknown }

/**
 * `p`, rejected early when `signal` aborts (or after `ms`). The abort listener lives only
 * as long as this one wait, so calling it once per chunk does not accumulate waiters.
 */
export function bounded<T>(p: Promise<T>, signal: AbortSignal, ms?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let listening = false
    const onAbort = () => { done(); reject(signal.reason) }
    const done = () => {
      if (listening) {
        listening = false
        activeWaits--
        signal.removeEventListener('abort', onAbort)
      }
      if (timer) clearTimeout(timer)
    }
    p.then((v) => { done(); resolve(v) }, (e) => { done(); reject(e) })
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    listening = true
    activeWaits++
    if (ms !== undefined) timer = setTimeout(() => { done(); reject(new Error(`timed out after ${ms} ms`)) }, ms)
  })
}

let activeWaits = 0

/** Number of bounded() waits currently holding an abort listener (tests). */
export function activeBoundedWaits(): number {
  return activeWaits
}

export interface ProxyDeps {
  scheduler: Pick<Scheduler, 'acquire' | 'snapshot' | 'stateOf'>
  getModels(): ModelsDoc
  getSettings(): Settings
  maxBodyBytes?: number
  /** Heartbeat interval in ms; defaults to settings.scheduler.heartbeatSec. */
  heartbeatMs?: number
  /** How long to wait for a stalled client to take the final error event (tests). */
  finalEventTimeoutMs?: number
  /** Load progress 0..100 for the heartbeat comment, when known. */
  progressOf?(target: Target): number | null
  /** Host llama-server listens on. */
  upstreamHost?: string
  onEvent?(e: ProxyEvent): void
  /** Called once per finished /v1 request (not for GET /v1/models). Must not throw. */
  onRequest?(r: RequestRecord): void
  /** Live speed tracking for streaming responses (estimate per chunk, exact timings at the end). */
  speed?: SpeedMeter
}

// ---------------------------------------------------------------------------------------
// Errors

type ErrorType = 'invalid_request_error' | 'not_found_error' | 'server_error'

const errorCodes = new WeakMap<Response, string>()

export function errorResponse(status: number, code: string, message: string): Response {
  const type: ErrorType = status === 404 ? 'not_found_error' : status < 500 ? 'invalid_request_error' : 'server_error'
  const res = Response.json({ error: { message, type, code } }, { status })
  errorCodes.set(res, code)
  return res
}

/** Error code of a response made by errorResponse(), for the request record. */
const codeOf = (res: Response): string | null => errorCodes.get(res) ?? null

/** Collects what the request record needs while a request is handled; `finish` emits it once. */
class RequestTrace {
  readonly at = Date.now()
  readonly tap = new UsageTap()
  modelId: string | null = null
  modelName: string | null = null
  profile: string | null = null
  stream = false
  params: RequestRecord['params'] = {}
  images: RequestRecord['images'] = null
  /** Set when a streaming path owns the end of the exchange and will call finish() itself. */
  deferred = false
  private done = false
  private flowing = false

  constructor(
    private readonly req: Request,
    private readonly meta: RequestMeta | undefined,
    private readonly emit: ((r: RequestRecord) => void) | null,
    private readonly id: number,
    private readonly speed: SpeedMeter | null = null,
  ) {}

  /** The upstream answered: start live speed tracking (streaming requests only). */
  startFlow(): void {
    if (this.speed && this.stream && this.modelId && this.profile) {
      this.speed.begin(this.id, this.modelId, this.profile)
      this.flowing = true
    }
  }

  /** A response chunk: feeds the usage tail and the speed estimate. */
  chunk(value: Uint8Array): void {
    this.tap.push(value)
    if (this.flowing) this.speed!.chunk(this.id, value)
  }

  finish(status: number, outcome: RequestRecord['outcome'], error: string | null = null): void {
    if (this.done) return
    this.done = true
    const usage = this.tap.result()
    if (this.speed && this.modelId && this.profile) {
      const timings = { promptPerSecond: usage.promptPerSecond, predictedPerSecond: usage.predictedPerSecond }
      if (this.flowing) this.speed.end(this.id, timings)
      else this.speed.record(this.modelId, this.profile, timings)
    }
    if (!this.emit) return
    const { source, keyName } = sourceOf(this.meta)
    const { promptTokens, completionTokens } = usage
    try {
      this.emit({
        id: this.id, at: this.at, source, keyName, method: this.req.method, path: new URL(this.req.url).pathname,
        modelId: this.modelId, modelName: this.modelName, profile: this.profile, stream: this.stream,
        status, outcome, error, durationMs: Date.now() - this.at,
        promptTokens, completionTokens, images: this.images, params: this.params,
      })
    } catch { /* a broken listener must not affect the request */ }
  }
}

function routeErrorResponse(r: Extract<RouteResult, { ok: false }>): Response {
  switch (r.code) {
    case 'model-not-found': return errorResponse(404, 'model_not_found', fmt(t.api.modelNotFound, { name: r.name }))
    case 'profile-not-found': return errorResponse(404, 'profile_not_found', fmt(t.api.profileNotFound, { model: r.model, profile: r.profile }))
    case 'no-model': return errorResponse(400, 'no_model', t.api.noModel)
  }
}

/** Short reason key (see i18n loadError) for a load failure cause. */
export function loadFailureReason(cause: unknown): keyof typeof t.loadError {
  return diagnose(cause)?.kind ?? 'unknown'
}

function schedulerErrorResponse(e: unknown, modelName: string): Response {
  if (!(e instanceof SchedulerError)) {
    return errorResponse(500, 'internal_error', String((e as Error)?.message ?? e))
  }
  switch (e.code) {
    case 'failed': {
      const reason = t.loadError[loadFailureReason(e.cause)]
      return errorResponse(503, 'model_load_failed', fmt(t.api.loadFailed, { model: modelName, reason }))
    }
    case 'stopped': return errorResponse(503, 'model_stopped', fmt(t.api.modelStopped, { model: modelName }))
    case 'shutdown': return errorResponse(503, 'shutting_down', t.api.shuttingDown)
    case 'cancelled': return errorResponse(499, 'cancelled', 'cancelled')
    case 'no-room': return errorResponse(503, 'insufficient_memory', noRoomText(e.cause as NoRoomDetail | undefined, modelName))
  }
}

const gib = (miB: number | null) => (miB === null ? '?' : `${(miB / 1024).toFixed(1)} GB`)

/** Chinese reason of a refused load (decision 42): numbers included, no paths or names beyond the model. */
export function noRoomText(d: NoRoomDetail | undefined, model: string): string {
  const vars = { model, estimate: gib(d?.estimateMiB ?? null), available: gib(d?.availableMiB ?? null), limit: String(d?.limit ?? '') }
  return fmt(t.api.noRoom[d?.reason ?? 'memory'], vars)
}

// ---------------------------------------------------------------------------------------
// Body / headers

class BodyTooLarge extends Error {}

export async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge()
  if (!req.body) return null
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      reader.cancel().catch(() => {})
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding',
  'authorization', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection',
])
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'trailer',
])

export function forwardRequestHeaders(h: Headers): Headers {
  const out = new Headers()
  h.forEach((v, k) => {
    if (DROP_REQUEST.has(k) || k.startsWith('x-llama-web-')) return
    out.set(k, v)
  })
  return out
}

function forwardResponseHeaders(h: Headers): Headers {
  const out = new Headers()
  h.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out.append(k, v) })
  return out
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }

// ---------------------------------------------------------------------------------------

interface UpstreamCall {
  lease: Lease
  req: Request
  path: string
  body: Uint8Array<ArrayBuffer> | null
  headers?: Headers
}

export function createProxy(deps: ProxyDeps) {
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES
  const host = deps.upstreamHost ?? '127.0.0.1'
  const enc = new TextEncoder()
  let requestSeq = 0

  /**
   * Start the upstream request. The returned controller aborts it; `cleanup` detaches the
   * abort listeners (call it when the exchange is over).
   */
  async function callUpstream(call: UpstreamCall): Promise<{ res: Response, ac: AbortController, cleanup: () => void }> {
    const ac = new AbortController()
    const onClient = () => ac.abort(call.req.signal.reason)
    const onLease = () => ac.abort(call.lease.signal.reason)
    const cleanup = () => {
      call.req.signal.removeEventListener('abort', onClient)
      call.lease.signal.removeEventListener('abort', onLease)
    }
    if (call.req.signal.aborted) ac.abort(call.req.signal.reason)
    if (call.lease.signal.aborted) ac.abort(call.lease.signal.reason)
    call.req.signal.addEventListener('abort', onClient, { once: true })
    call.lease.signal.addEventListener('abort', onLease, { once: true })
    try {
      const res = await fetch(`http://${host}:${call.lease.port}${call.path}`, {
        method: call.req.method,
        headers: call.headers ?? forwardRequestHeaders(call.req.headers),
        body: call.body && call.req.method !== 'GET' && call.req.method !== 'HEAD' ? call.body : undefined,
        signal: ac.signal,
        redirect: 'manual',
      })
      return { res, ac, cleanup }
    } catch (e) {
      cleanup()
      throw e
    }
  }

  function upstreamFailure(e: unknown, lease: Lease, modelName: string): Response {
    deps.onEvent?.({ type: 'upstream-error', target: lease.target, error: e })
    if (lease.signal.aborted) return errorResponse(503, 'model_interrupted', fmt(t.api.interrupted, { model: modelName }))
    return errorResponse(502, 'upstream_unreachable', fmt(t.api.upstreamUnreachable, { model: modelName, detail: String((e as Error)?.message ?? e) }))
  }

  /** Forward to the leased model and pass the response through; releases the lease. */
  async function forward(call: UpstreamCall, modelName: string, trace?: RequestTrace): Promise<Response> {
    if (trace) trace.deferred = true
    let up: Awaited<ReturnType<typeof callUpstream>>
    try {
      up = await callUpstream(call)
    } catch (e) {
      call.lease.release()
      const failure = upstreamFailure(e, call.lease, modelName)
      trace?.finish(failure.status, call.lease.signal.aborted || call.req.signal.aborted ? 'aborted' : 'error', codeOf(failure))
      return failure
    }
    const { res, ac, cleanup } = up
    trace?.startFlow()
    let finished = false
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      cleanup()
      call.lease.release(ok && res.status < 500 ? 'ok' : undefined)
      trace?.finish(res.status, !ok ? 'aborted' : res.status >= 400 ? 'error' : 'ok')
    }
    // Client gone or model unloaded: release now, not at the next pull (which may never come
    // when nobody reads the body any more, e.g. under nuxt dev).
    ac.signal.addEventListener('abort', () => finish(false), { once: true })
    const headers = forwardResponseHeaders(res.headers)
    if (!res.body) {
      finish(true)
      return new Response(null, { status: res.status, statusText: res.statusText, headers })
    }
    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finish(true)
            ctrl.close()
          } else {
            trace?.chunk(value)
            ctrl.enqueue(value)
          }
        } catch (e) {
          finish(false)
          ctrl.error(e)
        }
      },
      cancel(reason) {
        // Client went away: stop the upstream generation and free the lease.
        // Abort through the fetch signal only: reader.cancel() on a fetch body from here
        // segfaults Bun 1.3.14 on Windows (reproduced); the abort tears the body down anyway.
        finish(false)
        ac.abort(reason)
      },
    }, { highWaterMark: 0 })
    return new Response(body, { status: res.status, statusText: res.statusText, headers })
  }

  /** Streaming request whose model is not ready: answer at once, heartbeat, then stream. */
  function streamWhileLoading(req: Request, target: Target, path: string, body: Uint8Array<ArrayBuffer> | null, modelName: string, trace: RequestTrace): Response {
    trace.deferred = true
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const writer = ts.writable.getWriter()
    const gone = new AbortController()
    const onClient = () => gone.abort(req.signal.reason)
    req.signal.addEventListener('abort', onClient, { once: true })
    writer.closed.catch(() => gone.abort(new Error('client disconnected')))
    const send = (text: string) => writer.write(enc.encode(text))
    const heartbeatMs = deps.heartbeatMs ?? deps.getSettings().scheduler.heartbeatSec * 1000
    const finalEventMs = deps.finalEventTimeoutMs ?? 5000
    /**
     * Last event of the stream (an error), then close. Every ending path uses this: it never
     * waits forever for a client that stopped reading; on disconnect or timeout the response
     * is aborted instead.
     */
    const sendFinal = async (r: Response) => {
      const told = await bounded((async () => {
        await send(`data: ${await r.text()}\n\n`)
        await writer.close()
      })(), gone.signal, finalEventMs).then(() => true, () => false)
      if (!told) writer.abort().catch(() => {})
    }
    const beat = () => {
      const p = deps.progressOf?.(target)
      send(p == null ? ': loading\n\n' : `: loading ${Math.round(p)}%\n\n`).catch(() => {})
    }

    void (async () => {
      beat()
      const timer = setInterval(beat, heartbeatMs)
      let lease: Lease
      try {
        lease = await deps.scheduler.acquire(target, { signal: gone.signal })
      } catch (e) {
        clearInterval(timer)
        if (gone.signal.aborted) {
          trace.finish(200, 'aborted')
          writer.abort().catch(() => {})
        } else {
          const failure = schedulerErrorResponse(e, modelName)
          trace.finish(200, 'error', codeOf(failure))
          await sendFinal(failure)
        }
        req.signal.removeEventListener('abort', onClient)
        return
      }
      clearInterval(timer)

      // From here on the lease must be released on every path. The client listener stays
      // attached: under nuxt dev req.signal is the only disconnect notice we get.
      const fakeReq = new Request(req.url, { method: req.method, headers: req.headers, signal: gone.signal })
      let up: Awaited<ReturnType<typeof callUpstream>>
      try {
        up = await callUpstream({ lease, req: fakeReq, path, body, headers: forwardRequestHeaders(req.headers) })
      } catch (e) {
        lease.release()
        if (gone.signal.aborted) {
          trace.finish(200, 'aborted')
          writer.abort().catch(() => {})
        } else {
          const failure = upstreamFailure(e, lease, modelName)
          trace.finish(200, lease.signal.aborted ? 'aborted' : 'error', codeOf(failure))
          await sendFinal(failure)
        }
        req.signal.removeEventListener('abort', onClient)
        return
      }
      const { res, ac, cleanup } = up
      trace.startFlow()
      let ok = false
      let released = false
      let upstreamStatus = 200
      const finish = () => {
        if (released) return
        released = true
        cleanup()
        lease.release(ok ? 'ok' : undefined)
        trace.finish(upstreamStatus, !ok ? 'aborted' : upstreamStatus >= 400 ? 'error' : 'ok')
      }
      // `ac` aborts when the client goes away (fakeReq carries gone.signal) or the model is
      // unloaded / crashes (lease.signal): release the lease at once, like forward().
      ac.signal.addEventListener('abort', finish, { once: true })
      try {
        if (!res.ok || !res.body) {
          // Headers are already sent as SSE; report the upstream error as an event.
          const text = await res.text()
          await bounded(send(`data: ${text || JSON.stringify({ error: { message: res.statusText, code: res.status } })}\n\n`), ac.signal)
          upstreamStatus = res.status
          trace.chunk(enc.encode(text))
          ok = res.status < 500
        } else {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            trace.chunk(value)
            // Parked here when the client stopped reading; neither abort wakes these waits
            // by itself, so each one is bounded by `ac`.
            await bounded(writer.ready, ac.signal)
            await bounded(writer.write(value), ac.signal)
          }
          ok = true
        }
        await bounded(writer.close(), ac.signal)
      } catch (e) {
        ac.abort(e)
        if (!gone.signal.aborted && lease.signal.aborted) {
          // Model gone, client still connected: try to tell it (bounded, see sendFinal).
          await sendFinal(errorResponse(503, 'model_interrupted', fmt(t.api.interrupted, { model: modelName })))
        } else {
          writer.abort(e).catch(() => {})
        }
      } finally {
        req.signal.removeEventListener('abort', onClient)
        finish()
      }
    })()

    return new Response(ts.readable, { status: 200, headers: SSE_HEADERS })
  }

  function modelsList(): Response {
    const created = Math.floor(Date.now() / 1000)
    const data = listModelNames(deps.getModels()).map(id => ({ id, object: 'model', created, owned_by: 'llama-web' }))
    return Response.json({ object: 'list', data })
  }

  async function handleV1(req: Request, meta?: RequestMeta): Promise<Response> {
    const url = new URL(req.url)
    const quiet = req.method === 'GET' && url.pathname.startsWith('/v1/models')
    const trace = new RequestTrace(req, meta, quiet ? null : deps.onRequest ?? null, ++requestSeq, quiet ? null : deps.speed ?? null)
    let res: Response
    try {
      res = await handleV1Inner(req, trace)
    } catch (e) {
      trace.finish(500, 'error', 'internal_error')
      throw e
    }
    if (!trace.deferred) trace.finish(res.status, res.status >= 400 ? 'error' : 'ok', codeOf(res))
    return res
  }

  async function handleV1Inner(req: Request, trace: RequestTrace): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) return modelsList()
    if (req.method === 'GET' && path.startsWith('/v1/models/')) {
      const name = decodeURIComponent(path.slice('/v1/models/'.length))
      if (!resolveTarget(deps.getModels(), name).ok) {
        return errorResponse(404, 'model_not_found', fmt(t.api.modelNotFound, { name }))
      }
      return Response.json({ id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'llama-web' })
    }

    let raw: Uint8Array<ArrayBuffer> | null
    try {
      raw = await readBodyLimited(req, limit)
    } catch (e) {
      if (e instanceof BodyTooLarge) return errorResponse(413, 'body_too_large', fmt(t.api.bodyTooLarge, { limit: Math.round(limit / 1024 / 1024) }))
      throw e
    }
    const ctype = req.headers.get('content-type') ?? ''
    let json: any = null
    if (raw && raw.byteLength > 0 && (ctype.includes('json') || ctype === '')) {
      try {
        json = JSON.parse(new TextDecoder().decode(raw))
      } catch {
        if (ctype.includes('json')) return errorResponse(400, 'invalid_json', t.api.badJson)
      }
    }

    trace.stream = !!json && typeof json === 'object' && json.stream === true
    trace.params = summarizeParams(json)
    const models = deps.getModels()
    const route = resolveTarget(models, json && typeof json === 'object' ? json.model : undefined, deps.scheduler.snapshot().models)
    if (!route.ok) return routeErrorResponse(route)
    const { target, model, profile } = route
    trace.modelId = model.id
    trace.modelName = model.name
    trace.profile = target.profile

    let body = raw
    if (json && typeof json === 'object') {
      if (hasImages(json) && !model.mmproj) {
        return errorResponse(400, 'image_without_mmproj', fmt(t.api.imageWithoutMmproj, { model: model.name }))
      }
      try {
        const result = await runPreprocess(json, { options: resolvePreprocessOptions(deps.getSettings().preprocess, profile) })
        if (Object.keys(result.reports).length) deps.onEvent?.({ type: 'preprocess', target, result })
        trace.images = summarizeImages(result.reports.image)
        // A profile with thinking off is a hard rule: the request cannot switch it back on.
        const thinkingForced = effectiveReasoning(deps.getSettings(), profile) === 'off' && forceThinkingOff(json)
        if (result.changed || thinkingForced) body = new TextEncoder().encode(JSON.stringify(json))
      } catch (e) {
        return errorResponse(500, 'preprocess_failed', fmt(t.api.preprocessFailed, { detail: String((e as Error)?.message ?? e) }))
      }
    }

    const upstreamPath = path + url.search
    const streaming = !!json && json.stream === true
    if (streaming && deps.scheduler.stateOf(target) !== 'ready') {
      return streamWhileLoading(req, target, upstreamPath, body, model.name, trace)
    }
    let lease: Lease
    try {
      lease = await deps.scheduler.acquire(target, { signal: req.signal })
    } catch (e) {
      return schedulerErrorResponse(e, model.name)
    }
    return forward({ lease, req, path: upstreamPath, body }, model.name, trace)
  }

  async function handleUpstream(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const m = /^\/upstream\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!m) return errorResponse(404, 'not_found', fmt(t.api.notFound, { path: url.pathname }))
    if (m[2] === undefined) {
      // `/upstream/x` -> `/upstream/x/` so relative links in llama-server's pages resolve.
      return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}` } })
    }
    const name = decodeURIComponent(m[1]!)
    const model = findModel(deps.getModels().models, name)
    if (!model) return errorResponse(404, 'model_not_found', fmt(t.api.modelNotFound, { name }))

    let raw: Uint8Array<ArrayBuffer> | null
    try {
      raw = await readBodyLimited(req, limit)
    } catch (e) {
      if (e instanceof BodyTooLarge) return errorResponse(413, 'body_too_large', fmt(t.api.bodyTooLarge, { limit: Math.round(limit / 1024 / 1024) }))
      throw e
    }
    // Never triggers a load: only a model that is ready right now is reachable here.
    const running = deps.scheduler.snapshot().models.find(s => s.modelId === model.id && s.state === 'ready')
    if (!running) return errorResponse(503, 'model_not_running', fmt(t.api.notRunning, { model: model.name }))
    let lease: Lease
    try {
      lease = await deps.scheduler.acquire({ modelId: running.modelId, profile: running.profile }, { signal: req.signal })
    } catch (e) {
      return schedulerErrorResponse(e, model.name)
    }
    return forward({ lease, req, path: m[2] + url.search, body: raw }, model.name)
  }

  return { handleV1, handleUpstream }
}

export type Proxy = ReturnType<typeof createProxy>
