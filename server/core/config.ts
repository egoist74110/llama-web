// settings.json / models.json schemas, defaults and light normalisation (see plan「配置与数据」).
// Hand-edited files may omit sections; missing values are filled from the defaults.
import { DEFAULT_LAUNCH_DEFAULTS, type LaunchDefaults, type ParamOverrides } from './args'
import type { FileRef, ModelDir } from './types'
import type { Acceleration, PlatformInfo } from './platform'

export interface ImagePreprocess {
  enabled: boolean
  /** Longest edge after resizing, in pixels. */
  maxEdge: number
  format: 'jpeg' | 'png' | 'webp'
  quality: number
}

/** Step of the public access guide (4-6). */
export type WizardStep = 'port' | 'key' | 'path' | 'cf-token' | 'cf-zone' | 'cf-run' | 'guide' | 'paste' | 'connect'
export const WIZARD_STEPS: WizardStep[] = ['port', 'key', 'path', 'cf-token', 'cf-zone', 'cf-run', 'guide', 'paste', 'connect']

/**
 * Progress of the public access guide, saved on the server so it continues where it was left.
 * Only non-secret drafts: tokens are saved (and verified) by their own endpoints.
 */
export interface PublicWizard {
  step: WizardStep
  /** `setup` = first run (port, key, …); `add` = add another address to the running tunnel. */
  mode: 'setup' | 'add'
  /**
   * Branch: Cloudflare API token (one click), the dashboard guide + pasted tunnel token, or a
   * Cloudflare quick tunnel (no domain, no account; decision 31).
   */
  path: 'api' | 'manual' | 'quick' | null
  zoneId: string
  subdomain: string
  /** Host name the user entered in the manual branch. */
  domain: string
}

/**
 * How llama-web runs the tunnel (decision 31): `token` = the user's own tunnel (token in
 * secrets.json, their own domain); `quick` = Cloudflare quick tunnel with a random
 * *.trycloudflare.com address that changes on every start.
 */
export type TunnelMode = 'token' | 'quick'
export const TUNNEL_MODES: TunnelMode[] = ['token', 'quick']

/**
 * Transport between cloudflared and Cloudflare (`--protocol`). `http2` (TCP) is the default: it
 * gets through more networks (recommended in mainland China, where UDP / QUIC is often throttled);
 * `quic` is the alternative.
 */
export type TunnelProtocol = 'http2' | 'quic'
export const TUNNEL_PROTOCOLS: TunnelProtocol[] = ['http2', 'quic']

export interface Settings {
  version: number
  server: { host: string, port: number }
  public: { enabled: boolean, port: number, domain: string, tunnelEnabled: boolean, tunnelMode: TunnelMode, tunnelProtocol: TunnelProtocol, wizard: PublicWizard | null }
  modelDirs: ModelDir[]
  llamacpp: {
    /** Empty = automatic: the newest CUDA runtime the driver and GPU can run (decision 37); a version here is the user's override. */
    cudaRuntime: string
    /** Current version of the GPU channel (on a Mac: of its only channel). */
    current: string
    /** Current version of the Windows CPU channel (decision 36); empty until the CPU build is downloaded. */
    currentCpu: string
    keepVersions: number
    autoUpdate: boolean
    acceleration: Acceleration
  }
  scheduler: {
    maxLoaded: number
    loadTimeoutSec: number
    drainTimeoutSec: number
    heartbeatSec: number
    portRange: [number, number]
  }
  /** Launch defaults of the GPU build (and the only set on a Mac). */
  defaults: LaunchDefaults
  /** Launch defaults for a CPU build on Windows (decision 36); chosen by the runtime a launch ends up using. */
  defaultsCpu: LaunchDefaults
  preprocess: { image: ImagePreprocess }
  logs: { keepRunsPerModel: number, keepDays: number }
  gpu: { sampleSec: number }
  /** First-run wizard: `done` is set when it is finished or skipped. */
  setup: { done: boolean }
}

export interface Profile {
  overrides: ParamOverrides
  extraArgs: string
  /** File name inside data/templates/, or null for the model's built-in template. */
  chatTemplate?: string | null
  /** Per-profile preprocess overrides, e.g. `{ image: { maxEdge: 1280 } }`. */
  preprocess?: { image?: Partial<ImagePreprocess> }
  /** llama.cpp build: `cuda:b11146` / `cpu:b11146` / `metal:b11146` / `custom:<id>`; empty = follow the model, then the global version. */
  runtime?: string | null
}

export interface ModelConfig {
  id: string
  /** Name clients use in the `model` field. */
  name: string
  backend: string
  file: FileRef
  mmproj: FileRef | null
  draft: FileRef | null
  activeProfile: string
  profiles: Record<string, Profile>
  /**
   * False = enabled from a scan and the first-start questions (thinking / vision / MTP) have not
   * been answered yet. Missing = an existing or imported model: never asked.
   */
  confirmed?: boolean
  /** llama.cpp build for this model (see Profile.runtime); a profile's own choice wins. Empty = follow the global version. */
  runtime?: string | null
  /** Placeholder, not used yet. */
  reserved?: { pinned: boolean, idleUnloadMin: number }
}

export interface ModelsDoc {
  version: number
  models: ModelConfig[]
}

export const SETTINGS_VERSION = 6
export const MODELS_VERSION = 1

/**
 * Defaults for a CPU build: no layers on a GPU, no K/V quantisation or flash attention that
 * assume a GPU, no `--load-mode mlock` (it fails when the model does not fit in free memory), and
 * a smaller context (the KV cache lives in system memory).
 */
export const DEFAULT_CPU_DEFAULTS: LaunchDefaults = {
  ...DEFAULT_LAUNCH_DEFAULTS,
  ctxSize: 32768, cacheTypeK: null, cacheTypeV: null, flashAttn: null, gpuLayers: 0, batchSize: 512, ubatchSize: 512,
  extraArgs: '--jinja --no-prefill-assistant --props --slots -cb',
}

/** Hosts with a separate CPU channel and its own defaults: Windows only (a Mac has one channel and one set of defaults). */
export const hasCpuChannel = (host: { os: NodeJS.Platform }) => host.os === 'win32'

/** Current version setting of an official channel. */
export const currentTagFor = (s: Settings, host: { os: NodeJS.Platform }, accel: string): string =>
  hasCpuChannel(host) && accel === 'cpu' ? s.llamacpp.currentCpu : s.llamacpp.current

/** Launch defaults for a launch that ends up on a runtime of this type. */
export const defaultsFor = (s: Settings, host: { os: NodeJS.Platform }, accel: string): LaunchDefaults =>
  hasCpuChannel(host) && accel === 'cpu' ? s.defaultsCpu : s.defaults

export function defaultSettings(platform?: PlatformInfo): Settings {
  const windowsCuda = platform ? platform.os === 'win32' && platform.acceleration === 'cuda' : process.platform === 'win32'
  return {
    version: SETTINGS_VERSION,
    server: { host: '0.0.0.0', port: 5001 },
    public: { enabled: false, port: 8080, domain: '', tunnelEnabled: false, tunnelMode: 'token', tunnelProtocol: 'http2', wizard: null },
    modelDirs: [],
    llamacpp: { cudaRuntime: '', current: '', currentCpu: '', keepVersions: 2, autoUpdate: true, acceleration: 'auto' },
    scheduler: { maxLoaded: 1, loadTimeoutSec: 600, drainTimeoutSec: 300, heartbeatSec: 15, portRange: [7100, 7199] },
    defaults: windowsCuda ? { ...DEFAULT_LAUNCH_DEFAULTS } : {
      ...DEFAULT_LAUNCH_DEFAULTS, cacheTypeK: null, cacheTypeV: null, flashAttn: null,
      gpuLayers: platform?.acceleration === 'cpu' ? 0 : null, extraArgs: '--jinja --no-prefill-assistant --props --slots -cb',
    },
    defaultsCpu: { ...DEFAULT_CPU_DEFAULTS },
    preprocess: { image: { enabled: true, maxEdge: 896, format: 'jpeg', quality: 90 } },
    logs: { keepRunsPerModel: 20, keepDays: 14 },
    gpu: { sampleSec: 2 },
    setup: { done: false },
  }
}

/** `migrations[n]` turns a version-n settings.json into version n + 1. */
export const SETTINGS_MIGRATIONS: Record<number, (old: any) => any> = {
  // 2: the tunnel is hosted by llama-web (token in secrets.json); the tunnel name is gone.
  1: (old) => {
    if (isObj(old.public)) {
      delete old.public.tunnelName
      old.public.tunnelEnabled ??= false
    }
    return old
  },
  // 3: progress of the public access guide (none in progress).
  2: (old) => {
    if (isObj(old.public)) old.public.wizard ??= null
    return old
  },
  // Existing installations are Windows CUDA; never silently change their launch parameters.
  3: (old) => {
    if (isObj(old.llamacpp)) old.llamacpp.acceleration ??= 'cuda'
    else old.llamacpp = { acceleration: 'cuda' }
    return old
  },
  // 5: tunnel mode (decision 31): every existing installation keeps its own tunnel. Tunnel protocol:
  // HTTP/2, the recommended default (the user asked for it as the default, 2026-10-03).
  4: (old) => {
    if (isObj(old.public)) {
      old.public.tunnelMode ??= 'token'
      old.public.tunnelProtocol ??= 'http2'
    }
    return old
  },
  // 6: separate CPU defaults and CPU channel version (decision 36). Only missing values are added;
  // a CPU-only installation (acceleration cpu) keeps its version as the CPU channel's. The old
  // `cudaRuntime` (default or hand-edited) stays: it now acts as the override of the automatic choice.
  5: (old) => {
    if (!isObj(old.llamacpp)) old.llamacpp = {}
    old.llamacpp.currentCpu ??= old.llamacpp.acceleration === 'cpu' && typeof old.llamacpp.current === 'string' ? old.llamacpp.current : ''
    old.defaultsCpu ??= { ...DEFAULT_CPU_DEFAULTS }
    return old
  },
}

export function defaultModels(): ModelsDoc {
  return { version: MODELS_VERSION, models: [] }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Fill missing sections/keys from defaults (one level deep). Throws on a wrong shape. */
export function normalizeSettings(doc: Settings): Settings {
  if (!isObj(doc)) throw new Error('settings must be an object')
  const def = defaultSettings()
  const out: any = { ...def, ...doc }
  for (const k of Object.keys(def) as Array<keyof Settings>) {
    const d = def[k]
    if (isObj(d)) {
      if (doc[k] !== undefined && !isObj(doc[k])) throw new Error(`"${k}" must be an object`)
      out[k] = { ...d, ...(doc[k] as object | undefined) }
    }
  }
  out.preprocess.image = { ...def.preprocess.image, ...(isObj(doc.preprocess?.image) ? doc.preprocess.image : {}) }
  if (!Array.isArray(out.modelDirs)) throw new Error('"modelDirs" must be an array')
  const pr = out.scheduler.portRange
  if (!Array.isArray(pr) || pr.length !== 2 || !pr.every((p: unknown) => Number.isInteger(p)) || pr[0] > pr[1]) {
    throw new Error('"scheduler.portRange" must be [from, to]')
  }
  delete (out.public as Record<string, unknown>).tunnelName
  if (typeof out.public.tunnelEnabled !== 'boolean') out.public.tunnelEnabled = false
  // A hand-edited unknown mode falls back to the user's own tunnel (never silently to a public random address).
  if (!TUNNEL_MODES.includes(out.public.tunnelMode)) out.public.tunnelMode = 'token'
  if (!TUNNEL_PROTOCOLS.includes(out.public.tunnelProtocol)) out.public.tunnelProtocol = 'http2'
  out.public.wizard = cleanWizard(out.public.wizard)
  if (!['auto', 'cuda', 'cpu', 'metal'].includes(out.llamacpp.acceleration)) throw new Error('Invalid llamacpp.acceleration')
  // Placeholder (decision 9): the field exists but the online limit stays fixed at 1.
  out.scheduler.maxLoaded = 1
  return out as Settings
}

const WIZARD_TEXT_MAX = 253

/** A valid wizard progress or null (a hand-edited or broken value just restarts the guide). */
export function cleanWizard(raw: unknown): PublicWizard | null {
  if (!isObj(raw)) return null
  if (!WIZARD_STEPS.includes(raw.step)) return null
  if (raw.mode !== 'setup' && raw.mode !== 'add') return null
  const path = raw.path === 'api' || raw.path === 'manual' || raw.path === 'quick' ? raw.path : null
  const text = (v: unknown) => (typeof v === 'string' && v.length <= WIZARD_TEXT_MAX && !/[\u0000-\u001f]/.test(v) ? v.trim() : '')
  return { step: raw.step, mode: raw.mode, path, zoneId: text(raw.zoneId), subdomain: text(raw.subdomain).toLowerCase(), domain: text(raw.domain).toLowerCase() }
}

export function normalizeModels(doc: ModelsDoc): ModelsDoc {
  if (!isObj(doc) || !Array.isArray(doc.models)) throw new Error('"models" must be an array')
  for (const m of doc.models) {
    if (!isObj(m) || typeof m.id !== 'string' || !m.id) throw new Error('every model needs a string "id"')
    if (typeof m.name !== 'string' || !m.name) m.name = m.id
    if (!isObj(m.profiles)) throw new Error(`model "${m.id}" needs a "profiles" object`)
    m.mmproj ??= null
    m.draft ??= null
    m.backend ??= 'llama-server'
    // A runtime reference is a string or nothing (a wrong type is dropped; a stale value falls back at launch).
    if (typeof m.runtime !== 'string') delete m.runtime
    for (const p of Object.values(m.profiles)) if (isObj(p) && typeof p.runtime !== 'string') delete p.runtime
  }
  return doc
}
