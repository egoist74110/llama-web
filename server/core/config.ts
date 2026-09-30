// settings.json / models.json schemas, defaults and light normalisation (see plan「配置与数据」).
// Hand-edited files may omit sections; missing values are filled from the defaults.
import { DEFAULT_LAUNCH_DEFAULTS, type LaunchDefaults, type ParamOverrides } from './args'
import type { FileRef, ModelDir } from './types'

export interface ImagePreprocess {
  enabled: boolean
  /** Longest edge after resizing, in pixels. */
  maxEdge: number
  format: 'jpeg' | 'png' | 'webp'
  quality: number
}

export interface Settings {
  version: number
  server: { host: string, port: number }
  public: { enabled: boolean, port: number, domain: string, tunnelName: string }
  modelDirs: ModelDir[]
  llamacpp: { cudaRuntime: string, current: string, keepVersions: number, autoUpdate: boolean }
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

export const SETTINGS_VERSION = 1
export const MODELS_VERSION = 1

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    server: { host: '0.0.0.0', port: 5001 },
    public: { enabled: false, port: 8080, domain: '', tunnelName: '' },
    modelDirs: [],
    llamacpp: { cudaRuntime: '13.3', current: '', keepVersions: 2, autoUpdate: true },
    scheduler: { maxLoaded: 1, loadTimeoutSec: 600, drainTimeoutSec: 300, heartbeatSec: 15, portRange: [7100, 7199] },
    defaults: { ...DEFAULT_LAUNCH_DEFAULTS },
    preprocess: { image: { enabled: true, maxEdge: 896, format: 'jpeg', quality: 90 } },
    logs: { keepRunsPerModel: 20, keepDays: 14 },
    gpu: { sampleSec: 2 },
  }
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
  // Placeholder (decision 9): the field exists but the online limit stays fixed at 1.
  out.scheduler.maxLoaded = 1
  return out as Settings
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
