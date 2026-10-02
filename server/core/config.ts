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
  /** Branch: Cloudflare API token (one click) or the dashboard guide + pasted tunnel token. */
  path: 'api' | 'manual' | null
  zoneId: string
  subdomain: string
  /** Host name the user entered in the manual branch. */
  domain: string
}

export interface Settings {
  version: number
  server: { host: string, port: number }
  public: { enabled: boolean, port: number, domain: string, tunnelEnabled: boolean, wizard: PublicWizard | null }
  modelDirs: ModelDir[]
  llamacpp: { cudaRuntime: string, current: string, keepVersions: number, autoUpdate: boolean, acceleration: Acceleration }
  scheduler: {
    maxLoaded: number
    loadTimeoutSec: number
    drainTimeoutSec: number
    heartbeatSec: number
    portRange: [number, number]
  }
  defaults: LaunchDefaults
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
  /** Placeholder, not used yet. */
  reserved?: { pinned: boolean, idleUnloadMin: number }
}

export interface ModelsDoc {
  version: number
  models: ModelConfig[]
}

export const SETTINGS_VERSION = 4
export const MODELS_VERSION = 1

export function defaultSettings(platform?: PlatformInfo): Settings {
  const windowsCuda = platform ? platform.os === 'win32' && platform.acceleration === 'cuda' : process.platform === 'win32'
  return {
    version: SETTINGS_VERSION,
    server: { host: '0.0.0.0', port: 5001 },
    public: { enabled: false, port: 8080, domain: '', tunnelEnabled: false, wizard: null },
    modelDirs: [],
    llamacpp: { cudaRuntime: '13.3', current: '', keepVersions: 2, autoUpdate: true, acceleration: 'auto' },
    scheduler: { maxLoaded: 1, loadTimeoutSec: 600, drainTimeoutSec: 300, heartbeatSec: 15, portRange: [7100, 7199] },
    defaults: windowsCuda ? { ...DEFAULT_LAUNCH_DEFAULTS } : {
      ...DEFAULT_LAUNCH_DEFAULTS, cacheTypeK: null, cacheTypeV: null, flashAttn: null,
      gpuLayers: platform?.acceleration === 'cpu' ? 0 : null, extraArgs: '--jinja --no-prefill-assistant --props --slots -cb',
    },
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
  const path = raw.path === 'api' || raw.path === 'manual' ? raw.path : null
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
  }
  return doc
}
