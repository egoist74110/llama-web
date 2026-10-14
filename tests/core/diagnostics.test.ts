import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_VERSION } from '../../server/core/app-info'
import { planLaunch } from '../../server/core/launch'
import { sanitizeForm, saveProfile } from '../../server/core/models-admin'
import { defaultSettings, type ModelConfig } from '../../server/core/config'
import { buildDiagnostics, DIAGNOSTIC_META_PREFIX, parseDiagnosticMeta, type DiagnosticsInput } from '../../server/core/diagnostics'
import { LogStore } from '../../server/core/logs'
import { LoadError } from '../../server/core/runner'
import { handlePublic } from '../../server/core/public-entry'
import { platformInfo, selectRuntime } from '../../server/core/platform'
import { selectableHere } from '../../server/core/runtimes'
import { defaultSecrets } from '../../server/core/keys'
import { modelDiagnostics } from '../../server/service/diagnostics'
import { describeLlamacpp } from '../../server/service/llamacpp-api'
import type { AppContext } from '../../server/service/context'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-diag-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const keys = ['example-api-secret', 'example-upstream-secret', 'example-tunnel-token', 'example-cloudflare-token']
const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  os: 'win32', arch: 'x64', acceleration: { saved: 'vulkan', active: 'vulkan', gpuChannel: 'vulkan', reason: null },
  runtime: { ref: 'vulkan:b1234', label: 'b1234', accel: 'vulkan', tag: 'b1234' },
  devices: { source: 'list-devices', gpus: [{ id: 'Vulkan0', name: 'Intel Arc Graphics', totalMiB: 8192, freeMiB: 4096 }] },
  nvidiaProbe: 'missing', failure: 'gpu-error', log: [], secrets: keys, username: 'example-user', ...over,
})
const model = (): ModelConfig => ({ id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'd', rel: 'model.gguf' }, mmproj: null, draft: null, activeProfile: 'p', profiles: { p: { overrides: {}, extraArgs: '' } } })

test('diagnostics have English keys in a stable section order and only the last 60 lines', () => {
  const text = buildDiagnostics(input({ log: Array.from({ length: 100 }, (_, n) => `line-${n}`) }))
  expect(text.startsWith(`llama-web.version: ${APP_VERSION}\nos: win32\narch: x64`)).toBe(true)
  const sections = ['llama-web.version:', 'os:', 'arch:', 'acceleration.saved:', 'acceleration.active:', 'acceleration.gpuChannel:', 'acceleration.reason:', 'runtime.ref:', 'runtime.label:', 'runtime.accel:', 'runtime.tag:', 'devices:', 'nvidia.probe:', 'failure.kind:', 'log.tail:']
  expect(sections.map(s => text.indexOf(s))).toEqual(sections.map(s => text.indexOf(s)).sort((a, b) => a - b))
  expect(text).toContain('  id: Vulkan0\n  name: Intel Arc Graphics\n  totalMiB: 8192\n  freeMiB: 4096')
  expect(text).not.toContain('line-39\n')
  expect(text.split('log.tail:\n')[1]!.split('\n')).toHaveLength(60)
  expect(text.endsWith('line-99')).toBe(true)
})

test('paths, UNC paths, home paths, all secrets and machine usernames are redacted', () => {
  const text = buildDiagnostics(input({ log: [
    'open "C:\\Users\\example-user\\My Models\\model.gguf"',
    'open C:\\models\\model.gguf',
    'open \\\\example-server\\share\\subdir\\model.gguf',
    'open "\\\\example-server\\share\\My Models\\model.gguf"',
    'open /Users/example-user/models/model.gguf',
    "open '/home/example-user/My Models/model.gguf'",
    'open q/sub/model.gguf',
    'open /Users/example-user/My Models/model.gguf',
    'open C:\\Users\\example-user\\My Models\\model.gguf',
    'open "q/My Models/model.gguf"',
    `auth ${keys[0]} upstream ${keys[1]} token ${keys[2]} cloudflare ${keys[3]}`,
    'machine user: EXAMPLE-USER',
    'load C:\\Program Files\\engine\\ggml-vulkan.dll',
    'load /home/example-user/My Configs/settings.json',
    'at C:\\Users\\example-user\\Build Files\\kernel.cpp(123)',
  ] }))
  for (const value of [...keys, 'example-user', 'EXAMPLE-USER', 'example-server', 'My Models', 'My Configs', 'Build Files', 'Program Files', 'C:\\models', '/Users/', '/home/', 'q/sub/']) expect(text).not.toContain(value)
  expect(text.match(/<path>\/model\.gguf/g)).toHaveLength(10)
  expect(text).toContain('auth *** upstream *** token ***')
  expect(text).toContain('load <path>/ggml-vulkan.dll')
  expect(text).toContain('load <path>/settings.json')
  expect(text).toContain('at <path>/kernel.cpp(123)')
  expect(text).toContain('machine user: <user>')
})

test('missing devices, absent metadata and missing logs remain explicit', () => {
  const text = buildDiagnostics(input({ runtime: null, devices: null, log: null, failure: null }))
  expect(text).toContain('runtime: unavailable\ndevices: unavailable\nnvidia.probe: missing\nfailure.kind: none\nlog.tail:\nunavailable')
  expect(parseDiagnosticMeta('output without metadata')).toBeNull()
  expect(parseDiagnosticMeta(DIAGNOSTIC_META_PREFIX + JSON.stringify({ profile: 'p', runtime: { ref: '../../outside', label: 'L', accel: 'vulkan', tag: 'b1234' } }))).toBeNull()
})

async function withContext<T>(ctx: unknown, fn: () => Promise<T> | T): Promise<T> {
  const key = Symbol.for('llama-web.context')
  const globals = globalThis as Record<symbol, unknown>
  const old = globals[key]
  globals[key] = ctx
  try { return await fn() } finally { if (old === undefined) delete globals[key]; else globals[key] = old }
}

function fixture(accel: 'cpu' | 'vulkan' = 'vulkan', cpuInstalled = true) {
  const s = defaultSettings()
  s.llamacpp.acceleration = accel
  s.llamacpp.currentCpu = cpuInstalled ? 'b1234' : ''
  s.llamacpp.currentVulkan = 'b1234'
  const platform = platformInfo('win32', 'x64', 'none')
  const boot = selectRuntime(platform, accel)
  const env = { dataDir: dir, target: boot.target, entries: [], installed: (a: string) => a === 'cpu' && !cpuInstalled ? [] : ['b1234'] }
  const updater = (a: 'cpu' | 'vulkan') => ({
    refresh: () => env.installed(a), versions: () => env.installed(a).map(tag => ({ tag, current: true, inUse: false })),
    getStatus: () => env.installed(a).length ? { state: 'ready', tag: 'b1234' } : { state: 'disabled' }, rollbackTarget: () => null, getUpdateCheck: () => ({ state: 'idle' }),
  })
  const logs = new LogStore({ dir: join(dir, 'logs'), retention: () => ({ keepRunsPerModel: 3, keepDays: 14 }) })
  const secrets = defaultSecrets()
  secrets.apiKeys = [{ id: 'k', name: 'example', key: keys[0]!, createdAt: '', revoked: false, allowSwitch: false }]
  secrets.upstreamKeys = { u: keys[1]! }
  secrets.tunnelToken = keys[2]!
  secrets.cloudflareToken = keys[3]!
  let doc = { version: 1, models: [model()] }
  const probes: string[] = []
  const secondaryAccel = accel === 'cpu' ? 'vulkan' : 'cpu'
  const ctx = {
    platform, runtimeTarget: boot.target, runtimeSelection: boot, getSettings: () => s, getSecrets: () => secrets,
    getModels: () => doc, updateModels: (fn: (d: typeof doc) => void) => { const d = structuredClone(doc); fn(d); doc = d },
    runtimes: { env: () => env, list: () => ({ rows: [], hiddenOtherPlatform: 0 }) },
    updater: updater(accel), secondary: { accel: secondaryAccel, updater: updater(secondaryAccel), current: () => secondaryAccel === 'cpu' ? s.llamacpp.currentCpu : s.llamacpp.currentVulkan },
    getLastModelFailure: () => null,
    logs, scheduler: { snapshot: () => ({ models: [{ modelId: 'm', profile: 'p', error: new LoadError('exited', 'failed', 1, ['ggml_vulkan: No devices found']) }], queue: [] }) },
    getDeviceInfo: async (ref: string) => { probes.push(ref); return { devices: input().devices } },
  } as unknown as AppContext
  return { ctx, logs, probes, s }
}

test('service uses the actual logged runtime and newest log, not a later configured runtime', async () => {
  const f = fixture()
  try {
    const older = f.logs.startRun('m')
    older.append('old run'); older.close()
    const run = f.logs.startRun('m')
    run.append('# llama-web: starting m:p')
    run.append(DIAGNOSTIC_META_PREFIX + JSON.stringify({ profile: 'p', runtime: input().runtime }))
    for (let n = 0; n < 70; n++) run.append(`new-${n}`)
    run.append(`key ${keys[1]} path C:\\models\\model.gguf`)
    // Change the saved model after the failure; diagnostics must still say Vulkan.
    f.ctx.getModels().models[0]!.runtime = 'cpu:b1234'
    await withContext(f.ctx, async () => {
      const result = await modelDiagnostics(model())
      expect(result.text).toContain('runtime.ref: vulkan:b1234')
      expect(result.text).toContain('failure.kind: gpu-error')
      expect(result.text).not.toContain('old run')
      expect(result.text).not.toContain('new-10\n')
      expect(result.text).toContain('key *** path <path>/model.gguf')
      expect(f.probes).toEqual(['vulkan:b1234'])
      f.ctx.getLastModelFailure = () => 'oom'
      expect((await modelDiagnostics(model())).text).toContain('failure.kind: oom')
    })
    run.close()
  } finally { f.logs.closeAll() }
})

test('service reports missing logs and does not probe a deleted runtime fallback', async () => {
  const f = fixture()
  try {
    await withContext(f.ctx, async () => {
      expect((await modelDiagnostics(model())).text).toContain('runtime: unavailable\ndevices: unavailable')
      const run = f.logs.startRun('m')
      run.append('# llama-web: starting m:p')
      run.append(DIAGNOSTIC_META_PREFIX + JSON.stringify({ profile: 'p', runtime: { ...input().runtime!, ref: 'vulkan:b9', tag: 'b9', label: 'b9' } }))
      run.close()
      expect((await modelDiagnostics(model())).text).toContain('runtime.ref: vulkan:b9')
      expect((await modelDiagnostics(model())).text).toContain('devices: unavailable')
      expect(f.probes).toEqual([])
    })
  } finally { f.logs.closeAll() }
})

test('CPU runtime selection is accepted on Vulkan hosts and describes installation in main or secondary', async () => {
  const globals = globalThis as Record<string, unknown>
  const names = ['defineEventHandler', 'getRouterParam', 'readBody']
  const saved = names.map(name => [name, globals[name]] as const)
  globals.defineEventHandler = (handler: unknown) => handler
  globals.getRouterParam = (event: { id: string }) => event.id
  globals.readBody = async (event: { body: unknown }) => event.body
  try {
    const route = (await import('../../server/api/models/[id]/runtime.post')).default
    for (const accel of ['vulkan', 'cpu'] as const) {
      for (const installed of [true, false]) {
        const f = fixture(accel, installed)
        try {
          await withContext(f.ctx, async () => {
            expect(selectableHere('cpu:b1234', f.ctx.runtimes.env())).toBe(true)
            await route({ id: 'm', body: { runtime: 'cpu:b1234' } } as never)
            expect(f.ctx.getModels().models[0]!.runtime).toBe('cpu:b1234')
            const doc = describeLlamacpp()
            const cpu = accel === 'cpu' ? doc : doc.secondary!
            expect(cpu.current).toBe(installed ? 'b1234' : '')
            expect(cpu.versions.map(v => v.tag)).toEqual(installed ? ['b1234'] : [])
          })
        } finally { f.logs.closeAll() }
      }
    }
  } finally { for (const [name, value] of saved) { if (value === undefined) delete globals[name]; else globals[name] = value } }
})

test('public entry cannot expose model diagnostics, even with an authorization header', async () => {
  let calls = 0
  const response = await handlePublic(new Request('http://example.com/api/models/m/diagnostics', { headers: { authorization: 'Bearer example' } }), {
    authenticate: () => { calls++; return { ok: false } }, handleV1: async () => { calls++; return new Response('unexpected') },
  })
  expect(response.status).toBe(404)
  expect(calls).toBe(0)
})


test('diagnostics endpoint returns text and refuses unknown models', async () => {
  const globals = globalThis as Record<string, unknown>
  const names = ['defineEventHandler', 'getRouterParam', 'createError']
  const previous = names.map(name => [name, globals[name]] as const)
  globals.defineEventHandler = (handler: unknown) => handler
  globals.getRouterParam = (event: { id: string }) => event.id
  globals.createError = (info: { message: string, statusCode: number }) => Object.assign(new Error(info.message), info)
  const f = fixture()
  try {
    const route = (await import('../../server/api/models/[id]/diagnostics.get')).default
    await withContext(f.ctx, async () => {
      const result = await route({ id: 'm' } as never)
      expect(Object.keys(result)).toEqual(['text'])
      expect(result.text).toContain(`llama-web.version: ${APP_VERSION}`)
      expect(result.text).toContain('log.tail:\nunavailable')
      await expect(route({ id: 'unknown' } as never)).rejects.toMatchObject({ statusCode: 404 })
    })
  } finally {
    f.logs.closeAll()
    for (const [name, value] of previous) { if (value === undefined) delete globals[name]; else globals[name] = value }
  }
})

test('CPU recovery preserves profile precedence and the existing profile save can clear it', () => {
  const s = defaultSettings()
  s.modelDirs = [{ id: 'd', path: 'X:\\models', enabled: true, maxDepth: 1 }]
  const m = model()
  m.runtime = 'cpu:b1234'
  m.profiles.p!.runtime = 'vulkan:b1234'
  const target = { os: 'win32' as const, arch: 'x64', acceleration: 'vulkan' as const, gpuChannel: 'vulkan' as const }
  const doc = { version: 1, models: [m] }
  const input = { dataDir: dir, settings: s, models: doc, host: '127.0.0.1', target, exists: () => true,
    runtimeEnv: { dataDir: dir, target, entries: [], installed: () => ['b1234'] } }
  expect(planLaunch({ modelId: 'm', profile: 'p' }, input).runtime.accel).toBe('vulkan')
  saveProfile(doc, 'm', 'p', sanitizeForm({ overrides: {}, extraArgs: '', runtime: null }), [])
  const cpu = planLaunch({ modelId: 'm', profile: 'p' }, input)
  expect(cpu.runtime.accel).toBe('cpu')
  expect(cpu.args(7100)).toContain('0')
})
