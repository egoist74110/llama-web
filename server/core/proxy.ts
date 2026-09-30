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
import { LaunchConfigError } from './launch'
import { resolvePreprocessOptions, runPreprocess, type PreprocessResult } from './preprocess'
import { findModel, hasImages, listModelNames, resolveTarget, type RouteResult } from './routing'
import { LoadError } from './runner'
import { ModelCrashError, SchedulerError, type Lease, type Scheduler, type Target } from './scheduler'

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
    const onAbort = () => { done(); reject(signal.reason) }
    const done = () => {
      signal.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
    }
    p.then((v) => { done(); resolve(v) }, (e) => { done(); reject(e) })
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (ms !== undefined) timer = setTimeout(() => { done(); reject(new Error(`timed out after ${ms} ms`)) }, ms)
  })
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
}

// ---------------------------------------------------------------------------------------
// Errors

type ErrorType = 'invalid_request_error' | 'not_found_error' | 'server_error'

export function errorResponse(status: number, code: string, message: string): Response {
  const type: ErrorType = status === 404 ? 'not_found_error' : status < 500 ? 'invalid_request_error' : 'server_error'
  return Response.json({ error: { message, type, code } }, { status })
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
  if (cause instanceof LoadError || cause instanceof LaunchConfigError) return cause.code
  if (cause instanceof ModelCrashError) return 'crashed'
  return 'unknown'
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
  }
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
  async function forward(call: UpstreamCall, modelName: string): Promise<Response> {
    let up: Awaited<ReturnType<typeof callUpstream>>
    try {
      up = await callUpstream(call)
    } catch (e) {
      call.lease.release()
      return upstreamFailure(e, call.lease, modelName)
    }
    const { res, ac, cleanup } = up
    let finished = false
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      cleanup()
      call.lease.release(ok && res.status < 500 ? 'ok' : undefined)
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
  function streamWhileLoading(req: Request, target: Target, path: string, body: Uint8Array<ArrayBuffer> | null, modelName: string): Response {
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const writer = ts.writable.getWriter()
    const gone = new AbortController()
    const onClient = () => gone.abort(req.signal.reason)
    req.signal.addEventListener('abort', onClient, { once: true })
    writer.closed.catch(() => gone.abort(new Error('client disconnected')))
    const send = (text: string) => writer.write(enc.encode(text))
    const sendError = async (r: Response) => {
      try {
        await send(`data: ${await r.text()}\n\n`)
        await writer.close()
      } catch { /* client gone */ }
    }
    const heartbeatMs = deps.heartbeatMs ?? deps.getSettings().scheduler.heartbeatSec * 1000
    const finalEventMs = deps.finalEventTimeoutMs ?? 5000
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
        req.signal.removeEventListener('abort', onClient)
        if (gone.signal.aborted) writer.abort().catch(() => {})
        else await sendError(schedulerErrorResponse(e, modelName))
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
        req.signal.removeEventListener('abort', onClient)
        lease.release()
        if (!gone.signal.aborted) await sendError(upstreamFailure(e, lease, modelName))
        return
      }
      const { res, ac, cleanup } = up
      let ok = false
      let released = false
      const finish = () => {
        if (released) return
        released = true
        cleanup()
        lease.release(ok ? 'ok' : undefined)
      }
      // `ac` aborts when the client goes away (fakeReq carries gone.signal) or the model is
      // unloaded / crashes (lease.signal): release the lease at once, like forward().
      ac.signal.addEventListener('abort', finish, { once: true })
      try {
        if (!res.ok || !res.body) {
          // Headers are already sent as SSE; report the upstream error as an event.
          const text = await res.text()
          await bounded(send(`data: ${text || JSON.stringify({ error: { message: res.statusText, code: res.status } })}\n\n`), ac.signal)
          ok = res.status < 500
        } else {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
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
          // Model gone, client still connected: try to tell it, but never wait forever for a
          // client that does not read; give up after a while and end the response.
          const told = await bounded(
            sendError(errorResponse(503, 'model_interrupted', fmt(t.api.interrupted, { model: modelName }))),
            gone.signal, finalEventMs,
          ).then(() => true, () => false)
          if (!told) writer.abort(e).catch(() => {})
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

  async function handleV1(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) return modelsList()
    if (req.method === 'GET' && path.startsWith('/v1/models/')) {
      const name = decodeURIComponent(path.slice('/v1/models/'.length))
      if (!listModelNames(deps.getModels()).includes(name)) {
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

    const models = deps.getModels()
    const route = resolveTarget(models, json && typeof json === 'object' ? json.model : undefined, deps.scheduler.snapshot().models)
    if (!route.ok) return routeErrorResponse(route)
    const { target, model, profile } = route

    let body = raw
    if (json && typeof json === 'object') {
      if (hasImages(json) && !model.mmproj) {
        return errorResponse(400, 'image_without_mmproj', fmt(t.api.imageWithoutMmproj, { model: model.name }))
      }
      try {
        const result = await runPreprocess(json, { options: resolvePreprocessOptions(deps.getSettings().preprocess, profile) })
        if (Object.keys(result.reports).length) deps.onEvent?.({ type: 'preprocess', target, result })
        if (result.changed) body = new TextEncoder().encode(JSON.stringify(json))
      } catch (e) {
        return errorResponse(500, 'preprocess_failed', fmt(t.api.preprocessFailed, { detail: String((e as Error)?.message ?? e) }))
      }
    }

    const upstreamPath = path + url.search
    const streaming = !!json && json.stream === true
    if (streaming && deps.scheduler.stateOf(target) !== 'ready') {
      return streamWhileLoading(req, target, upstreamPath, body, model.name)
    }
    let lease: Lease
    try {
      lease = await deps.scheduler.acquire(target, { signal: req.signal })
    } catch (e) {
      return schedulerErrorResponse(e, model.name)
    }
    return forward({ lease, req, path: upstreamPath, body }, model.name)
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
