// Process-wide wiring: config stores, runner, scheduler and the /v1 proxy. Created once
// (kept on globalThis so dev-server reloads do not orphan running llama-server processes)
// and shared by the custom Bun entry, the Nitro plugin and the dev-mode routes.
import { join } from 'node:path'
import {
  defaultModels, defaultSettings, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_VERSION,
  type ModelsDoc, type Settings,
} from '../core/config'
import { LaunchConfigError, planLaunch } from '../core/launch'
import { LogStore } from '../core/logs'
import { ensureRuntime, type RuntimeStatus } from '../core/llamacpp'
import { GpuSampler, parseNvidiaSmi, runNvidiaSmi } from '../core/gpu'
import { describeModels, LiveHub } from '../core/live'
import { LoadProgress, trackWeightLoad } from '../core/load-progress'
import { ModelOps } from '../core/model-ops'
import { createProxy, type Proxy, type ProxyEvent } from '../core/proxy'
import { runStartupCleanup } from '../core/residue'
import { PidRegistry, Runner } from '../core/runner'
import { Scheduler, type SchedulerEvent } from '../core/scheduler'
import { SpeedMeter } from '../core/speed'
import { isFirstRun } from '../core/settings-admin'
import { JsonStore, resolveDataDir, type VersionedDoc } from '../core/store'

export interface AppContext {
  dataDir: string
  /** Port configured when the process started (the listening port only changes on restart). */
  bootPort: number
  getSettings(): Settings
  getModels(): ModelsDoc
  /** Save through the store (backup + atomic write) and make the change visible to getters. */
  updateSettings(fn: (draft: Settings) => Settings | void): Settings
  updateModels(fn: (draft: ModelsDoc) => ModelsDoc | void): ModelsDoc
  /** Re-read both files now (hand edits the watcher has not reported yet). Throws StoreError if one is invalid. */
  refresh(): void
  /** State of the initial llama.cpp download / version check. */
  getRuntimeStatus(): RuntimeStatus
  runner: Runner
  scheduler: Scheduler
  /** Management actions (start / stop / restart / switch); use these instead of the scheduler directly. */
  ops: ModelOps
  proxy: Proxy
  /** Live state for /api/stream and /api/state. */
  live: LiveHub
  /** Log files under data/logs (model output, events, request records). */
  logs: LogStore
  /** Resolves once startup residue cleanup has finished. */
  cleanupDone: Promise<void>
  shutdown(): Promise<void>
}

const log = (...a: unknown[]) => console.info('[llama-web]', ...a)
const logError = (...a: unknown[]) => console.error('[llama-web]', ...a)

/** A store whose last good value is kept when the file becomes unreadable. Exported for tests. */
export function openStore<T extends VersionedDoc>(store: JsonStore<T>, fallback: () => T, onChange?: () => void) {
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
    onChange?.()
  }, e => logError(`ignored invalid edit of ${store.file}:`, (e as Error).message))
  return {
    get: () => value,
    refresh(): T {
      value = store.refresh()
      onChange?.()
      return value
    },
    update(fn: (draft: T) => T | void): T {
      // Own writes are not reported by the file watcher, so refresh the cached value here.
      value = store.update(fn)
      onChange?.()
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

const totalUsedMiB = async (): Promise<number | null> => {
  try {
    const gpus = parseNvidiaSmi(await runNvidiaSmi())
    return gpus.length ? gpus.reduce((n, g) => n + g.usedMiB, 0) : null
  } catch { return null }
}

function createContext(): AppContext {
  const dataDir = resolveDataDir()
  const settingsStore = new JsonStore<Settings>({
    dataDir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings,
  })
  const modelsStore = new JsonStore<ModelsDoc>({
    dataDir, name: 'models.json', version: MODELS_VERSION, defaults: defaultModels, validate: normalizeModels,
  })
  // `live` is created below; stores only call it after startup.
  const changed = () => live.notify()
  const settingsRef = openStore(settingsStore, defaultSettings, changed)
  const modelsRef = openStore(modelsStore, defaultModels, changed)
  const getSettings = settingsRef.get
  const getModels = modelsRef.get
  const logs = new LogStore({ dir: join(dataDir, 'logs'), retention: () => getSettings().logs })
  try { logs.prune() } catch (e) { logError('log retention failed', e) }

  const cleanupDone = runStartupCleanup(dataDir).then((r) => {
    if (r.killed.length || r.skipped.length) log(`residue cleanup: killed ${r.killed.length}, skipped ${r.skipped.length}`)
  }, e => logError('residue cleanup failed', e))

  // Getters so hand edits of settings.json apply to the next load / drain.
  const runner = new Runner({
    get portRange() { return getSettings().scheduler.portRange },
    registry: new PidRegistry(join(dataDir, 'run', 'pids.json')),
  })
  let runtimeStatus: RuntimeStatus = { state: 'idle' }
  const speed = new SpeedMeter({ onChange: () => live.notifyMetrics() })
  // Samples nvidia-smi every settings.gpu.sampleSec seconds (2 by default), but only while a browser is connected to /api/stream.
  const gpu = new GpuSampler({ intervalMs: () => Math.max(500, getSettings().gpu.sampleSec * 1000), active: () => live.subscriberCount > 0, onChange: () => live.notifyMetrics() })
  gpu.start()
  const live: LiveHub = new LiveHub({
    onActivity: e => logs.appendEvent(e),
    metrics: () => ({ speed: speed.snapshot(), gpu: gpu.value }),
    snapshot: () => ({
      scheduler: scheduler.snapshot(),
      models: describeModels(getModels(), { dirs: getSettings().modelDirs }),
      queue: scheduler.snapshot().queue.map(q => ({ modelId: q.modelId, profile: q.profile, started: q.started, waiting: q.waiting })),
      llamacpp: { current: getSettings().llamacpp.current, runtime: runtimeStatus },
      firstRun: isFirstRun(getSettings(), getModels()),
    }),
  })
  const scheduler: Scheduler = new Scheduler({
    maxLoaded: getSettings().scheduler.maxLoaded,
    get drainTimeoutMs() { return getSettings().scheduler.drainTimeoutSec * 1000 },
    onEvent: (e) => { logSchedulerEvent(e); live.onSchedulerEvent(e) },
    // Initial llama.cpp download still running (or not installed yet): not a model failure.
    isPrecondition: e => e instanceof LaunchConfigError && e.code === 'no-runtime',
    launch: async (target) => {
      await cleanupDone
      const plan = planLaunch(target, { dataDir, settings: getSettings(), models: getModels(), host: runner.host })
      for (const w of plan.warnings) log(`args ${plan.tag}: ${w.code} ${w.flag ?? ''} ${w.layer ?? ''}`.trim())
      log(`starting ${plan.tag}: ${plan.exe}`)
      const progress = new LoadProgress()
      const report = (p: number | null) => { if (p !== null) live.onLoadProgress(target.modelId, target.profile, p) }
      const stopTracking = trackWeightLoad({ files: plan.weightFiles, progress, report, usedMiB: totalUsedMiB })
      // One output file per start; lines also go to the live feed of the log page.
      const run = logs.startRun(target.modelId)
      run.append(`# llama-web: starting ${plan.tag} at ${new Date().toISOString()}`)
      try {
        const rp = await runner.start({
          exe: plan.exe, args: plan.args, tag: plan.tag, loadTimeoutMs: plan.loadTimeoutMs,
          onLine: (stream, line) => {
            run.append(line)
            live.onLogLine(target.modelId, target.profile, stream, line)
            report(progress.line(line))
          },
          onPartial: (_stream, partial) => report(progress.partial(partial)),
        })
        void rp.ready.then(stopTracking, stopTracking)
        void rp.exited.then((x) => {
          stopTracking()
          run.append(`# llama-web: exited code=${x.code ?? '-'} signal=${x.signal ?? '-'}${x.requested ? ' (stopped by llama-web)' : ''}`)
          run.close()
        })
        return rp
      } catch (e) {
        stopTracking()
        run.append(`# llama-web: could not start: ${(e as Error).message}`)
        run.close()
        throw e
      }
    },
  })
  const ops = new ModelOps(scheduler)
  const proxy = createProxy({
    scheduler, getModels, getSettings, onEvent: logProxyEvent,
    onRequest: (r) => { logs.appendRequest(r); live.onRequest(r) },
    speed,
    progressOf: t => live.progressOf(t.modelId, t.profile),
  })

  // Background: adopt an installed llama.cpp or download the first one. Never blocks startup.
  void ensureRuntime({
    dataDir,
    cudaRuntime: getSettings().llamacpp.cudaRuntime,
    current: getSettings().llamacpp.current,
    allowDownload: getSettings().llamacpp.autoUpdate,
    setCurrent: tag => settingsRef.update((s) => { s.llamacpp.current = tag }),
    onStatus: (s) => {
      runtimeStatus = s
      live.onRuntimeStatus(s)
      if (s.state === 'working') log(`llama.cpp: ${s.step} ${s.detail}`.trim())
      else if (s.state === 'ready') log(`llama.cpp: using ${s.tag}`)
      else if (s.state === 'error') logError(`llama.cpp download failed: ${s.code} ${s.detail}`)
      else if (s.state === 'disabled') log('llama.cpp: none installed and downloads are off (llamacpp.autoUpdate)')
    },
  }).catch(e => logError('llama.cpp check failed', e))

  let closing: Promise<void> | null = null
  return {
    dataDir, bootPort: getSettings().server.port, getSettings, getModels, updateSettings: settingsRef.update, updateModels: modelsRef.update,
    refresh: () => { settingsRef.refresh(); modelsRef.refresh() },
    getRuntimeStatus: () => runtimeStatus, runner, scheduler, ops, proxy, live, logs, cleanupDone,
    shutdown() {
      closing ??= (async () => {
        settingsStore.close()
        modelsStore.close()
        gpu.stop()
        await scheduler.shutdown()
        await runner.stopAll()
        logs.closeAll()
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
