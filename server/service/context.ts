// Process-wide wiring: config stores, runner, scheduler and the /v1 proxy. Created once
// (kept on globalThis so dev-server reloads do not orphan running llama-server processes)
// and shared by the custom Bun entry, the Nitro plugin and the dev-mode routes.
import { join } from 'node:path'
import {
  currentTagFor, defaultModels, defaultSettings, effectiveMaxLoaded, tunedDefaults, hasCpuChannel, hasDeviceSelection, MODELS_VERSION, normalizeModels, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION,
  type ModelsDoc, type Settings,
} from '../core/config'
import { authenticate, defaultSecrets, normalizeSecrets, SECRETS_MIGRATIONS, SECRETS_VERSION, type SecretsDoc } from '../core/keys'
import { describeDevices, DeviceProbe, type DeviceList, type DevicesView, type GpuDevice } from '../core/devices'
import { sampleSystemMemory } from '../core/memory-sample'
import type { SystemMemory } from '../core/memory-estimate'
import { chooseExe, LaunchConfigError, llamaServerExe, planLaunch, runtimeKeyOf, type DeviceInfo } from '../core/launch'
import { comboKey } from '../core/gpu-group'
import { blamesSplitMode, SplitModeLoadError, SplitStats } from '../core/split-stats'
import { diagnose } from '../core/errors'
import { LogStore } from '../core/logs'
import { UsageStore } from '../core/usage'
import type { RuntimeStatus } from '../core/llamacpp'
import { GpuSampler, parseNvidiaSmi, runNvidiaSmi } from '../core/gpu'
import { describeModels, LiveHub } from '../core/live'
import { detectLanAddress, getLanAddress } from '../core/network'
import { LoadProgress, trackWeightLoad } from '../core/load-progress'
import { ModelOps } from '../core/model-ops'
import { createProxy, type Proxy, type ProxyEvent } from '../core/proxy'
import { handlePublic, PublicListener } from '../core/public-entry'
import { runStartupCleanup } from '../core/residue'
import { LoadError, PidRegistry, Runner } from '../core/runner'
import { Scheduler, type SchedulerEvent } from '../core/scheduler'
import { dropMlockArgs, type AdmissionData } from '../core/admission'
import { loadDelta, VramStats } from '../core/vram-stats'
import { Watchdog } from '../core/watchdog'
import { admitTarget, samplePools, usedOf } from './admission'
import { SpeedMeter } from '../core/speed'
import { isFirstRun } from '../core/settings-admin'
import { JsonStore, resolveDataDir, type VersionedDoc } from '../core/store'
import { TunnelManager, type TunnelInfo } from '../core/tunnel'
import { CloudflareSetup } from '../core/cloudflare'
import { Updater } from '../core/updater'
import { RuntimeInstaller } from '../core/runtime-add'
import { RuntimeManager } from '../core/runtime-manager'
import { channelsFor, resolveRuntimeRef, RuntimeRegistry, type RuntimeAccel } from '../core/runtimes'
import { cudaLimitsFor, detectSystem, runCmd, systemWarnings, type SystemInfo } from '../core/system'
import { APP_REPO, APP_VERSION } from '../core/app-info'
import { AppUpdater } from '../core/app-update'
import { Hold } from '../core/write-pair'
import { cloudflareHooks } from './cloudflare-hooks'
import { acquireDataLock, type DataLock } from '../core/data-lock'
import { detectPlatform, runtimeTarget, type PlatformInfo, type RuntimeTarget } from '../core/platform'

export interface MemoryProbe {
  list: DeviceList | null
  fallbackGpus: GpuDevice[]
  system: SystemMemory
}

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
  /**
   * The other official channel of a Windows host (CPU next to CUDA, or the reverse): updated only
   * after the user downloaded it once. Null on a Mac (one channel only) and while there is none.
   */
  secondary: { accel: RuntimeAccel, updater: Updater, current(): string } | null
  /** Download the secondary channel (the user's first download; later updates follow automatically). */
  downloadSecondary(): Promise<void>
  /** Detected facts about this machine, with recommendations and warnings (cached for a minute; `refresh` re-detects). */
  getSystem(opts?: { refresh?: boolean }): Promise<SystemInfo>
  /** Devices of one llama.cpp build (`runtime` = a reference, empty = the global version); `{ applicable: false }` on a Mac. */
  getDevices(opts?: { runtime?: string | null, refresh?: boolean }): Promise<DevicesView | { applicable: false }>
  /** Device list and split modes of one build for the command preview; null on a Mac or when the build cannot be run. */
  getDeviceInfo(runtime?: string | null): Promise<DeviceInfo | null>
  /**
   * What the memory check reads from the machine: the device list of one build (`runtime` = a reference, empty = the global
   * version; null when it cannot be run), the NVIDIA cards as a fallback for it, and the system memory.
   */
  getMemoryProbe(runtime?: string | null, opts?: { refresh?: boolean }): Promise<MemoryProbe>
  /** Memory in use per pool around a load (replaceable in tests). */
  measure: { used(ids: readonly string[]): Promise<Array<number | null>> }
  /** Row / tensor combinations the user confirmed or that failed to load (decision 45). */
  splitStats: SplitStats
  /** Record key of a group on the build `runtime` resolves to (empty = the global version); null when no build can be resolved. */
  splitKey(runtime: string | null | undefined, devices: readonly string[], mode: string): string | null
  /** Hand-added llama.cpp builds: list, delete (with protection), and the add flow (preview, then confirm). */
  runtimes: RuntimeManager
  runtimeAdd: RuntimeInstaller
  /** Updates of llama-web itself (check / download / desktop install hand-off). */
  appUpdate: AppUpdater
  runner: Runner
  scheduler: Scheduler
  /** Memory the loads really took (data/vram-stats.json); estimates prefer it (decision 43). */
  vramStats: VramStats
  /** Stops models when memory runs short, while several may be online (decision 44). */
  watchdog: Watchdog
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
  /** Usage aggregates under data/logs/usage (decision 40). */
  usage: UsageStore
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
  } else if (e.type === 'drain-timeout') {
    log(`model ${describeTarget(e.target)}: drain timeout, ${e.inflight} request(s) interrupted`)
  } else if (e.type === 'no-room') {
    const d = e.detail
    log(`model ${describeTarget(e.target)}: not loaded (${e.manual ? 'manual start' : 'request'}), ${d.reason}${d.estimateMiB !== null ? `, needs ~${Math.round(d.estimateMiB)} MiB` : ''}${d.availableMiB !== null ? `, ${Math.round(d.availableMiB)} MiB available` : ''}`)
  } else {
    log(`model ${describeTarget(e.target)}: unloading ${describeTarget(e.victim)} to make room (${e.detail.reason})`)
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
  const usage = new UsageStore({ dir: join(dataDir, 'logs', 'usage'), keepDays: () => getSettings().logs.usageKeepDays })
  startupClose.push(() => usage.close())
  try { usage.prune() } catch (e) { logError('usage retention failed', e) }
  usage.start()

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
  const registry = new RuntimeRegistry(dataDir)
  startupClose.push(() => registry.close())
  if (registry.unavailable) logError('runtimes.json is unavailable, hand-added llama.cpp builds are off:', registry.unavailable)
  if (registry.recovered) log(`runtimes.json was unreadable (kept as ${registry.recovered.movedTo})${registry.recovered.fromBackup ? `; restored ${registry.recovered.fromBackup}` : '; starting with no hand-added builds'}`)
  const runtimes: RuntimeManager = new RuntimeManager({
    dataDir, target: selectedTarget, registry,
    getSettings, getModels,
    usedExes: () => [...runner.list().map(p => p.spec.exe), ...launching.values()],
    setCurrent: (tag, accel) => setCurrentTag(tag, accel),
    updateModels: fn => { modelsRef.update(fn) },
    onChanged: () => { updater.refresh(); secondary?.updater.refresh(); live.notify() },
  })
  const runtimeAdd = new RuntimeInstaller({ dataDir, target: selectedTarget, registry })
  runtimeAdd.clearLeftovers()
  startupClose.push(() => runtimeAdd.dispose())
  const setCurrentTag = (tag: string, accel: RuntimeAccel) => settingsRef.update((s) => {
    if (hasCpuChannel(platform) && accel === 'cpu') s.llamacpp.currentCpu = tag
    else s.llamacpp.current = tag
  })
  // Hardware facts for the automatic CUDA runtime choice and /api/system: detected once at start (the
  // update check waits for it), then at most once a minute.
  let systemCache: { at: number, info: Omit<SystemInfo, 'warnings'> } | null = null
  let systemRun: Promise<Omit<SystemInfo, 'warnings'>> | null = null
  const detect = (refresh = false): Promise<Omit<SystemInfo, 'warnings'>> => {
    if (!refresh && systemCache && Date.now() - systemCache.at < 60_000) return Promise.resolve(systemCache.info)
    systemRun ??= detectSystem().then((info) => { systemCache = { at: Date.now(), info }; return info }).finally(() => { systemRun = null })
    return systemRun
  }
  const deviceProbe = new DeviceProbe(runCmd)
  const splitStats = new SplitStats(dataDir)
  const channelUpdater = (target: RuntimeTarget, withSelectionError: boolean) => new Updater({
    dataDir,
    customMirror: () => getSettings().mirror.custom,
    target, selectionError: withSelectionError ? selectionError : undefined,
    llamacpp: () => ({ ...getSettings().llamacpp, current: currentTagFor(getSettings(), platform, target.acceleration) }),
    cudaLimits: () => (systemCache ? cudaLimitsFor(systemCache.info) : null),
    protect: () => runtimes.protectedTags(target.acceleration),
    setCurrent: tag => setCurrentTag(tag, target.acceleration),
    usedExes: () => [...runner.list().map(p => p.spec.exe), ...launching.values()],
    onStatus: (s) => {
      if (withSelectionError || target.acceleration === selectedTarget.acceleration) live.onRuntimeStatus(s)
      else live.notify()
      const ch = target.acceleration === selectedTarget.acceleration ? '' : ` (${target.acceleration} channel)`
      if (s.state === 'working') log(`llama.cpp${ch}: ${s.step} ${s.detail}`.trim())
      else if (s.state === 'ready') log(`llama.cpp${ch}: using ${s.tag}${s.note === 'updated' ? ` (updated from ${s.from ?? 'none'})` : ''}${s.note === 'pinned' ? ` (latest ${s.latest} installed, kept the chosen version)` : ''}`)
      else if (s.state === 'error') logError(`llama.cpp${ch} update failed: ${s.code} ${s.detail}${s.using ? ` (still using ${s.using})` : ''}`)
      else if (s.state === 'disabled') log(`llama.cpp${ch}: none installed and downloads are off (llamacpp.autoUpdate)`)
    },
    onPrune: (r) => {
      if (r.removed.length) log(`llama.cpp: removed old versions ${r.removed.join(', ')}`)
      for (const f of r.failed) logError(`llama.cpp: could not remove ${f.tag}: ${f.detail}`)
      live.notify()
    },
  })
  const updater = channelUpdater(selectedTarget, true)
  const otherAccel = channelsFor(selectedTarget).find(a => a !== selectedTarget.acceleration)
  const secondaryTarget: RuntimeTarget | null = hasCpuChannel(platform) && !selectionError && otherAccel ? { ...selectedTarget, acceleration: otherAccel } : null
  const secondary = secondaryTarget
    ? { accel: secondaryTarget.acceleration as RuntimeAccel, updater: channelUpdater(secondaryTarget, false), current: () => currentTagFor(getSettings(), platform, secondaryTarget.acceleration) }
    : null
  // LLAMA_WEB_UPDATE_FEED: loopback release list for local acceptance tests only (checked by AppUpdater).
  const appUpdateOpts = { current: APP_VERSION, repo: APP_REPO, dataDir, customMirror: () => getSettings().mirror.custom, onChange: () => live.notify() }
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
  const networkProbe = new AbortController()
  startupClose.push(() => networkProbe.abort())
  let preferredLanHost: string | null = null
  const live: LiveHub = new LiveHub({
    onActivity: e => logs.appendEvent(e),
    metrics: () => ({ speed: speed.snapshot(), gpu: gpu.value }),
    snapshot: () => ({
      platform,
      network: { lanHost: getLanAddress(preferredLanHost) },
      scheduler: scheduler.snapshot(),
      models: describeModels(getModels(), { dirs: getSettings().modelDirs }),
      queue: scheduler.snapshot().queue.map(q => ({ modelId: q.modelId, profile: q.profile, started: q.started, waiting: q.waiting })),
      llamacpp: {
        current: currentTagFor(getSettings(), platform, selectedTarget.acceleration), runtime: updater.getStatus(), check: updater.getUpdateCheck(), versions: updater.versions(), rollback: updater.rollbackTarget(),
        secondary: secondary ? { accel: secondary.accel, current: secondary.current(), runtime: secondary.updater.getStatus(), check: secondary.updater.getUpdateCheck() } : null,
      },
      tunnel: tunnel.status(),
      appUpdate: appUpdate.view(),
      // Job and its version from one view: the page orders snapshots and HTTP responses by it.
      ...(({ job, rev }) => ({ cloudflare: job, cloudflareRev: rev }))(cloudflare.view()),
      firstRun: isFirstRun(getSettings(), getModels()),
    }),
  })
  void detectLanAddress({ signal: networkProbe.signal }).then(host => {
    preferredLanHost = host
    if (!networkProbe.signal.aborted) live.notify()
  })
  const vramStats = new VramStats(dataDir)
  // Counts every change of which models hold memory (a load starting, a model draining, stopping or crashing). A
  // load measured while this did not move had the machine to itself (decision 43).
  let memoryEvents = 0
  const measure = { used: (ids: readonly string[]) => usedOf(ids, platform.os) }
  const MEASURE_TIMEOUT_MS = 5000
  const scheduler: Scheduler = new Scheduler({
    // Read at every load: the switch and the limit apply to the next one without a restart.
    get maxLoaded() { return effectiveMaxLoaded(getSettings()) },
    get multiLoad() { return getSettings().scheduler.multiLoad },
    get onNoRoom() { return getSettings().scheduler.onNoRoom },
    admit: admitTarget,
    get drainTimeoutMs() { return getSettings().scheduler.drainTimeoutSec * 1000 },
    onEvent: (e) => {
      if (e.type === 'state' && e.to !== 'ready') memoryEvents++
      logSchedulerEvent(e); live.onSchedulerEvent(e)
    },
    // Initial llama.cpp download still running (or not installed yet): not a model failure.
    isPrecondition: e => e instanceof LaunchConfigError && e.code === 'no-runtime',
    launch: async (target, admission) => {
      await cleanupDone
      const admitted = admission?.data as AdmissionData | undefined
      let plan = planLaunch(target, { dataDir, settings: getSettings(), models: getModels(), host: runner.host, target: selectedTarget, runtimeEnv: runtimes.env() })
      // Protect the build from deletion from here on (before the first await) until it runs or the start fails.
      const launchId = ++launchSeq
      launching.set(launchId, plan.exe)
      try {
        // The chosen devices must be on the list of the build that runs, and a split mode must be one it lists; there is no
        // silent switch to another device or mode (decisions 39, 45). With nothing chosen and several GPUs the one with the
        // most memory is picked. A build whose answer cannot be read blocks nothing (the process reports a bad device itself).
        if (hasDeviceSelection(platform) && plan.device !== 'cpu') {
          const devices = await deviceProbe.list(plan.exe)
          const splitModes = plan.group ? await deviceProbe.splitModes(plan.exe) : null
          plan = plan.resolve({ devices, splitModes }, plan.combo ? splitStats.get(plan.combo) : undefined)
          if (plan.autoPicked) log(`device ${plan.tag}: automatic choice is ${plan.autoPicked} (the GPU with the most memory)`)
        }
        if (plan.runtime.fallback) {
          const f = plan.runtime.fallback
          log(`runtime ${plan.tag}: ${f.from} is ${f.reason}, using ${f.to}`)
          live.onRuntimeFallback(target.modelId, target.profile, f.from, f.to, f.reason)
        }
        for (const w of plan.warnings) log(`args ${plan.tag}: ${w.code} ${w.flag ?? ''} ${w.layer ?? ''}`.trim())
        log(`starting ${plan.tag}: ${plan.exe}`)
        // Memory before the process exists, to measure what this load really takes (serial loads: nothing else is loading).
        const usedBefore = admitted?.statsKey ? await measure.used(admitted.sampleIds) : null
        const eventsBefore = memoryEvents
        let launchArgs = plan.args
        if (admitted?.dropMlock) {
          const base = plan.args
          launchArgs = port => dropMlockArgs(base(port)).args
          log(`starting ${plan.tag}: mlock would lock more than the free memory, loading without it`)
        }
        const progress = new LoadProgress()
        const report = (p: number | null) => { if (p !== null) live.onLoadProgress(target.modelId, target.profile, p) }
        const stopTracking = trackWeightLoad({ files: plan.weightFiles, progress, report, usedMiB: totalUsedMiB })
        // One output file per start; lines also go to the live feed of the log page.
        const run = logs.startRun(target.modelId)
        run.append(`# llama-web: starting ${plan.tag} at ${new Date().toISOString()}`)
        if (admitted?.dropMlock) run.append('# llama-web: mlock removed from the arguments (more than the free memory would be locked)')
        try {
          const rp = await runner.start({
            exe: plan.exe, args: launchArgs, tag: plan.tag, loadTimeoutMs: plan.loadTimeoutMs,
            onLine: (stream, line) => {
              run.append(line)
              live.onLogLine(target.modelId, target.profile, stream, line)
              report(progress.line(line))
            },
            onPartial: (_stream, partial) => report(progress.partial(partial)),
          })
          launching.delete(launchId) // runner.list() covers it from here on
          const combo = plan.combo
          // The measurement belongs to the load: `ready` settles for the scheduler only after it, so the next load
          // (which would add its own memory to the reading) cannot start before it is taken. A failing or slow
          // measurement never fails the load.
          let exitedInfo: { code: number | null } | null = null
          const exitedFirst = rp.exited.then((x) => { exitedInfo = x; return null })
          const gated = rp.ready.then(async () => {
            stopTracking()
            if (combo) splitStats.succeed(combo)
            if (admitted?.statsKey && usedBefore) {
              try {
                // A process that exits while it is being measured ends the wait at once.
                const after = await Promise.race([measure.used(admitted.sampleIds), exitedFirst, new Promise<null>(r => setTimeout(r, MEASURE_TIMEOUT_MS, null))])
                if (after && !exitedInfo) {
                  // What the load added per pool. Another model starting to stop or crash meanwhile frees memory and would make the
                  // difference too small, so then the sample is refused as not exclusive.
                  const measured = loadDelta(usedBefore, after)
                  const res = vramStats.record(admitted.statsKey, { estimateMiB: admitted.estimateMiB, measuredMiB: measured, exclusive: memoryEvents === eventsBefore })
                  if (res.significant && res.deviation !== null) {
                    log(`memory ${plan.tag}: the load took ${Math.round(res.deviation * 100)}% ${res.deviation > 0 ? 'more' : 'less'} than estimated, the next estimate uses the measurement`)
                    live.onGuard({ kind: 'vram-deviation', modelId: target.modelId, profile: target.profile, deviation: res.deviation })
                  }
                }
              } catch { /* statistics only */ }
            }
            // Healthy once, gone before the load was handed over: that is a failed load, whatever the measurement did.
            if (exitedInfo) throw new LoadError('exited', `Exited with code ${(exitedInfo as { code: number | null }).code ?? '-'} right after it became ready`, (exitedInfo as { code: number | null }).code ?? null, rp.tail())
          }, (e) => { stopTracking(); throw e })
          gated.catch(() => {})
          void rp.exited.then((x) => {
            stopTracking()
            run.append(`# llama-web: exited code=${x.code ?? '-'} signal=${x.signal ?? '-'}${x.requested ? ' (stopped by llama-web)' : ''}`)
            run.close()
          })
          return { port: rp.port, ready: gated, exited: rp.exited, stop: () => rp.stop(), tail: n => rp.tail(n) }
        } catch (e) {
          launching.delete(launchId)
          stopTracking()
          run.append(`# llama-web: could not start: ${(e as Error).message}`)
          run.close()
          // A row / tensor group that died while loading, for no reason that points at memory, files or arguments, is
          // remembered and named as the cause (decision 45); a plain layer split is not experimental and stays out of it.
          const mode = plan.group?.splitMode
          const kind = mode && plan.combo && mode !== 'layer' ? diagnose(e)?.kind : undefined
          if (kind && blamesSplitMode(kind)) {
            try { splitStats.fail(plan.combo!, kind) } catch (err) { logError('split-modes.json could not be written:', (err as Error).message) }
            log(`split mode ${plan.tag}: ${mode} on ${plan.group!.devices.join(',')} failed to load (${kind}); remembered, there is no automatic change`)
            throw new SplitModeLoadError(e, mode!)
          }
          throw e
        }
      } finally {
        launching.delete(launchId)
      }
    },
  })
  const ops = new ModelOps(scheduler)
  // Reads free memory every two seconds, but only has work while several models may be online and one is loading or ready.
  const watchdog = new Watchdog({
    sample: () => samplePools(platform.os),
    candidates: () => scheduler.candidates(),
    unload: (t, cause, opts) => scheduler.unload(t, cause, opts),
    enabled: () => getSettings().scheduler.multiLoad,
    onEvent: (e) => {
      log(e.state === 'stopped'
        ? `watchdog: ${e.pool} has ${Math.round(e.freePercent)}% free, stopped ${e.modelId}:${e.profile}`
        : `watchdog: ${e.pool} has ${Math.round(e.freePercent)}% free, every model has requests running, nothing stopped`)
      live.onGuard(e)
    },
  })
  watchdog.start()
  startupClose.push(() => watchdog.stop())
  const proxy = createProxy({
    scheduler, getModels, getSettings, onEvent: logProxyEvent,
    onRequest: (r) => { logs.appendRequest(r); usage.record(r); live.onRequest(r) },
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
  void cleanupDone.then(() => detect()).then((info) => {
    // First run only (decision 54): size the launch defaults to this machine, once.
    if (!getSettings().setup.tuned) {
      const tuned = tunedDefaults(info)
      settingsRef.update((s) => {
        Object.assign(s.defaults, tuned.defaults)
        Object.assign(s.defaultsCpu, tuned.defaultsCpu)
        s.setup.tuned = true
      })
    }
    void updater.run()
    // The other channel only follows releases once the user has downloaded it.
    if (secondary && secondary.updater.refresh().length) void secondary.updater.run()
  })
  appUpdate.start()

  // Under `nuxt dev` nothing attaches the public listener; this still reports why the tunnel is off.
  applyTunnel()

  /** Executable of a build reference (empty = the global version); null when it cannot be resolved. */
  const exeOf = (ref: string | null): string | null => {
    try {
      return ref ? resolveRuntimeRef(ref, runtimes.env()).exe : llamaServerExe(dataDir, getSettings(), platform.os, selectedTarget)
    } catch {
      return null
    }
  }

  let closing: Promise<void> | null = null
  return {
    dataDir, bootPort: getSettings().server.port, getSettings, getModels, updateSettings: settingsRef.update, updateModels: modelsRef.update,
    platform, runtimeTarget: selectedTarget,
    getSecrets: secretsRef.get, updateSecrets: secretsRef.update, tunnel, applyTunnel, cloudflare,
    refresh: () => { settingsRef.refresh(); modelsRef.refresh() },
    getRuntimeStatus: () => updater.getStatus(), updater, secondary,
    async downloadSecondary() {
      if (!secondary) throw new Error('No second channel on this computer')
      await detect()
      await secondary.updater.run({ force: true })
    },
    async getSystem(opts) {
      const info = await detect(opts?.refresh === true)
      return { ...info, warnings: systemWarnings(info, { cudaRuntime: getSettings().llamacpp.cudaRuntime }) }
    },
    async getDevices(opts) {
      if (!hasDeviceSelection(platform)) return { applicable: false }
      const ref = opts?.runtime?.trim() || null
      const exe = exeOf(ref)
      const refresh = opts?.refresh === true
      const [list, splitModes] = exe ? await Promise.all([deviceProbe.list(exe, { refresh }), deviceProbe.splitModes(exe)]) : [{ source: 'unavailable' as const, gpus: [] }, null]
      const info = await detect(refresh)
      return describeDevices(ref, list, info.cpu, info.nvidia?.gpus ?? [], splitModes)
    },
    async getDeviceInfo(runtime) {
      if (!hasDeviceSelection(platform)) return null
      const exe = exeOf(runtime?.trim() || null)
      if (!exe) return null
      const [devices, splitModes] = await Promise.all([deviceProbe.list(exe), deviceProbe.splitModes(exe)])
      return { devices, splitModes }
    },
    measure,
    async getMemoryProbe(runtime, opts) {
      const exe = exeOf(runtime?.trim() || null)
      const list = exe ? await deviceProbe.list(exe, { refresh: opts?.refresh === true }) : null
      let fallbackGpus: GpuDevice[] = []
      if (platform.os !== 'darwin' && list?.source !== 'list-devices') {
        try {
          fallbackGpus = parseNvidiaSmi(await runNvidiaSmi()).map(g => ({ id: `CUDA${g.index}`, name: g.name, totalMiB: g.totalMiB, freeMiB: g.totalMiB - g.usedMiB }))
        } catch { /* no nvidia-smi: the card stays unknown */ }
      }
      const s = await sampleSystemMemory()
      return { list, fallbackGpus, system: { totalMiB: s.totalMiB, availableMiB: s.availableMiB } }
    },
    splitStats,
    splitKey(runtime, devices, mode) {
      try {
        const { runtime: use } = chooseExe(runtime?.trim() ?? '', { dataDir, settings: getSettings(), platform: platform.os, target: selectedTarget, runtimeEnv: runtimes.env() })
        return comboKey(runtimeKeyOf(use), devices, mode)
      } catch {
        return null
      }
    },
    runtimes, runtimeAdd, appUpdate, runner, scheduler, vramStats, watchdog, ops, proxy, publicEntry, applyPublic, live, logs, usage, cleanupDone,
    shutdown() {
      closing ??= (async () => {
        networkProbe.abort()
        await cleanupDone
        publicEntry.close()
        await tunnel.shutdown()
        await updater.stop()
        await secondary?.updater.stop()
        runtimeAdd.dispose()
        registry.close()
        appUpdate.stop()
        settingsStore.close()
        modelsStore.close()
        secretsStore.close()
        gpu.stop()
        watchdog.stop()
        await scheduler.shutdown()
        await runner.stopAll()
        usage.close()
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
