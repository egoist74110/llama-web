// Process-wide wiring: config stores, runner, scheduler and the /v1 proxy. Created once
// (kept on globalThis so dev-server reloads do not orphan running llama-server processes)
// and shared by the custom Bun entry, the Nitro plugin and the dev-mode routes.
import { join } from 'node:path'
import {
  defaultModels, defaultSettings, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION,
  type ModelsDoc, type Settings,
} from '../core/config'
import { authenticate, defaultSecrets, normalizeSecrets, SECRETS_MIGRATIONS, SECRETS_VERSION, type SecretsDoc } from '../core/keys'
import { LaunchConfigError, planLaunch } from '../core/launch'
import { LogStore } from '../core/logs'
import type { RuntimeStatus } from '../core/llamacpp'
import { GpuSampler, parseNvidiaSmi, runNvidiaSmi } from '../core/gpu'
import { describeModels, LiveHub } from '../core/live'
import { LoadProgress, trackWeightLoad } from '../core/load-progress'
import { ModelOps } from '../core/model-ops'
import { createProxy, type Proxy, type ProxyEvent } from '../core/proxy'
import { handlePublic, PublicListener } from '../core/public-entry'
import { runStartupCleanup } from '../core/residue'
import { PidRegistry, Runner } from '../core/runner'
import { Scheduler, type SchedulerEvent } from '../core/scheduler'
import { SpeedMeter } from '../core/speed'
import { isFirstRun } from '../core/settings-admin'
import { JsonStore, resolveDataDir, type VersionedDoc } from '../core/store'
import { TunnelManager, type TunnelInfo } from '../core/tunnel'
import { CloudflareSetup } from '../core/cloudflare'
import { Updater } from '../core/updater'
import { APP_REPO, APP_VERSION } from '../core/app-info'
import { AppUpdater } from '../core/app-update'
import { Hold } from '../core/write-pair'
import { cloudflareHooks } from './cloudflare-hooks'
import { acquireDataLock, type DataLock } from '../core/data-lock'
import { detectPlatform, runtimeTarget, type PlatformInfo, type RuntimeTarget } from '../core/platform'

export interface AppContext {
  dataDir: string
  platform: PlatformInfo
  runtimeTarget: RuntimeTarget
  /** Port configured when the process started (the listening port only changes on restart). */
  bootPort: number
  getSettings(): Settings
  getModels(): ModelsDoc
  /** Save through the store (backup + atomic write) and make the change visible to getters. */
  updateSettings(fn: (draft: Settings) => Settings | void): Settings
  updateModels(fn: (draft: ModelsDoc) => ModelsDoc | void): ModelsDoc
  /** data/secrets.json (API keys). Never send `key` values anywhere except the reveal / create responses. */
  getSecrets(): SecretsDoc
  updateSecrets(fn: (draft: SecretsDoc) => SecretsDoc | void): SecretsDoc
  /** Re-read both files now (hand edits the watcher has not reported yet). Throws StoreError if one is invalid. */
  refresh(): void
  /** State of the llama.cpp startup check / download. */
  getRuntimeStatus(): RuntimeStatus
  /** llama.cpp versions: list, switch (rollback), pruning. */
  updater: Updater
  /** Updates of llama-web itself (check / download / desktop install hand-off). */
  appUpdate: AppUpdater
  runner: Runner
  scheduler: Scheduler
  /** Management actions (start / stop / restart / switch); use these instead of the scheduler directly. */
  ops: ModelOps
  proxy: Proxy
  /** Public entry on 127.0.0.1 (settings.public); the custom Bun entry attaches the listener. */
  publicEntry: PublicListener
  /** Apply settings.public to the listener now (after attaching it, and on every settings change); also re-evaluates the tunnel. */
  applyPublic(): void
  /** Cloudflare tunnel hosted by llama-web (cloudflared with the saved token). */
  tunnel: TunnelManager
  /** Bring the tunnel in line with settings, listener state and the saved token. */
  applyTunnel(): void
  /** One-click tunnel setup through the Cloudflare API (the run in progress / last failed run). */
  cloudflare: CloudflareSetup
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
  const dataLock = acquireDataLock(dataDir)
  const startupClose: Array<() => void> = []
  try {
    return createOwnedContext(dataDir, dataLock, startupClose)
  } catch (e) {
    for (const close of startupClose.reverse()) close()
    dataLock.release()
    throw e
  }
}

function createOwnedContext(dataDir: string, dataLock: DataLock, startupClose: Array<() => void>): AppContext {
  const platform = detectPlatform()
  const newSettings = () => defaultSettings(platform)
  const settingsStore = new JsonStore<Settings>({
    dataDir, name: 'settings.json', version: SETTINGS_VERSION, defaults: newSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS,
  })
  startupClose.push(() => settingsStore.close())
  const modelsStore = new JsonStore<ModelsDoc>({
    dataDir, name: 'models.json', version: MODELS_VERSION, defaults: defaultModels, validate: normalizeModels,
  })
  startupClose.push(() => modelsStore.close())
  // `live` is created below; stores only call it after startup.
  const secretsStore = new JsonStore<SecretsDoc>({
    dataDir, name: 'secrets.json', version: SECRETS_VERSION, defaults: defaultSecrets, validate: normalizeSecrets, migrations: SECRETS_MIGRATIONS,
  })
  startupClose.push(() => secretsStore.close())
  const changed = () => live.notify()
  // Settings edits (page or by hand) also start / stop / move the public listener.
  // `hold` is raised while a pair of writes is in flight (see onSaved of the Cloudflare setup): nothing reacts to half of it, one reconciliation runs afterwards.
  const hold = new Hold()
  const settingsRef = openStore(settingsStore, newSettings, () => { changed(); if (!hold.held) applyPublic() })
  const modelsRef = openStore(modelsStore, defaultModels, changed)
  // An unreadable secrets.json falls back to "no keys": every public request is refused. A new tunnel token restarts the tunnel.
  const secretsRef = openStore(secretsStore, defaultSecrets, () => { if (!hold.held) applyTunnel() })
  const getSettings = settingsRef.get
  let selectedTarget: RuntimeTarget, selectionError: string | undefined
  try { selectedTarget = runtimeTarget(platform, getSettings().llamacpp.acceleration) }
  catch (e) {
    selectionError = (e as Error).message
    selectedTarget = { os: platform.os, arch: platform.arch, acceleration: 'cpu' }
  }
  const getModels = modelsRef.get
  const logs = new LogStore({ dir: join(dataDir, 'logs'), retention: () => getSettings().logs })
  startupClose.push(() => logs.closeAll())
  try { logs.prune() } catch (e) { logError('log retention failed', e) }

  const cleanupDone = runStartupCleanup(dataDir).then((r) => {
    if (r.killed.length || r.skipped.length) log(`residue cleanup: killed ${r.killed.length}, skipped ${r.skipped.length}`)
  }, e => logError('residue cleanup failed', e))

  // Getters so hand edits of settings.json apply to the next load / drain.
  const runner = new Runner({
    get portRange() { return getSettings().scheduler.portRange },
    registry: new PidRegistry(join(dataDir, 'run', 'pids.json')),
  })
  // Executables between planLaunch and runner.start: their version directory must not be pruned yet.
  const launching = new Map<number, string>()
  let launchSeq = 0
  const updater = new Updater({
    dataDir,
    target: selectedTarget, selectionError,
    llamacpp: () => getSettings().llamacpp,
    setCurrent: tag => settingsRef.update((s) => { s.llamacpp.current = tag }),
    usedExes: () => [...runner.list().map(p => p.spec.exe), ...launching.values()],
    onStatus: (s) => {
      live.onRuntimeStatus(s)
      if (s.state === 'working') log(`llama.cpp: ${s.step} ${s.detail}`.trim())
      else if (s.state === 'ready') log(`llama.cpp: using ${s.tag}${s.note === 'updated' ? ` (updated from ${s.from ?? 'none'})` : ''}${s.note === 'pinned' ? ` (latest ${s.latest} installed, kept the chosen version)` : ''}`)
      else if (s.state === 'error') logError(`llama.cpp update failed: ${s.code} ${s.detail}${s.using ? ` (still using ${s.using})` : ''}`)
      else if (s.state === 'disabled') log('llama.cpp: none installed and downloads are off (llamacpp.autoUpdate)')
    },
    onPrune: (r) => {
      if (r.removed.length) log(`llama.cpp: removed old versions ${r.removed.join(', ')}`)
      for (const f of r.failed) logError(`llama.cpp: could not remove ${f.tag}: ${f.detail}`)
      live.notify()
    },
  })
  // LLAMA_WEB_UPDATE_FEED: loopback release list for local acceptance tests only (checked by AppUpdater).
  const appUpdateOpts = { current: APP_VERSION, repo: APP_REPO, dataDir, onChange: () => live.notify() }
  let appUpdate: AppUpdater
  try { appUpdate = new AppUpdater({ ...appUpdateOpts, feed: process.env.LLAMA_WEB_UPDATE_FEED || undefined }) }
  catch (e) {
    logError('ignored LLAMA_WEB_UPDATE_FEED:', (e as Error).message)
    appUpdate = new AppUpdater(appUpdateOpts)
  }
  startupClose.push(() => appUpdate.stop())
  const speed = new SpeedMeter({ onChange: () => live.notifyMetrics() })
  // Samples nvidia-smi every settings.gpu.sampleSec seconds (2 by default), but only while a browser is connected to /api/stream.
  const gpu = new GpuSampler({ intervalMs: () => Math.max(500, getSettings().gpu.sampleSec * 1000), active: () => platform.os === 'win32' && live.subscriberCount > 0, onChange: () => live.notifyMetrics() })
  gpu.start()
  startupClose.push(() => gpu.stop())
  const live: LiveHub = new LiveHub({
    onActivity: e => logs.appendEvent(e),
    metrics: () => ({ speed: speed.snapshot(), gpu: gpu.value }),
    snapshot: () => ({
      platform,
      scheduler: scheduler.snapshot(),
      models: describeModels(getModels(), { dirs: getSettings().modelDirs }),
      queue: scheduler.snapshot().queue.map(q => ({ modelId: q.modelId, profile: q.profile, started: q.started, waiting: q.waiting })),
      llamacpp: { current: getSettings().llamacpp.current, runtime: updater.getStatus(), versions: updater.versions(), rollback: updater.rollbackTarget() },
      tunnel: tunnel.status(),
      appUpdate: appUpdate.view(),
      // Job and its version from one view: the page orders snapshots and HTTP responses by it.
      ...(({ job, rev }) => ({ cloudflare: job, cloudflareRev: rev }))(cloudflare.view()),
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
      const plan = planLaunch(target, { dataDir, settings: getSettings(), models: getModels(), host: runner.host, target: selectedTarget })
      for (const w of plan.warnings) log(`args ${plan.tag}: ${w.code} ${w.flag ?? ''} ${w.layer ?? ''}`.trim())
      log(`starting ${plan.tag}: ${plan.exe}`)
      const launchId = ++launchSeq
      launching.set(launchId, plan.exe)
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
        launching.delete(launchId) // runner.list() covers it from here on
        void rp.ready.then(stopTracking, stopTracking)
        void rp.exited.then((x) => {
          stopTracking()
          run.append(`# llama-web: exited code=${x.code ?? '-'} signal=${x.signal ?? '-'}${x.requested ? ' (stopped by llama-web)' : ''}`)
          run.close()
        })
        return rp
      } catch (e) {
        launching.delete(launchId)
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
  const publicEntry: PublicListener = new PublicListener((req, ip) => handlePublic(req, {
    authenticate: header => authenticate(secretsRef.get(), header),
    handleV1: (r, meta) => proxy.handleV1(r, meta),
  }, ip))
  startupClose.push(() => publicEntry.close())
  // The tunnel runs only while the public entry listens (the tunnel's target) and a token is saved.
  // Output is not logged (it is redacted and kept in memory for the error state); only transitions are.
  const tunnel = new TunnelManager({
    dataDir,
    registry: new PidRegistry(join(dataDir, 'run', 'pids.json')),
    ready: cleanupDone,
    onStatus: (info: TunnelInfo) => {
      live.onTunnelStatus(info)
      const s = info.status
      if (s.state === 'preparing' && s.step === 'download') log('tunnel: downloading cloudflared')
      else if (s.state === 'connected') log(`tunnel: connected (${s.connections} connection(s))`)
      else if (s.state === 'error') logError(`tunnel: ${s.code}${s.detail ? ` ${s.detail}` : ''}${s.retryAt ? ' (retrying)' : ''}`)
    },
  })
  function applyTunnel() {
    const s = getSettings().public
    tunnel.apply({
      tunnelEnabled: s.tunnelEnabled, mode: s.tunnelMode, protocol: s.tunnelProtocol, publicEnabled: s.enabled, publicState: publicEntry.status().state,
      token: secretsRef.get().tunnelToken, port: s.port,
    })
  }

  // Port guard and final save (secrets + settings as a pair): see cloudflare-hooks.ts.
  const cloudflare = new CloudflareSetup(cloudflareHooks({
    settingsRef, secretsRef, hold, applyPublic,
    onChange: (job) => {
      live.notify()
      if (job?.state === 'done') log(`cloudflare: set up ${job.hostname}`)
      else if (job?.state === 'failed') {
        const f = job.steps.find(s => s.state === 'failed')
        logError(`cloudflare: setup of ${job.hostname} failed at ${f?.id}: ${f?.error?.code}${f?.error?.detail ? ` ${f.error.detail}` : ''}`)
      }
    },
  }))

  /** Bring the public listener in line with settings.public and log what changed. */
  function applyPublic() {
    try { applyPublicListener() } finally { applyTunnel() }
  }
  function applyPublicListener() {
    const before = JSON.stringify(publicEntry.status())
    const st = publicEntry.apply(getSettings().public)
    if (JSON.stringify(st) === before) return
    if (st.state === 'listening') log(`public entry on http://${st.host}:${st.port} (/v1/* with API key only)`)
    else if (st.state === 'error') logError(`public entry could not listen on ${st.port}: ${st.detail}`)
    else if (st.state === 'off') log('public entry off')
  }

  // Background, once per start (plan 关键决定 15): adopt an installed llama.cpp, download a newer
  // release and make it current, prune old versions. Loads meanwhile use the current version.
  // After residue cleanup, so leftovers of the last run do not hold a version directory.
  void cleanupDone.then(() => updater.run())
  appUpdate.start()

  // Under `nuxt dev` nothing attaches the public listener; this still reports why the tunnel is off.
  applyTunnel()

  let closing: Promise<void> | null = null
  return {
    dataDir, bootPort: getSettings().server.port, getSettings, getModels, updateSettings: settingsRef.update, updateModels: modelsRef.update,
    platform, runtimeTarget: selectedTarget,
    getSecrets: secretsRef.get, updateSecrets: secretsRef.update, tunnel, applyTunnel, cloudflare,
    refresh: () => { settingsRef.refresh(); modelsRef.refresh() },
    getRuntimeStatus: () => updater.getStatus(), updater, appUpdate, runner, scheduler, ops, proxy, publicEntry, applyPublic, live, logs, cleanupDone,
    shutdown() {
      closing ??= (async () => {
        await cleanupDone
        publicEntry.close()
        await tunnel.shutdown()
        await updater.stop()
        appUpdate.stop()
        settingsStore.close()
        modelsStore.close()
        secretsStore.close()
        gpu.stop()
        await scheduler.shutdown()
        await runner.stopAll()
        logs.closeAll()
        dataLock.release()
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
