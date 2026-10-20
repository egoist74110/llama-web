// Embedding engine (decision 64): configuration, arguments, the engine's lifecycle, and /v1 routing to it.
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultSettings, type ModelsDoc } from '../../server/core/config'
import {
  applyEmbeddingEdit, defaultEmbedding, embeddingArgs, EmbeddingEngine, EmbeddingError, normalizeEmbedding, planEmbedding,
  type EmbeddingDoc, type EmbeddingLaunch, type EmbeddingProc,
} from '../../server/core/embedding'
import { createProxy } from '../../server/core/proxy'
import type { RequestRecord } from '../../server/core/request-log'
import type { Lease, Target } from '../../server/core/scheduler'

const FILE = { dirId: 'main', rel: 'emb/Qwen3-Embedding-0.6B-Q8_0.gguf' }
const DIRS = [{ id: 'main', path: 'X:\\models', enabled: true, maxDepth: 3 }]
const on = (over: Partial<EmbeddingDoc> = {}): EmbeddingDoc => ({ ...defaultEmbedding(), enabled: true, name: 'qwen3-embed', file: FILE, ...over })

describe('configuration', () => {
  test('defaults: off, GPU, 8192 context, no autostart', () => {
    const d = defaultEmbedding()
    expect(d).toMatchObject({ enabled: false, name: '', file: null, device: 'gpu', autoStart: false, ctxSize: 8192 })
  })

  test('normalize fills missing fields, drops bad values, and switches off an incomplete engine', () => {
    const n = normalizeEmbedding({ version: 1, enabled: true, name: 'x', file: null } as unknown as EmbeddingDoc)
    expect(n.enabled).toBe(false)
    expect(n.device).toBe('gpu')
    const m = normalizeEmbedding({ version: 1, enabled: true, name: 'x', file: { dirId: 'main', rel: 'a\\b.gguf' }, device: 'tpu', ctxSize: 3 } as unknown as EmbeddingDoc)
    expect(m).toMatchObject({ enabled: true, file: { dirId: 'main', rel: 'a/b.gguf' }, device: 'gpu', ctxSize: 8192 })
    expect(() => normalizeEmbedding({ version: 1, name: 'bad name' } as unknown as EmbeddingDoc)).toThrow()
    expect(() => normalizeEmbedding({ version: 1, file: { dirId: 'main', rel: 'x.bin' } } as unknown as EmbeddingDoc)).toThrow()
  })

  test('edits are validated; a chat model name cannot be taken', () => {
    const d = defaultEmbedding()
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as EmbeddingError).code } return null }
    expect(code(() => applyEmbeddingEdit(d, { name: 'has space' }, []))).toBe('bad-name')
    expect(code(() => applyEmbeddingEdit(d, { name: 'Chat' }, ['chat']))).toBe('name-local-conflict')
    expect(code(() => applyEmbeddingEdit(d, { device: 'npu' }, []))).toBe('bad-device')
    expect(code(() => applyEmbeddingEdit(d, { ctxSize: 100 }, []))).toBe('bad-ctx')
    expect(code(() => applyEmbeddingEdit(d, { enabled: true }, []))).toBe('incomplete')
    applyEmbeddingEdit(d, { enabled: true, name: 'qwen3-embed', file: FILE, device: 'cpu', ctxSize: '4096', autoStart: true }, ['chat'])
    expect(d).toMatchObject({ enabled: true, name: 'qwen3-embed', file: FILE, device: 'cpu', ctxSize: 4096, autoStart: true })
  })
})

describe('arguments', () => {
  test('GPU: everything offloaded; CPU: no device and no layers; host / port last and always ours', () => {
    const gpu = embeddingArgs({ file: 'X:\\models\\e.gguf', device: 'gpu', ctxSize: 4096, host: '127.0.0.1', port: 7101 })
    expect(gpu).toEqual(['--model', 'X:\\models\\e.gguf', '--embedding', '--ctx-size', '4096', '--batch-size', '4096', '--ubatch-size', '4096', '--n-gpu-layers', '999', '--host', '127.0.0.1', '--port', '7101'])
    const cpu = embeddingArgs({ file: 'e.gguf', device: 'cpu', ctxSize: 512, host: '127.0.0.1', port: 7102 })
    expect(cpu).toContain('--embedding')
    expect(cpu.slice(cpu.indexOf('--device'), cpu.indexOf('--device') + 4)).toEqual(['--device', 'none', '--n-gpu-layers', '0'])
    expect(cpu).not.toContain('999')
  })

  test('plan: file and build must exist', () => {
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as EmbeddingError).code } return null }
    const base = { dirs: DIRS, exe: 'X:\\rt\\llama-server.exe', host: '127.0.0.1', loadTimeoutMs: 1000 }
    expect(code(() => planEmbedding(on({ file: null }), { ...base, exists: () => true }))).toBe('no-file')
    expect(code(() => planEmbedding(on({ file: { dirId: 'gone', rel: 'a.gguf' } }), { ...base, exists: () => true }))).toBe('file-missing')
    expect(code(() => planEmbedding(on(), { ...base, exists: p => !p.endsWith('.gguf') }))).toBe('file-missing')
    expect(code(() => planEmbedding(on(), { ...base, exists: p => p.endsWith('.gguf') }))).toBe('no-runtime')
    expect(code(() => planEmbedding(on(), { ...base, exe: null, exists: () => true }))).toBe('no-runtime')
    const plan = planEmbedding(on({ device: 'cpu' }), { ...base, exists: () => true })
    expect(plan.device).toBe('cpu')
    expect(plan.args(7105)).toContain('none')
    expect(plan.args(7105).slice(-2)).toEqual(['--port', '7105'])
  })
})

// ---------------------------------------------------------------------------------------

interface FakeProc extends EmbeddingProc {
  launch: EmbeddingLaunch
  becomeReady(): void
  failLoad(e: unknown): void
  exit(code: number, requested?: boolean): void
  stopped: boolean
}

function fakeProc(launch: EmbeddingLaunch, port: number): FakeProc {
  let ready!: () => void, fail!: (e: unknown) => void, exited!: (x: { code: number | null, requested: boolean }) => void
  const p: FakeProc = {
    launch, port, stopped: false,
    ready: new Promise<void>((res, rej) => { ready = res; fail = rej }),
    exited: new Promise(res => { exited = res }),
    async stop() { p.stopped = true; fail(new Error('aborted')); exited({ code: null, requested: true }) },
    tail: () => ['line a', 'line b'],
    becomeReady: () => ready(),
    failLoad: (e) => { fail(e); exited({ code: 1, requested: false }) },
    exit: (code, requested = false) => exited({ code, requested }),
  }
  p.ready.catch(() => {})
  return p
}

function engine(cfg: { doc: EmbeddingDoc }, opts: { blocked?: () => string | null, autoReady?: boolean, port?: number } = {}) {
  const procs: FakeProc[] = []
  const e = new EmbeddingEngine({
    config: () => cfg.doc,
    plan: c => planEmbedding(c, { dirs: DIRS, exe: 'X:\\rt\\llama-server.exe', host: '127.0.0.1', loadTimeoutMs: 1000, exists: () => true }),
    spawn: async (launch) => {
      const p = fakeProc(launch, opts.port ?? 7100 + procs.length)
      procs.push(p)
      if (opts.autoReady) queueMicrotask(() => p.becomeReady())
      return p
    },
    blocked: opts.blocked,
  })
  return { e, procs }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('engine', () => {
  test('one start for concurrent requests; leases count in-flight requests', async () => {
    const cfg = { doc: on() }
    const { e, procs } = engine(cfg)
    const a = e.acquire()
    const b = e.acquire()
    await tick()
    expect(procs.length).toBe(1)
    expect(e.view().state).toBe('loading')
    procs[0]!.becomeReady()
    const [la, lb] = await Promise.all([a, b])
    expect(la.port).toBe(7100)
    expect(e.view()).toMatchObject({ state: 'ready', inflight: 2, runningDevice: 'gpu', restartNeeded: false })
    la.release(); la.release()
    lb.release()
    expect(e.view().inflight).toBe(0)
  })

  test('disabled: no start, acquire refuses', async () => {
    const { e, procs } = engine({ doc: on({ enabled: false }) })
    await expect(e.acquire()).rejects.toMatchObject({ code: 'disabled' })
    expect(procs.length).toBe(0)
  })

  test('an exclusive upstream blocks the start', async () => {
    const { e, procs } = engine({ doc: on() }, { blocked: () => 'ComfyUI' })
    await expect(e.start()).rejects.toMatchObject({ code: 'blocked' })
    expect(procs.length).toBe(0)
    expect(e.view().error?.code).toBe('blocked')
  })

  test('a failed load is reported with the output tail; the next request tries again', async () => {
    const { e, procs } = engine({ doc: on() })
    const a = e.acquire()
    await tick()
    procs[0]!.failLoad(Object.assign(new Error('Exited with code 1'), { code: 'exited', tail: ['bad model'] }))
    await expect(a).rejects.toThrow()
    expect(e.view().state).toBe('failed')
    expect(e.view().error).toMatchObject({ code: 'exited', tail: ['bad model'] })
    const b = e.acquire()
    await tick()
    expect(procs.length).toBe(2)
    procs[1]!.becomeReady()
    await b
    expect(e.view().state).toBe('ready')
    expect(e.view().error).toBeNull()
  })

  test('a crash aborts running leases and shows as failed', async () => {
    const { e, procs } = engine({ doc: on() }, { autoReady: true })
    const lease = await e.acquire()
    procs[0]!.exit(3)
    await tick()
    expect(lease.signal.aborted).toBe(true)
    expect(e.view().state).toBe('failed')
    expect(e.view().error?.code).toBe('crashed')
    expect(e.active).toBe(false)
  })

  test('stop aborts leases; a stop while loading cancels the load', async () => {
    const { e, procs } = engine({ doc: on() }, { autoReady: true })
    const lease = await e.acquire()
    await e.stop()
    expect(lease.signal.aborted).toBe(true)
    expect(procs[0]!.stopped).toBe(true)
    expect(e.view().state).toBe('stopped')

    const { e: e2, procs: p2 } = engine({ doc: on() })
    const pending = e2.start()
    await tick()
    await e2.stop()
    await expect(pending).rejects.toBeDefined()
    expect(p2[0]!.stopped).toBe(true)
    expect(e2.view().state).toBe('stopped')
  })

  test('CPU / GPU switch: restartNeeded until a restart, then the new device runs', async () => {
    const cfg = { doc: on() }
    const { e, procs } = engine(cfg, { autoReady: true })
    await e.start()
    expect(procs[0]!.launch.args(1)).toContain('999')
    cfg.doc = { ...cfg.doc, device: 'cpu' }
    expect(e.view().restartNeeded).toBe(true)
    expect(e.view().runningDevice).toBe('gpu')
    await e.restart()
    expect(procs[0]!.stopped).toBe(true)
    expect(procs[1]!.launch.device).toBe('cpu')
    expect(procs[1]!.launch.args(1)).toEqual(expect.arrayContaining(['--device', 'none', '--n-gpu-layers', '0']))
    expect(e.view()).toMatchObject({ state: 'ready', runningDevice: 'cpu', restartNeeded: false })
  })
})

// ---------------------------------------------------------------------------------------

describe('/v1 routing', () => {
  const closers: Array<() => unknown> = []
  afterEach(async () => { for (const c of closers.splice(0)) await c() })

  function fakeServer() {
    const seen: Array<{ path: string, body: string }> = []
    const srv = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        seen.push({ path: new URL(req.url).pathname, body: await req.text() })
        return Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 4, total_tokens: 4 } })
      },
    })
    closers.push(() => srv.stop(true))
    return { seen, port: srv.port! }
  }

  function setup(models: ModelsDoc, cfg: { doc: EmbeddingDoc }, port: number) {
    const { e, procs } = engine(cfg, { autoReady: true, port })
    const acquired: Target[] = []
    const records: RequestRecord[] = []
    const proxy = createProxy({
      scheduler: {
        acquire: async (target: Target): Promise<Lease> => { acquired.push(target); throw new Error('no local server in this test') },
        snapshot: () => ({ models: [], queue: [] }),
        stateOf: () => 'ready',
      },
      getModels: () => models, getSettings: () => defaultSettings(),
      onRequest: r => records.push(r),
      embedding: e,
    })
    return { proxy, e, procs, acquired, records }
  }

  const post = (body: unknown) => new Request('http://127.0.0.1:3000/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('the engine name (any case) starts the engine and forwards the body unchanged, without the scheduler', async () => {
    const srv = fakeServer()
    const s = setup({ version: 1, models: [] }, { doc: on() }, srv.port)
    const body = { model: 'QWEN3-embed', input: ['hello', 'world'] }
    const res = await s.proxy.handleV1(post(body))
    expect(res.status).toBe(200)
    expect((await res.json()).data[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(srv.seen).toEqual([{ path: '/v1/embeddings', body: JSON.stringify(body) }])
    expect(s.acquired).toEqual([])
    expect(s.procs.length).toBe(1)
    expect(s.e.view().inflight).toBe(0)
    await tick()
    expect(s.records.at(-1)).toMatchObject({ modelId: 'embedding', modelName: 'qwen3-embed', status: 200, promptTokens: 4 })
  })

  test('token count of a large response with usage before data (llama-server key order) is recorded', async () => {
    const big = Array.from({ length: 3 }, (_, i) => ({ embedding: Array.from({ length: 1024 }, (_, k) => (k + i) / 7919), index: i, object: 'embedding' }))
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(JSON.stringify({ model: 'x', object: 'list', usage: { prompt_tokens: 22, total_tokens: 22 }, data: big }), { headers: { 'content-type': 'application/json' } }) })
    closers.push(() => srv.stop(true))
    const s = setup({ version: 1, models: [] }, { doc: on() }, srv.port!)
    const res = await s.proxy.handleV1(post({ model: 'qwen3-embed', input: ['a', 'b', 'c'] }))
    expect((await res.json()).data.length).toBe(3)
    await tick()
    expect(s.records.at(-1)).toMatchObject({ status: 200, promptTokens: 22, completionTokens: null })
  })

  test('listed in /v1/models and /v1/models/:name while enabled; not when off', async () => {
    const cfg = { doc: on() }
    const s = setup({ version: 1, models: [] }, cfg, 1)
    expect((await (await s.proxy.handleV1(new Request('http://127.0.0.1:3000/v1/models'))).json()).data.map((m: { id: string }) => m.id)).toEqual(['qwen3-embed'])
    expect((await s.proxy.handleV1(new Request('http://127.0.0.1:3000/v1/models/qwen3-embed'))).status).toBe(200)
    cfg.doc = on({ enabled: false })
    expect((await (await s.proxy.handleV1(new Request('http://127.0.0.1:3000/v1/models'))).json()).data).toEqual([])
    const res = await s.proxy.handleV1(post({ model: 'qwen3-embed', input: 'x' }))
    expect(res.status).toBe(404)
    expect(s.procs.length).toBe(0)
  })

  test('a local model of the same name wins', async () => {
    const models = { version: 1, models: [{ id: 'm1', name: 'qwen3-embed', backend: 'llama-server', file: FILE, mmproj: null, draft: null, activeProfile: 'default', profiles: { default: { overrides: {}, extraArgs: '' } } }] } as unknown as ModelsDoc
    const s = setup(models, { doc: on() }, 1)
    const res = await s.proxy.handleV1(post({ model: 'qwen3-embed', input: 'x' }))
    expect(s.acquired).toEqual([{ modelId: 'm1', profile: 'default' }])
    expect(res.status).toBe(500)
    expect(s.procs.length).toBe(0)
  })

  test('an engine that cannot start answers 503 embedding_unavailable', async () => {
    const cfg = { doc: on({ file: { dirId: 'nowhere', rel: 'x.gguf' } }) }
    const s = setup({ version: 1, models: [] }, cfg, 1)
    const res = await s.proxy.handleV1(post({ model: 'qwen3-embed', input: 'x' }))
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.error.code).toBe('embedding_unavailable')
    expect(j.error.message).toContain('file-missing')
  })
})
