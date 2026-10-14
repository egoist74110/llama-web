import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type ModelConfig, type ModelsDoc } from '../../server/core/config'
import { effectiveRuntime, planLaunch } from '../../server/core/launch'
import { ProfileError, useCpuBuild } from '../../server/core/models-admin'
import { GPU_KEYS } from '../../server/core/gpu-group'
import { platformInfo } from '../../server/core/platform'
import { handlePublic } from '../../server/core/public-entry'
import { type RuntimeEntryAccel, type RuntimeEnv } from '../../server/core/runtimes'
import { JsonStore } from '../../server/core/store'
import type { AppContext } from '../../server/service/context'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-model-runtime-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function model(): ModelConfig {
  return {
    id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'model.gguf' }, mmproj: null, draft: null,
    runtime: 'vulkan:b3000', activeProfile: 'p',
    profiles: {
      p: { overrides: { ctxSize: 4096 }, extraArgs: '', runtime: 'vulkan:b4000' },
      other: { overrides: {}, extraArgs: '', runtime: 'custom:other', device: 'Vulkan1' },
    },
  }
}

function fixture() {
  const settings = defaultSettings()
  settings.llamacpp.currentCpu = 'b2000'
  settings.llamacpp.currentVulkan = 'b3000'
  settings.modelDirs = [{ id: 'd', path: join(dir, 'models'), enabled: true, maxDepth: 1 }]
  const target = { os: 'win32' as const, arch: 'x64', acceleration: 'vulkan' as const, gpuChannel: 'vulkan' as const }
  const env: RuntimeEnv = {
    dataDir: dir, target, entries: [], exists: () => true,
    installed: accel => accel === 'cpu' ? ['b2000', 'b1000'] : accel === 'vulkan' ? ['b4000', 'b3000'] : [],
  }
  const doc: ModelsDoc = { version: 1, models: [model()] }
  const input = { dataDir: dir, settings, target, platform: 'win32' as const, runtimeEnv: env, exists: env.exists }
  return { settings, target, env, doc, input }
}

test('effective runtime follows profile, model, then global exactly as launch', () => {
  const f = fixture()
  const m = f.doc.models[0]!
  for (const expected of ['b4000', 'b3000', 'b3000']) {
    const runtime = effectiveRuntime(m, m.profiles.p!.runtime, f.input)
    expect(runtime?.label).toBe(expected)
    expect(runtime).toEqual(planLaunch({ modelId: 'm', profile: 'p' }, { ...f.input, models: f.doc, host: '127.0.0.1' }).runtime)
    if (m.profiles.p!.runtime) delete m.profiles.p!.runtime
    else delete m.runtime
  }
  expect(effectiveRuntime(m, undefined, f.input)).toEqual({ ref: null, label: 'b3000', accel: 'vulkan', fallback: null })
})

test('effective runtime reports the same fallback and accel as launch', () => {
  const f = fixture()
  const m = f.doc.models[0]!
  for (const [ref, reason] of [['cpu:b9999', 'missing'], ['cuda:b4000', 'other-platform'], ['bad-ref', 'invalid']] as const) {
    m.profiles.p!.runtime = ref
    const runtime = effectiveRuntime(m, ref, f.input)
    expect(runtime?.fallback?.reason).toBe(reason)
    expect(runtime?.accel).toBe(ref.startsWith('cpu:') ? 'cpu' : 'vulkan')
    expect(runtime).toEqual(planLaunch({ modelId: 'm', profile: 'p' }, { ...f.input, models: f.doc, host: '127.0.0.1' }).runtime)
  }
})

test('effective runtime preserves every registered build type and label', () => {
  const f = fixture()
  for (const accel of ['cuda', 'cpu', 'metal', 'vulkan', 'sycl', 'rocm'] as RuntimeEntryAccel[]) {
    f.env.entries = [{ id: 'custom-build', label: `Build ${accel}`, source: { kind: 'dir', from: 'example' }, os: 'win32', arch: 'x64', accel, tag: '', addedAt: '' }]
    expect(effectiveRuntime(model(), 'custom:custom-build', f.input)).toEqual({ ref: 'custom:custom-build', label: `Build ${accel}`, accel, fallback: null })
  }
})

test('effective runtime is null for no installed fallback or absent current executable', () => {
  const f = fixture()
  f.env.installed = () => []
  expect(effectiveRuntime(model(), 'cpu:b9999', f.input)).toBeNull()
  expect(effectiveRuntime({}, undefined, { ...f.input, exists: () => false })).toBeNull()
  f.settings.llamacpp.currentVulkan = ''
  expect(effectiveRuntime({}, undefined, f.input)).toBeNull()
})

test('CPU switch sets model runtime and removes only the active profile override', () => {
  const f = fixture()
  const other = structuredClone(f.doc.models[0]!.profiles.other)
  const result = useCpuBuild(f.doc, 'm', undefined, f.settings, f.env)
  expect(result).toEqual({ runtime: 'cpu:b2000', deviceCleared: false })
  expect(f.doc.models[0]!.runtime).toBe('cpu:b2000')
  expect(f.doc.models[0]!.profiles.p).toEqual({ overrides: { ctxSize: 4096 }, extraArgs: '' })
  expect(f.doc.models[0]!.profiles.other).toEqual(other)
  expect(effectiveRuntime(f.doc.models[0]!, undefined, f.input)?.accel).toBe('cpu')
})

test('explicit profile overrides the active profile for CPU switch', () => {
  const f = fixture()
  const active = structuredClone(f.doc.models[0]!.profiles.p)
  expect(useCpuBuild(f.doc, 'm', 'other', f.settings, f.env).deviceCleared).toBe(true)
  expect(f.doc.models[0]!.profiles.p).toEqual(active)
  expect(f.doc.models[0]!.profiles.other).toEqual({ overrides: {}, extraArgs: '' })
})

test('CPU switch requires the installed current tag, never an older version or Metal channel', () => {
  for (const kind of ['missing-current', 'unset-current', 'mac'] as const) {
    const f = fixture()
    if (kind === 'missing-current') f.env.installed = () => ['b1000']
    if (kind === 'unset-current') f.settings.llamacpp.currentCpu = ''
    if (kind === 'mac') {
      f.env.target = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }
      f.settings.llamacpp.current = 'b2000'
    }
    const before = structuredClone(f.doc)
    expect(() => useCpuBuild(f.doc, 'm', undefined, f.settings, f.env)).toThrow(new ProfileError('no-cpu-build'))
    expect(f.doc).toEqual(before)
  }
})

test('unknown profile and model fail before any mutation', () => {
  const f = fixture()
  const before = structuredClone(f.doc)
  expect(() => useCpuBuild(f.doc, 'm', 'missing', f.settings, f.env)).toThrow(new ProfileError('profile-not-found'))
  expect(() => useCpuBuild(f.doc, 'missing', undefined, f.settings, f.env)).toThrow(new ProfileError('model-not-found'))
  expect(f.doc).toEqual(before)
})

test('CPU switch clears specific GPU choices along the profile/model path', () => {
  const f = fixture()
  const m = f.doc.models[0]!
  m.device = 'Vulkan0'
  m.profiles.p!.device = 'Vulkan1'
  const other = structuredClone(m.profiles.other)
  expect(useCpuBuild(f.doc, 'm', undefined, f.settings, f.env).deviceCleared).toBe(true)
  expect(m.device).toBeUndefined()
  expect(m.profiles.p!.device).toBeUndefined()
  expect(m.profiles.other).toEqual(other)
  const plan = planLaunch({ modelId: 'm', profile: 'p' }, { ...f.input, models: f.doc, host: '127.0.0.1' })
  expect(plan.runtime.accel).toBe('cpu')
  expect(plan.devices).toEqual([])
  expect(plan.args(7100)).not.toContain('--device')
})

test('CPU switch clears both GPU groups with all their split fields', () => {
  const f = fixture()
  const m = f.doc.models[0]!
  const group = { devices: ['Vulkan0', 'Vulkan1'], splitMode: 'row', tensorSplit: '3,1', mainGpu: '1' }
  Object.assign(m, group)
  Object.assign(m.profiles.p!, group)
  expect(useCpuBuild(f.doc, 'm', undefined, f.settings, f.env).deviceCleared).toBe(true)
  for (const layer of [m, m.profiles.p!]) for (const key of GPU_KEYS) expect(Object.hasOwn(layer, key)).toBe(false)
})

test('auto/cpu effective choices are kept, including a shadowed model GPU choice', () => {
  for (const device of ['auto', 'cpu']) {
    const f = fixture()
    const m = f.doc.models[0]!
    m.device = 'Vulkan0'
    m.profiles.p!.device = device
    expect(useCpuBuild(f.doc, 'm', undefined, f.settings, f.env).deviceCleared).toBe(false)
    expect(m.profiles.p!.device).toBe(device)
    expect(m.device).toBe('Vulkan0')
    delete m.profiles.p!.device
    m.device = device
    expect(useCpuBuild(f.doc, 'm', undefined, f.settings, f.env).deviceCleared).toBe(false)
    expect(m.device).toBe(device)
  }
})

test('clearing a profile GPU preserves the model auto choice', () => {
  const f = fixture()
  const m = f.doc.models[0]!
  m.device = 'auto'
  m.profiles.p!.device = 'Vulkan0'
  expect(useCpuBuild(f.doc, 'm', undefined, f.settings, f.env).deviceCleared).toBe(true)
  expect(m.device).toBe('auto')
  expect(m.profiles.p!.device).toBeUndefined()
})

async function withRoutes(fn: (get: (event: never) => unknown, post: (event: never) => Promise<unknown>, ctx: AppContext, store: JsonStore<ModelsDoc>, updates: () => number, restarts: Array<[string, string | undefined]>) => Promise<void>) {
  const f = fixture()
  const store = new JsonStore<ModelsDoc>({ dataDir: dir, name: 'models.json', version: 1, defaults: () => f.doc })
  store.load()
  let updates = 0
  const restarts: Array<[string, string | undefined]> = []
  const ctx = {
    dataDir: dir, platform: platformInfo('win32', 'x64', 'none'), runtimeTarget: f.target,
    getSettings: () => f.settings, getModels: () => store.get(),
    updateModels: (mutate: (doc: ModelsDoc) => void) => { updates++; return store.update(mutate) },
    runtimes: { env: () => f.env },
    ops: { upProfiles: () => [], inUseProfiles: () => [], restartIfUp: (id: string, profile?: string) => { restarts.push([id, profile]); return Promise.resolve() } },
  } as unknown as AppContext
  const globals = globalThis as Record<string | symbol, unknown>
  const bindings = {
    defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: { id: string }) => event.id,
    getQuery: (event: { query?: unknown }) => event.query ?? {},
    readBody: async (event: { body?: unknown }) => event.body,
    createError: (info: { message: string }) => Object.assign(new Error(info.message), info),
  }
  const previous = Object.keys(bindings).map(key => [key, globals[key]] as const)
  const key = Symbol.for('llama-web.context')
  const oldCtx = globals[key]
  Object.assign(globals, bindings)
  globals[key] = ctx
  try {
    const get = (await import('../../server/api/models/[id]/index.get')).default
    const post = (await import('../../server/api/models/[id]/use-cpu.post')).default
    await fn(get, post, ctx, store, () => updates, restarts)
  } finally {
    store.close()
    for (const [name, value] of [...previous, [key, oldCtx] as const]) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

test('detail endpoint resolves the requested profile or active profile and rejects unknown profiles', async () => {
  await withRoutes(async (get, _post, ctx) => {
    ctx.getModels().models[0]!.profiles.other!.runtime = 'cpu:b2000'
    expect(get({ id: 'm' } as never)).toMatchObject({ effectiveRuntime: { accel: 'vulkan', ref: 'vulkan:b4000' } })
    expect(get({ id: 'm', query: { profile: 'other' } } as never)).toMatchObject({ effectiveRuntime: { accel: 'cpu', ref: 'cpu:b2000' } })
    expect(() => get({ id: 'm', query: { profile: 'missing' } } as never)).toThrow()
    const env = ctx.runtimes.env()
    env.installed = () => []
    expect(get({ id: 'm' } as never)).toMatchObject({ effectiveRuntime: null })
  })
})

test('use-cpu endpoint persists one atomic transaction, then restarts the model like the runtime endpoint', async () => {
  await withRoutes(async (_get, post, ctx, store, updates, restarts) => {
    ctx.getModels().models[0]!.device = 'Vulkan0'
    const response = await post({ id: 'm', body: { restart: true } } as never)
    expect(response).toEqual({ ok: true, runtime: 'cpu:b2000', deviceCleared: true, restarted: true })
    expect(updates()).toBe(1)
    expect(restarts).toEqual([['m', undefined]])
    const persisted = JSON.parse(readFileSync(store.file, 'utf8')) as ModelsDoc
    expect(persisted.models[0]!.runtime).toBe('cpu:b2000')
    expect(persisted.models[0]!.profiles.p!.runtime).toBeUndefined()
    expect(persisted.models[0]!.device).toBeUndefined()
    expect(persisted.models[0]!.profiles.other).toEqual(model().profiles.other)
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
  })
})

test('use-cpu endpoint defaults restart to false and reports stopped models without restart', async () => {
  await withRoutes(async (_get, post, ctx, _store, updates, restarts) => {
    expect(await post({ id: 'm', body: { profile: 'other' } } as never)).toEqual({ ok: true, runtime: 'cpu:b2000', deviceCleared: true, restarted: false })
    expect(updates()).toBe(1)
    expect(restarts).toEqual([])
    ctx.ops.restartIfUp = () => false
    expect(await post({ id: 'm', body: { restart: true } } as never)).toMatchObject({ restarted: false })
  })
})

test('use-cpu endpoint returns 409 no-cpu-build without writes, backups or restarts', async () => {
  await withRoutes(async (_get, post, ctx, store, updates, restarts) => {
    const before = readFileSync(store.file, 'utf8')
    ctx.runtimes.env().installed = () => ['b1000']
    await expect(post({ id: 'm', body: { restart: true } } as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'no-cpu-build' } })
    expect(updates()).toBe(1)
    expect(readFileSync(store.file, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['models.json'])
    expect(restarts).toEqual([])
  })
})

test('use-cpu endpoint rejects an unknown profile with the existing 404 error', async () => {
  await withRoutes(async (_get, post, _ctx, store, _updates, restarts) => {
    const before = readFileSync(store.file, 'utf8')
    await expect(post({ id: 'm', body: { profile: 'missing', restart: true } } as never)).rejects.toMatchObject({ statusCode: 404 })
    expect(readFileSync(store.file, 'utf8')).toBe(before)
    expect(restarts).toEqual([])
  })
})

test('model management facts and CPU mutation are unavailable through the public entry', async () => {
  for (const path of ['/api/models/m', '/api/models/m/use-cpu']) {
    const response = await handlePublic(new Request(`http://example.com${path}`, { method: path.endsWith('use-cpu') ? 'POST' : 'GET' }), {} as never)
    expect(response.status).toBe(404)
  }
})
