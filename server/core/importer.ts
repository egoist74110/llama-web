// Import of the legacy `swap-config.json` (generator input for the old llama-swap setup).
// Models are not listed in that file: every .gguf under `models_root` was published, minus the
// `exclude` list, with `global` defaults and per-model overrides. The import reproduces that:
// scan the root, derive the same aliases, map settings to launch parameters. API keys, domain
// and tunnel settings are deliberately not imported (plan「旧环境迁移」).
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_LAUNCH_DEFAULTS, PARAM_DEFS, quoteArg, splitArgs, type LaunchDefaults, type ParamKey, type ParamValue } from './args'
import type { ModelConfig, ModelsDoc, Settings } from './config'
import { scanModelDirs, type ScanEntry, type ScanResult } from './scanner'
import type { FileRef, ModelDir } from './types'

export type ImportErrorCode = 'unreadable' | 'invalid-json' | 'no-models-root'

export class ImportError extends Error {
  constructor(public code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** Writing the import failed. `rolledBack`: everything this import wrote was undone. */
export class ImportSaveError extends Error {
  constructor(public rolledBack: boolean, public override cause: unknown) {
    super((cause as Error)?.message ?? String(cause))
    this.name = 'ImportSaveError'
  }
}

export type ImportWarningCode =
  | 'models-root-missing'
  | 'override-unmatched'
  | 'already-exists'
  | 'incomplete-shards'
  | 'template-missing'
  | 'bad-extra-args'
  | 'draft-outside-root'

export interface ImportWarning {
  code: ImportWarningCode
  /** Model alias or file the warning is about. */
  subject: string
  detail?: string
}

/** The parts of swap-config.json the import understands. */
export interface SwapConfig {
  modelsRoot: string
  exclude: string[]
  global: Record<string, unknown>
  models: Record<string, Record<string, unknown>>
}

const KEY_MAP: Record<string, ParamKey> = {
  ctx_size: 'ctxSize',
  cache_type_k: 'cacheTypeK',
  cache_type_v: 'cacheTypeV',
  flash_attn: 'flashAttn',
  gpu_layers: 'gpuLayers',
  batch_size: 'batchSize',
  ubatch_size: 'ubatchSize',
  parallel: 'parallel',
  reasoning: 'reasoning',
  reasoning_format: 'reasoningFormat',
  reasoning_budget: 'reasoningBudget',
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Drop `_`-prefixed comment keys (the old generator ignored them). */
function withoutComments(o: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (isObj(o)) for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v
  return out
}

export function parseSwapConfig(text: string): SwapConfig {
  // The old generator tolerated trailing commas; so do we.
  const cleaned = text.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1')
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch (e) {
    throw new ImportError('invalid-json', (e as Error).message)
  }
  if (!isObj(raw)) throw new ImportError('invalid-json', 'top level must be an object')
  const root = raw.models_root
  if (typeof root !== 'string' || !root.trim()) throw new ImportError('no-models-root', 'models_root is missing')
  const exclude = Array.isArray(raw.exclude) ? raw.exclude.map(x => String(x).trim()).filter(Boolean) : []
  const models: SwapConfig['models'] = {}
  for (const [k, v] of Object.entries(withoutComments(raw.models))) models[k] = withoutComments(v)
  return { modelsRoot: root.trim(), exclude, global: withoutComments(raw.global), models }
}

const QUANT_PATTERNS = [
  /([.-]((UD|i1)[.-])?(IQ|Q)\d+([._-]([A-Za-z]{1,3}|\d+))*)$/i,
  /([.-](BF16|F16|F32))$/i,
]
const SHARD_SUFFIX = /-\d{5}-of-\d{5}$/i

/** Model name from a file name: drops the extension, shard suffix and a trailing quant tag. */
export function aliasOf(fileName: string): string {
  let base = fileName.replace(/\.gguf$/i, '').replace(SHARD_SUFFIX, '')
  for (const p of QUANT_PATTERNS) {
    const n = base.replace(p, '')
    if (n !== base) {
      base = n
      break
    }
  }
  return base
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
}

/** `abs` as a forward-slash path relative to `root`, or null when outside it. */
function relInside(root: string, abs: string): string | null {
  const rel = relative(resolve(root), resolve(abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(/[\\/]/).join('/')
}

function paramValue(v: unknown): ParamValue {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

function oldParams(...layers: Array<Record<string, unknown>>): Record<ParamKey, ParamValue> {
  // Old behaviour: a key that is absent (or empty) means the flag was not passed.
  const out = {} as Record<ParamKey, ParamValue>
  for (const d of PARAM_DEFS) out[d.key] = null
  for (const layer of layers) {
    for (const [oldKey, key] of Object.entries(KEY_MAP)) if (oldKey in layer) out[key] = paramValue(layer[oldKey])
  }
  return out
}

const HELPER_PREFERRED = /BF16|F16|F32/i

function pickMmproj(model: ScanEntry, entries: ScanEntry[]): FileRef | null {
  // Old rule: one mmproj per directory, preferring BF16/F16/F32 file names.
  let best: FileRef | null = null
  for (const ref of model.candidates.mmproj) {
    const name = basename(ref.rel)
    if (!best || (HELPER_PREFERRED.test(name) && !HELPER_PREFERRED.test(basename(best.rel)))) best = ref
  }
  return best && entries.some(e => e.ref.dirId === best!.dirId && e.ref.rel === best!.rel) ? best : null
}

export interface TemplateCopy {
  /** Index into `PlanResult.models`. */
  modelIndex: number
  source: string
}

export interface PlanInput {
  config: SwapConfig
  dir: ModelDir
  scan: ScanResult
  /** Settings the import merges into. */
  settings: Settings
  existing: ModelsDoc
  /** Directory of the config file, for resolving relative template paths. */
  configDir: string
  fileExists?: (path: string) => boolean
}

export interface PlanResult {
  defaults: LaunchDefaults
  /** True when `defaults` replaces the current global defaults (first import only). */
  defaultsApplied: boolean
  models: ModelConfig[]
  templates: TemplateCopy[]
  warnings: ImportWarning[]
}

export function planImport(input: PlanInput): PlanResult {
  const { config, dir, scan, settings, existing } = input
  const fileExists = input.fileExists ?? existsSync
  const warnings: ImportWarning[] = []

  // Global defaults come from the old file only on the first import; later imports must not
  // clobber defaults the user has edited since. Per-model overrides are computed against
  // whichever defaults end up in effect, so behaviour is preserved either way.
  const defaultsApplied = existing.models.length === 0
  let defaults: LaunchDefaults
  if (defaultsApplied) {
    const g = oldParams(config.global)
    let extraArgs = DEFAULT_LAUNCH_DEFAULTS.extraArgs // hard-coded in the old generator
    const ge = typeof config.global.extra_args === 'string' ? config.global.extra_args.trim() : ''
    if (ge) extraArgs += ` ${ge}`
    defaults = { ...g, extraArgs }
  } else {
    defaults = settings.defaults
  }

  const usedIds = new Set(existing.models.map(m => m.id))
  const usedNames = new Set(existing.models.map(m => m.name.toLowerCase()))
  const excluded = new Set(config.exclude.map(x => x.toLowerCase()))

  // alias -> entry; on collision keep the shortest file name (usually the main weights).
  const byAlias = new Map<string, ScanEntry>()
  for (const e of scan.entries) {
    if (e.kind !== 'model') continue
    if (!e.complete) {
      warnings.push({ code: 'incomplete-shards', subject: e.fileName })
      continue
    }
    const alias = aliasOf(e.fileName)
    const cur = byAlias.get(alias)
    if (!cur || e.fileName.length < cur.fileName.length) byAlias.set(alias, e)
  }

  const overrideByLower = new Map(Object.entries(config.models).map(([k, v]) => [k.toLowerCase(), v]))
  for (const k of Object.keys(config.models)) {
    if (![...byAlias.keys()].some(a => a.toLowerCase() === k.toLowerCase())) {
      warnings.push({ code: 'override-unmatched', subject: k })
    }
  }

  const models: ModelConfig[] = []
  const templates: TemplateCopy[] = []
  for (const alias of [...byAlias.keys()].sort()) {
    if (excluded.has(alias.toLowerCase())) continue
    if (usedNames.has(alias.toLowerCase())) {
      warnings.push({ code: 'already-exists', subject: alias })
      continue
    }
    const entry = byAlias.get(alias)!
    const ov = overrideByLower.get(alias.toLowerCase()) ?? {}

    const effective = oldParams(config.global, ov)
    const overrides: Record<string, ParamValue> = {}
    for (const d of PARAM_DEFS) if (effective[d.key] !== defaults[d.key]) overrides[d.key] = effective[d.key]

    // Extra args: chat_template (name) and a -md draft path move into structured fields.
    let tokens: string[] = []
    const rawExtra = typeof ov.extra_args === 'string' ? ov.extra_args : defaultsApplied ? '' : typeof config.global.extra_args === 'string' ? config.global.extra_args : ''
    try {
      tokens = splitArgs(rawExtra)
    } catch (e) {
      warnings.push({ code: 'bad-extra-args', subject: alias, detail: (e as Error).message })
      tokens = []
    }
    let draft: FileRef | null = null
    for (let i = 0; i < tokens.length; i++) {
      if ((tokens[i] !== '-md' && tokens[i] !== '--model-draft') || i + 1 >= tokens.length) continue
      const rel = relInside(dir.path, tokens[i + 1]!)
      const found = rel && scan.entries.find(e => e.kind === 'draft' && e.ref.dirId === dir.id && e.ref.rel.toLowerCase() === rel.toLowerCase())
      if (found) {
        draft = found.ref
        tokens.splice(i, 2)
        i--
      } else {
        warnings.push({ code: 'draft-outside-root', subject: alias, detail: tokens[i + 1] })
      }
    }
    if (typeof ov.chat_template === 'string' && ov.chat_template.trim()) tokens.push('--chat-template', ov.chat_template.trim())

    const index = models.length
    let idBase = slug(alias)
    let id = idBase
    for (let n = 2; usedIds.has(id); n++) id = `${idBase}-${n}`
    usedIds.add(id)
    usedNames.add(alias.toLowerCase())

    const tpl = typeof ov.chat_template_file === 'string' ? ov.chat_template_file.trim() : ''
    let chatTemplate: string | null = null
    if (tpl) {
      const source = isAbsolute(tpl) ? tpl : resolve(input.configDir, tpl)
      if (fileExists(source)) {
        chatTemplate = basename(source)
        templates.push({ modelIndex: index, source })
      } else {
        warnings.push({ code: 'template-missing', subject: alias, detail: tpl })
      }
    }

    models.push({
      id,
      name: alias,
      backend: 'llama-server',
      file: entry.ref,
      mmproj: pickMmproj(entry, scan.entries),
      draft,
      activeProfile: '默认',
      profiles: { 默认: { overrides, extraArgs: tokens.map(quoteArg).join(' '), chatTemplate } },
    })
  }
  return { defaults, defaultsApplied, models, templates, warnings }
}

/**
 * Copy a template into `data/templates/`. Returns the file name actually used: the original
 * name when free or identical, otherwise `<stem>-imported<ext>` (numbered if needed), and
 * whether a new file was written.
 */
export function copyTemplate(dataDir: string, source: string): { name: string, created: boolean } {
  const dir = join(dataDir, 'templates')
  mkdirSync(dir, { recursive: true })
  const name = basename(source)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const data = readFileSync(source)
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-imported${n > 1 ? n : ''}${ext}`
    const dest = join(dir, candidate)
    if (!existsSync(dest)) {
      copyFileSync(source, dest)
      return { name: candidate, created: true }
    }
    if (readFileSync(dest).equals(data)) return { name: candidate, created: false }
  }
}

export interface ImportOptions {
  dataDir: string
  configPath: string
  settings: Settings
  models: ModelsDoc
  /** Report only: nothing is copied and the returned documents are not meant to be saved. */
  dryRun?: boolean
  scan?: typeof scanModelDirs
}

export interface ImportReport {
  dirId: string
  modelsRoot: string
  /** `mmproj`: relative path of the automatically paired projector (decision 5, import exception). */
  imported: Array<{ id: string, name: string, mmproj: string | null, draft: boolean, chatTemplate: string | null }>
  templatesCopied: string[]
  defaultsApplied: boolean
  warnings: ImportWarning[]
}

export interface ImportResult {
  settings: Settings
  models: ModelsDoc
  report: ImportReport
  /** Template files this import newly wrote into data/templates/ (for rollback). */
  createdTemplates: string[]
}

/** The slow, read-only half of an import: parse the old file and scan its model root. */
export interface ImportSource {
  configPath: string
  config: SwapConfig
  scan: ScanResult
}

/** Directory id used while scanning; entries are re-labelled once the real id is known. */
const SCAN_DIR_ID = '\0import'

const samePath = (a: string, b: string) => relative(resolve(a), resolve(b)) === ''

export async function readImportSource(opts: { configPath: string, settings: Settings, scan?: typeof scanModelDirs }): Promise<ImportSource> {
  let text: string
  try {
    text = readFileSync(opts.configPath, 'utf8')
  } catch (e) {
    throw new ImportError('unreadable', (e as Error).message)
  }
  const config = parseSwapConfig(text)
  const known = opts.settings.modelDirs.find(d => samePath(d.path, config.modelsRoot))
  // Scan with the directory enabled and deep enough to match the old unlimited recursion.
  const scanDir: ModelDir = { id: SCAN_DIR_ID, path: config.modelsRoot, enabled: true, maxDepth: Math.max(known?.maxDepth ?? 0, 10) }
  const scan = await (opts.scan ?? scanModelDirs)([scanDir])
  return { configPath: opts.configPath, config, scan }
}

function relabel(scan: ScanResult, dirId: string): ScanResult {
  const ref = (r: FileRef): FileRef => (r.dirId === SCAN_DIR_ID ? { ...r, dirId } : r)
  return {
    entries: scan.entries.map(e => ({
      ...e,
      ref: ref(e.ref),
      candidates: { mmproj: e.candidates.mmproj.map(ref), draft: e.candidates.draft.map(ref) },
    })),
    warnings: scan.warnings.map(w => (w.dirId === SCAN_DIR_ID ? { ...w, dirId } : w)),
  }
}

/** Delete templates this import created. True when all of them are gone. */
function removeTemplates(dataDir: string, names: string[]): boolean {
  let ok = true
  for (const n of names) {
    try {
      unlinkSync(join(dataDir, 'templates', n))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ok = false
    }
  }
  return ok
}

/**
 * The fast, synchronous half: plan against the given documents and copy templates (unless
 * dryRun). Being synchronous, it can run against the latest documents right before saving.
 */
export function buildImport(src: ImportSource, opts: { dataDir: string, settings: Settings, models: ModelsDoc, dryRun?: boolean }): ImportResult {
  const { config } = src
  const settings = structuredClone(opts.settings)
  let dir = settings.modelDirs.find(d => samePath(d.path, config.modelsRoot))
  const isNewDir = !dir
  if (!dir) {
    let id = 'main'
    for (let n = 2; settings.modelDirs.some(d => d.id === id); n++) id = `main${n}`
    dir = { id, path: config.modelsRoot, enabled: true, maxDepth: 10 }
  }
  const scanDir: ModelDir = { ...dir, enabled: true, maxDepth: Math.max(dir.maxDepth, 10) }
  const scan = relabel(src.scan, dir.id)
  const warnings: ImportWarning[] = scan.warnings.filter(w => w.rel === '').map(() => ({ code: 'models-root-missing' as const, subject: config.modelsRoot }))

  const plan = planImport({
    config, dir: scanDir, scan, settings, existing: opts.models, configDir: dirname(resolve(src.configPath)),
  })
  warnings.push(...plan.warnings)

  const models = structuredClone(opts.models)
  const copied: string[] = []
  const created: string[] = []
  try {
    for (const t of plan.templates) {
      const m = plan.models[t.modelIndex]!
      let name = basename(t.source)
      if (!opts.dryRun) {
        const r = copyTemplate(opts.dataDir, t.source)
        name = r.name
        if (r.created) created.push(r.name)
      }
      m.profiles['默认']!.chatTemplate = name
      if (!copied.includes(name)) copied.push(name)
    }
  } catch (e) {
    throw new ImportSaveError(removeTemplates(opts.dataDir, created), e)
  }
  models.models.push(...plan.models)
  if (isNewDir && plan.models.length > 0) settings.modelDirs.push(dir)
  if (plan.defaultsApplied) settings.defaults = plan.defaults

  return {
    settings,
    models,
    createdTemplates: created,
    report: {
      dirId: dir.id,
      modelsRoot: config.modelsRoot,
      imported: plan.models.map(m => ({
        id: m.id, name: m.name, mmproj: m.mmproj?.rel ?? null, draft: !!m.draft, chatTemplate: m.profiles['默认']!.chatTemplate ?? null,
      })),
      templatesCopied: copied,
      defaultsApplied: plan.defaultsApplied,
      warnings,
    },
  }
}

/** Read the old config, scan its model root and build the new settings / models documents. */
export async function importSwapConfig(opts: ImportOptions): Promise<ImportResult> {
  const src = await readImportSource({ configPath: opts.configPath, settings: opts.settings, scan: opts.scan })
  return buildImport(src, opts)
}

/** Where a real import is saved (the app context in production). */
export interface ImportTarget {
  dataDir: string
  getSettings(): Settings
  getModels(): ModelsDoc
  updateSettings(fn: () => Settings): unknown
  updateModels(fn: () => ModelsDoc): unknown
}

/**
 * Plan against the *latest* documents and save both, all synchronously, so no other config
 * change can land between planning and saving (a concurrent import, the llama.cpp download
 * setting `current`, a reloaded hand edit). If a save fails, whatever this import already
 * wrote is undone; ImportSaveError.rolledBack says whether that worked.
 */
export function commitImport(src: ImportSource, target: ImportTarget): ImportResult {
  const prevSettings = structuredClone(target.getSettings())
  const result = buildImport(src, { dataDir: target.dataDir, settings: target.getSettings(), models: target.getModels() })
  if (result.report.imported.length === 0) return result
  let settingsSaved = false
  try {
    // Settings first: models reference the directory id that may be new.
    target.updateSettings(() => result.settings)
    settingsSaved = true
    target.updateModels(() => result.models)
  } catch (e) {
    let rolledBack = removeTemplates(target.dataDir, result.createdTemplates)
    if (settingsSaved) {
      try {
        target.updateSettings(() => prevSettings)
      } catch {
        rolledBack = false
      }
    }
    throw new ImportSaveError(rolledBack, e)
  }
  return result
}
