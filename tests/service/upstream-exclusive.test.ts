// Machine-exclusive external upstream, wired to the real context (decision 56 ⑨): while it answers, no local model
// loads (manual start and request alike) and the live state says who holds the machine; once it is gone for a few
// probes in a row, loading is possible again. The key never reaches the live state. No llama-server runs.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { createUpstream, updateUpstream } from '../../server/core/upstreams'

let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
let up: ReturnType<typeof Bun.serve> | undefined
let upstreamId = ''
const KEY = 'sk-upstream-secret-for-live-state' // pre-commit:allow fake test key

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lw-excl-'))
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...s, llamacpp: { ...s.llamacpp, autoUpdate: false } }))
  const entry = { backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: '默认', profiles: { 默认: { overrides: {}, extraArgs: '' } } }
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [{ id: 'm', name: 'M', ...entry }] }))
  process.env.LLAMA_WEB_DATA = dir
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  up = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'flash' }] }) })
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
  ctx.updateUpstreams((d) => { upstreamId = createUpstream(d, { name: 'Strata', baseUrl: `http://127.0.0.1:${up!.port}/v1` }, { localNames: ['M'], selfPorts: [] }).id })
  ctx.updateSecrets((sec) => { sec.upstreamKeys[upstreamId] = KEY })
})
afterAll(async () => {
  up?.stop(true)
  await ctx?.shutdown()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const M = { modelId: 'm', profile: '默认' }
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, e => e) as { code?: string, cause?: { reason?: string, holder?: string } } | null)

test('nothing holds the machine until the upstream has answered', () => {
  expect(ctx!.health.holder()).toBeNull()
})

test('while it answers: the holder is named, loads are refused, the live state has no key', async () => {
  await ctx!.health.tick()
  expect(ctx!.health.holder()).toBe('Strata')
  const err = await refusal(ctx!.ops.start(M))
  expect(err).toMatchObject({ code: 'no-room', cause: { reason: 'exclusive', holder: 'Strata' } })
  const req = await refusal(ctx!.scheduler.acquire(M))
  expect(req).toMatchObject({ code: 'no-room', cause: { reason: 'exclusive', holder: 'Strata' } })

  const state = ctx!.live.snapshot()
  expect(state.exclusiveHolder).toBe('Strata')
  expect(state.connections?.[0]).toMatchObject({ name: 'Strata', up: true, hasKey: true, local: true, exclusive: true })
  expect(JSON.stringify(state)).not.toContain(KEY)
})

test('with exclusive switched off the upstream is still up but holds nothing, and loading is not refused for it', async () => {
  ctx!.updateUpstreams((d) => { updateUpstream(d, upstreamId, { exclusive: false }, { localNames: [], selfPorts: [] }) })
  expect(ctx!.health.holder()).toBeNull()
  const err = await refusal(ctx!.ops.start(M))
  expect(err?.cause?.reason).not.toBe('exclusive') // it fails for other reasons here (no llama.cpp, no file)
  ctx!.updateUpstreams((d) => { updateUpstream(d, upstreamId, { exclusive: true }, { localNames: [], selfPorts: [] }) })
})

test('after the upstream is gone for three probes loading is possible again', async () => {
  up!.stop(true)
  await ctx!.health.tick(); await ctx!.health.tick()
  expect(ctx!.health.holder()).toBe('Strata')
  await ctx!.health.tick()
  expect(ctx!.health.holder()).toBeNull()
  expect(ctx!.live.snapshot().exclusiveHolder).toBeNull()
  const err = await refusal(ctx!.ops.start(M))
  expect(err?.cause?.reason).not.toBe('exclusive')
})
