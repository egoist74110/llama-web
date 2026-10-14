import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultModels, defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION } from '../../server/core/config'
import { getLocale, setLocale, t } from '../../server/core/i18n'
import { detectPlatform, gpuChannelFor, platformInfo, selectRuntime, type Acceleration } from '../../server/core/platform'
import { resolveRuntimeRef, secondaryRuntimeTarget } from '../../server/core/runtimes'
import { applySettingsPatch, describeAcceleration, SettingsError } from '../../server/core/settings-admin'
import { JsonStore } from '../../server/core/store'
import { cloudflaredPath } from '../../server/core/tunnel'
import { Updater } from '../../server/core/updater'
import { describeSettings } from '../../server/service/settings-api'
import type { AppContext } from '../../server/service/context'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-selection-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const win = { os: 'win32' as const, arch: 'x64' }

function patchError(raw: unknown, host = win): string | null {
  try { applySettingsPatch(defaultSettings(), { llamacpp: raw }, defaultModels(), host); return null }
  catch (e) { if (e instanceof SettingsError) return e.code; throw e }
}

test('detectPlatform distinguishes a name, empty output, ENOENT and all other failures', () => {
  const named = detectPlatform('win32', 'x64', () => 'NVIDIA GeForce RTX 5090\r\n')
  expect(named).toMatchObject({ acceleration: 'cuda', nvidiaProbe: 'found' })
  expect(detectPlatform('win32', 'x64', () => ' \r\n')).toMatchObject({ acceleration: 'cpu', nvidiaProbe: 'none' })
  const fail = (code: string) => () => { throw Object.assign(new Error('probe failed'), { code }) }
  expect(detectPlatform('win32', 'x64', fail('ENOENT'))).toMatchObject({ acceleration: 'unknown', nvidiaProbe: 'missing' })
  for (const code of ['ETIMEDOUT', 'EACCES', 'EIO']) expect(detectPlatform('win32', 'x64', fail(code))).toMatchObject({ acceleration: 'unknown', nvidiaProbe: 'failed' })
  expect(detectPlatform('win32', 'x64', () => { throw new Error('non-zero exit') })).toMatchObject({ acceleration: 'unknown', nvidiaProbe: 'failed' })
  let calls = 0
  for (const arch of ['arm64', 'x64'] as const) {
    const mac = detectPlatform('darwin', arch, () => { calls++; return 'unused' })
    expect(mac).toEqual(platformInfo('darwin', arch))
    expect(mac.nvidiaProbe).toBeUndefined()
  }
  expect(calls).toBe(0)
})

test('GPU channel matrix preserves CUDA after probe failures, and auto never chooses Vulkan', () => {
  for (const probe of ['found', 'none', 'missing', 'failed'] as const) {
    const info = platformInfo('win32', 'x64', probe)
    for (const wanted of ['auto', 'cuda', 'cpu', 'vulkan'] as Acceleration[]) {
      const gpu = wanted === 'vulkan' ? 'vulkan' : wanted === 'cuda' || probe === 'found' || probe === 'failed' ? 'cuda' : 'vulkan'
      const boot = selectRuntime(info, wanted)
      expect(gpuChannelFor(info, wanted)).toBe(gpu)
      expect(boot.target.gpuChannel).toBe(gpu)
      expect(boot.requested).toBe(wanted)
      expect(!!boot.selectionError).toBe(wanted === 'auto' && (probe === 'missing' || probe === 'failed'))
      if (wanted === 'auto') expect(boot.target.acceleration).toBe(probe === 'found' ? 'cuda' : 'cpu')
      if (boot.selectionError) expect(secondaryRuntimeTarget(boot)).toBeNull()
      else expect(secondaryRuntimeTarget(boot)?.acceleration).toBe(boot.target.acceleration === 'cpu' ? gpu : 'cpu')
    }
  }
  expect(secondaryRuntimeTarget(selectRuntime(platformInfo('darwin', 'arm64'), 'auto'))).toBeNull()
  const failed = selectRuntime(platformInfo('win32', 'x64', 'failed'), 'auto')
  const resolved = resolveRuntimeRef('cuda:b1234', { dataDir: dir, target: failed.target, entries: [], installed: accel => accel === 'cuda' ? ['b1234'] : [] })
  expect(resolved).toMatchObject({ ref: 'cuda:b1234', fallback: null })
})

test('Windows runtime patch accepts acceleration alone or with autoUpdate and rejects invalid fields', () => {
  for (const acceleration of ['auto', 'cuda', 'cpu', 'vulkan'] as const) {
    const s = defaultSettings()
    const before = structuredClone(s.llamacpp)
    applySettingsPatch(s, { llamacpp: { acceleration } }, defaultModels(), win)
    expect(s.llamacpp).toEqual({ ...before, acceleration })
    applySettingsPatch(s, { llamacpp: { acceleration, autoUpdate: true } }, defaultModels(), win)
    expect(s.llamacpp).toEqual({ ...before, acceleration, autoUpdate: true })
  }
  for (const acceleration of ['metal', 'sycl', 'rocm', 'CUDA', '', null, 1, true, undefined]) expect(patchError({ acceleration })).toBe('bad-acceleration')
  for (const raw of [{}, null, { acceleration: 'cuda', current: 'b1234' }, { acceleration: 'vulkan', autoUpdate: 'true' }, { autoUpdate: undefined }]) expect(patchError(raw)).toBe('bad-request')
  expect(patchError({ acceleration: 'cpu' }, { os: 'win32', arch: 'arm64' })).toBe('bad-acceleration')
})

test('Mac runtime patches can repeat the current value but cannot change it', () => {
  for (const arch of ['arm64', 'x64']) {
    const host = { os: 'darwin' as const, arch }
    for (const current of ['auto', 'metal', 'cpu'] as const) {
      const s = defaultSettings()
      s.llamacpp.acceleration = current
      applySettingsPatch(s, { llamacpp: { acceleration: current, autoUpdate: true } }, defaultModels(), host)
      expect(s.llamacpp).toMatchObject({ acceleration: current, autoUpdate: true })
      for (const acceleration of ['auto', 'metal', 'cpu', 'cuda', 'vulkan']) {
        if (acceleration === current) continue
        const before = structuredClone(s)
        expect(() => applySettingsPatch(s, { llamacpp: { acceleration, autoUpdate: false } }, defaultModels(), host)).toThrow(SettingsError)
        expect(s).toEqual(before)
      }
    }
  }
})

test('settings describe compares saved values with the boot request, including auto and pending choices', () => {
  for (const probe of ['found', 'none', 'missing', 'failed'] as const) {
    const host = platformInfo('win32', 'x64', probe)
    const boot = selectRuntime(host, 'auto')
    const pending = probe === 'missing' || probe === 'failed'
    expect(describeAcceleration('auto', host, boot)).toEqual({
      saved: 'auto', active: probe === 'found' ? 'cuda' : 'cpu', gpuChannel: probe === 'found' || probe === 'failed' ? 'cuda' : 'vulkan',
      choiceNeeded: pending, reason: pending ? `nvidia-${probe}` : null, options: ['auto', 'cuda', 'cpu', 'vulkan'], restartNeeded: false,
    })
    for (const saved of ['cuda', 'cpu', 'vulkan'] as const) {
      const view = describeAcceleration(saved, host, boot)
      expect(view.restartNeeded).toBe(true)
      expect(view.choiceNeeded).toBe(pending)
      const restarted = selectRuntime(host, saved)
      expect(describeAcceleration(saved, host, restarted)).toMatchObject({ active: saved, choiceNeeded: false, reason: null, restartNeeded: false })
    }
  }
  const mac = platformInfo('darwin', 'arm64')
  expect(describeAcceleration('auto', mac, selectRuntime(mac, 'auto'))).toEqual({ saved: 'auto', active: 'metal', gpuChannel: null, choiceNeeded: false, reason: null, options: ['auto'], restartNeeded: false })
})

test('acceleration saves are atomic and the settings response keeps the startup state until restart', () => {
  const store = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS })
  const key = Symbol.for('llama-web.context')
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[key]
  const locale = getLocale()
  const host = platformInfo('win32', 'x64', 'missing')
  const boot = selectRuntime(host, 'auto')
  const ownCloudflared = cloudflaredPath(dir)
  mkdirSync(dirname(ownCloudflared), { recursive: true })
  writeFileSync(ownCloudflared, '')
  try {
    store.load()
    const ctx = {
      dataDir: dir, platform: host, runtimeTarget: boot.target, runtimeSelection: boot, bootPort: 5001,
      getSettings: () => store.get(), getSettingsRev: () => 1, getSettingsBoot: () => 1,
      getSecrets: () => ({ apiKeys: [], tunnelToken: '' }), publicEntry: { status: () => ({ state: 'off' }) },
    } as unknown as AppContext
    globals[key] = ctx
    expect(describeSettings().acceleration).toEqual(describeAcceleration('auto', host, boot))
    store.update(draft => applySettingsPatch(draft, { llamacpp: { acceleration: 'vulkan', autoUpdate: true } }, defaultModels(), host))
    expect(JSON.parse(readFileSync(store.file, 'utf8')).llamacpp).toMatchObject({ acceleration: 'vulkan', autoUpdate: true })
    expect(describeSettings().acceleration).toMatchObject({ saved: 'vulkan', active: 'cpu', gpuChannel: 'vulkan', choiceNeeded: true, reason: 'nvidia-missing', restartNeeded: true })
    expect(ctx.runtimeTarget).toEqual(boot.target)
    expect(secondaryRuntimeTarget(ctx.runtimeSelection)).toBeNull()
    const bytes = readFileSync(store.file, 'utf8')
    expect(() => store.update(draft => applySettingsPatch(draft, { llamacpp: { autoUpdate: false, acceleration: 'rocm' } }, defaultModels(), host))).toThrow(SettingsError)
    expect(readFileSync(store.file, 'utf8')).toBe(bytes)
    expect(store.get().llamacpp.autoUpdate).toBe(true)
    store.update(draft => applySettingsPatch(draft, { llamacpp: { acceleration: 'auto' } }, defaultModels(), host))
    expect(describeSettings().acceleration.restartNeeded).toBe(false)
  } finally {
    if (previous === undefined) delete globals[key]; else globals[key] = previous
    setLocale(locale)
    store.close()
  }
})

test('a pending choice blocks all downloads and localizes the updater guidance without changing its code', async () => {
  const s = defaultSettings()
  s.llamacpp.autoUpdate = true
  const boot = selectRuntime(platformInfo('win32', 'x64', 'failed'), 'auto')
  let fetches = 0
  const updater = new Updater({ dataDir: dir, platform: 'win32', target: boot.target, selectionError: boot.selectionError, usedExes: () => [], llamacpp: () => s.llamacpp, setCurrent: tag => { s.llamacpp.current = tag }, fetch: async () => { fetches++; throw new Error('must not fetch') } })
  const locale = getLocale()
  try {
    for (const next of ['zh-CN', 'en'] as const) {
      setLocale(next)
      expect(await updater.run({ force: true })).toMatchObject({ state: 'error', code: 'asset-missing', detail: t.llamacpp.chooseAcceleration })
    }
    expect(await updater.run()).toMatchObject({ state: 'error', code: 'asset-missing' })
    expect(fetches).toBe(0)
    expect(secondaryRuntimeTarget(boot)).toBeNull()
  } finally { setLocale(locale); await updater.stop() }
})
