// Process-wide wiring: config stores, runner, scheduler and the /v1 proxy. Created once
// (kept on globalThis so dev-server reloads do not orphan running llama-server processes)
// and shared by the custom Bun entry, the Nitro plugin and the dev-mode routes.
import { join } from 'node:path'
import {
  defaultModels, defaultSettings, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_VERSION,
  type ModelsDoc, type Settings,
} from '../core/config'
import { planLaunch } from '../core/launch'
import { ensureRuntime, type RuntimeStatus } from '../core/llamacpp'
import { createProxy, type Proxy, type ProxyEvent } from '../core/proxy'
import { runStartupCleanup } from '../core/residue'
import { PidRegistry, Runner } from '../core/runner'
import { Scheduler, type SchedulerEvent } from '../core/scheduler'
import { JsonStore, resolveDataDir, type VersionedDoc } from '../core/store'

export interface AppContext {
  dataDir: string
  getSettings(): Settings
  getModels(): ModelsDoc
  /** Save through the store (backup + atomic write) and make the change visible to getters. */
  updateSettings(fn: (draft: Settings) => Settings | void): Settings
  updateModels(fn: (draft: ModelsDoc) => ModelsDoc | void): ModelsDoc
  /** State of the initial llama.cpp download / version check. */
  getRuntimeStatus(): RuntimeStatus
  runner: Runner
  scheduler: Scheduler
  proxy: Proxy
  /** Resolves once startup residue cleanup has finished. */
  cleanupDone: Promise<void>
  shutdown(): Promise<void>
}

const log = (...a: unknown[]) => console.info('[llama-web]', ...a)
const logError = (...a: unknown[]) => console.error('[llama-web]', ...a)

/** A store whose last good value is kept when the file becomes unreadable. */
function openStore<T extends VersionedDoc>(store: JsonStore<T>, fallback: () => T) {
  let value: T
  try {
    value = store.load()
  } catch (e) {
    logError(`cannot load ${store.file}, using defaults until it is fixed:`, (e as Error).message)
    value = fallback()
  }
  store.watch((next) => {
    value = next
    log(`reloaded ${store.file}`)
  }, e => logError(`ignored invalid edit of ${store.file}:`, (e as Error).message))
  return {
    get: () => value,
    update(fn: (draft: T) => T | void): T {
      // Own writes are not reported by the file watcher, so refresh the cached value here.
      value = store.update(fn)
      return value
    },
  }
}

function describeTarget(t: { modelId: string, profile: string }) {
  return `${t.modelId}:${t.profile}`
}

function logSchedulerEvent(e: SchedulerEvent) {
  if (e.type === 'state') {
    const err = e.error ? ` (${(e.error as Error).message ?? e.error})` : ''
    log(`model ${describeTarget(e.target)}: ${e.from} -> ${e.to}${err}`)
  } else {
    log(`model ${describeTarget(e.target)}: drain timeout, ${e.inflight} request(s) interrupted`)
  }
}

function logProxyEvent(e: ProxyEvent) {
  if (e.type === 'preprocess') {
    for (const r of e.result.reports.image ?? []) {
      const b = r.before
      const a = r.after
      const size = (x?: { width: number, height: number, bytes: number, format: string }) =>
        x ? `${x.width}x${x.height} ${x.format} ${Math.round(x.bytes / 1024)}KB` : '?'
      log(`image ${describeTarget(e.target)} #${r.message}.${r.part}: ${r.action} ${size(b)}${a ? ` -> ${size(a)}` : ''}${r.detail ? ` (${r.detail})` : ''}`)
    }
  } else {
    logError(`upstream ${describeTarget(e.target)}:`, (e.error as Error)?.message ?? e.error)
  }
}

function createContext(): AppContext {
  const dataDir = resolveDataDir()
  const settingsStore = new JsonStore<Settings>({
    dataDir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings,
  })
  const modelsStore = new JsonStore<ModelsDoc>({
    dataDir, name: 'models.json', version: MODELS_VERSION, defaults: defaultModels, validate: normalizeModels,
  })
  const settingsRef = openStore(settingsStore, defaultSettings)
  const modelsRef = openStore(modelsStore, defaultModels)
  const getSettings = settingsRef.get
  const getModels = modelsRef.get

  const cleanupDone = runStartupCleanup(dataDir).then((r) => {
    if (r.killed.length || r.skipped.length) log(`residue cleanup: killed ${r.killed.length}, skipped ${r.skipped.length}`)
  }, e => logError('residue cleanup failed', e))

  // Getters so hand edits of settings.json apply to the next load / drain.
  const runner = new Runner({
    get portRange() { return getSettings().scheduler.portRange },
    registry: new PidRegistry(join(dataDir, 'run', 'pids.json')),
  })
  const scheduler = new Scheduler({
    maxLoaded: getSettings().scheduler.maxLoaded,
    get drainTimeoutMs() { return getSettings().scheduler.drainTimeoutSec * 1000 },
    onEvent: logSchedulerEvent,
    launch: async (target) => {
      await cleanupDone
      const plan = planLaunch(target, { dataDir, settings: getSettings(), models: getModels(), host: runner.host })
      for (const w of plan.warnings) log(`args ${plan.tag}: ${w.code} ${w.flag ?? ''} ${w.layer ?? ''}`.trim())
      log(`starting ${plan.tag}: ${plan.exe}`)
      return runner.start({ exe: plan.exe, args: plan.args, tag: plan.tag, loadTimeoutMs: plan.loadTimeoutMs })
    },
  })
  const proxy = createProxy({ scheduler, getModels, getSettings, onEvent: logProxyEvent })

  // Background: adopt an installed llama.cpp or download the first one. Never blocks startup.
  let runtimeStatus: RuntimeStatus = { state: 'idle' }
  void ensureRuntime({
    dataDir,
    cudaRuntime: getSettings().llamacpp.cudaRuntime,
    current: getSettings().llamacpp.current,
    allowDownload: getSettings().llamacpp.autoUpdate,
    setCurrent: tag => settingsRef.update((s) => { s.llamacpp.current = tag }),
    onStatus: (s) => {
      runtimeStatus = s
      if (s.state === 'working') log(`llama.cpp: ${s.step} ${s.detail}`.trim())
      else if (s.state === 'ready') log(`llama.cpp: using ${s.tag}`)
      else if (s.state === 'error') logError(`llama.cpp download failed: ${s.code} ${s.detail}`)
      else if (s.state === 'disabled') log('llama.cpp: none installed and downloads are off (llamacpp.autoUpdate)')
    },
  }).catch(e => logError('llama.cpp check failed', e))

  let closing: Promise<void> | null = null
  return {
    dataDir, getSettings, getModels, updateSettings: settingsRef.update, updateModels: modelsRef.update,
    getRuntimeStatus: () => runtimeStatus, runner, scheduler, proxy, cleanupDone,
    shutdown() {
      closing ??= (async () => {
        settingsStore.close()
        modelsStore.close()
        await scheduler.shutdown()
        await runner.stopAll()
      })()
      return closing
    },
  }
}

const KEY = Symbol.for('llama-web.context')

export function getContext(): AppContext {
  const g = globalThis as { [KEY]?: AppContext }
  return g[KEY] ??= createContext()
}
