// Model management rules behind the models page: enabling a scanned file, switching the
// active profile, checking that configured files still exist. Pure module (no Nitro).
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { applyGpuChoice, hasGpuFields, sanitizeGpuChoice } from './gpu-group'
import { ArgsSyntaxError, normalizeDevice, PARAM_DEFS, paramValueOk, splitArgs, type ParamOverrides, type ParamValue } from './args'
import { DEFAULT_PROFILE, type ModelConfig, type ModelsDoc, type Profile } from './config'
import { aliasOf } from './importer'
import { parseRuntimeRef } from './runtimes'
import { resolveFileRef, type ScanEntry } from './scanner'
import type { FileRef, ModelDir } from './types'
import { mtpExtraArgs, mtpValid, sameDirectory, type MtpInput, type MtpMode } from './mtp'

export { MTP_DEFAULT_N, MTP_MAX_N, stripMtpArgs } from './mtp'

export { DEFAULT_PROFILE } from './config'

export type ModelFile = 'model' | 'mmproj' | 'draft'

export type EnableErrorCode = 'not-found' | 'not-model' | 'incomplete' | 'already-enabled'

export class EnableError extends Error {
  constructor(public code: EnableErrorCode, message = code) {
    super(message)
    this.name = 'EnableError'
  }
}

export type ProfileErrorCode =
  | 'model-not-found' | 'profile-not-found' | 'profile-exists' | 'name-invalid' | 'last-profile'
  | 'bad-overrides' | 'bad-extra-args' | 'template-not-found' | 'in-use' | 'bad-setup' | 'bad-context' | 'runtime-invalid' | 'device-invalid'

export class ProfileError extends Error {
  constructor(public code: ProfileErrorCode, message: string = code, public detail?: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export type FilesErrorCode = 'model-not-found' | 'file-not-found' | 'wrong-kind' | 'draft-not-neighbour' | 'file-incomplete' | 'file-in-use'

export class FilesError extends Error {
  constructor(public code: FilesErrorCode, message: string = code) {
    super(message)
    this.name = 'FilesError'
  }
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'

export function sameRef(a: FileRef | null | undefined, b: FileRef | null | undefined): boolean {
  return !!a && !!b && a.dirId === b.dirId && a.rel === b.rel
}

/** Id of the enabled model that uses this scanned main file, or null. */
export function enabledIdOf(doc: ModelsDoc, ref: FileRef): string | null {
  return doc.models.find(m => sameRef(m.file, ref))?.id ?? null
}

/**
 * A new model entry for a scanned main file: name from the file name, unique id / name, one
 * default profile, no mmproj / draft (same-directory candidates are only offered, never
 * picked). Throws EnableError.
 */
export function planEnable(entry: ScanEntry | undefined, doc: ModelsDoc): ModelConfig {
  if (!entry) throw new EnableError('not-found')
  if (entry.kind !== 'model') throw new EnableError('not-model')
  if (!entry.complete) throw new EnableError('incomplete')
  if (enabledIdOf(doc, entry.ref)) throw new EnableError('already-enabled')

  const base = aliasOf(entry.fileName)
  const names = new Set(doc.models.map(m => m.name.toLowerCase()))
  const ids = new Set(doc.models.map(m => m.id))
  let name = base
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}-${n}`
  const idBase = slug(name)
  let id = idBase
  for (let n = 2; ids.has(id); n++) id = `${idBase}-${n}`

  return {
    id, name, backend: 'llama-server',
    file: { ...entry.ref }, mmproj: null, draft: null,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: { overrides: {}, extraArgs: '' } },
    confirmed: false,
  }
}

/** Which of the configured files are gone (or their directory is no longer configured). */
export function missingFiles(model: ModelConfig, dirs: ModelDir[], exists: (p: string) => boolean = existsSync): ModelFile[] {
  const out: ModelFile[] = []
  const check = (kind: ModelFile, ref: FileRef | null) => {
    if (!ref) return
    const abs = resolveFileRef(dirs, ref)
    if (!abs || !exists(abs)) out.push(kind)
  }
  check('model', model.file)
  check('mmproj', model.mmproj)
  check('draft', model.draft)
  return out
}

/** Set the model's current profile. Returns the previous one. */
export function switchProfile(doc: ModelsDoc, modelId: string, profile: string): string {
  const model = doc.models.find(m => m.id === modelId)
  if (!model) throw new ProfileError('model-not-found')
  if (!Object.hasOwn(model.profiles, profile)) throw new ProfileError('profile-not-found')
  const prev = model.activeProfile
  model.activeProfile = profile
  return prev
}

// ---- Editing: files, profiles ----------------------------------------------------------------

const findModel = (doc: ModelsDoc, id: string) => {
  const m = doc.models.find(x => x.id === id)
  if (!m) throw new ProfileError('model-not-found')
  return m
}

export interface FilesPatch {
  /** Keys that are absent are left unchanged; `null` clears mmproj / draft. */
  file?: FileRef
  mmproj?: FileRef | null
  draft?: FileRef | null
}

const KIND_OF = { file: 'model', mmproj: 'mmproj', draft: 'draft' } as const

/**
 * Change the model's files. A reference that differs from the current one must be a scanned
 * file of the right kind (a model file must also be complete and not used by another model);
 * keeping the current value never re-validates, so a model with a missing file stays editable.
 * Nothing is changed when any part is refused.
 */
export function applyFiles(doc: ModelsDoc, modelId: string, patch: FilesPatch, entries: ScanEntry[]): ModelConfig {
  const model = doc.models.find(m => m.id === modelId)
  if (!model) throw new FilesError('model-not-found')
  const next: Partial<Pick<ModelConfig, 'file' | 'mmproj' | 'draft'>> = {}
  for (const key of ['file', 'mmproj', 'draft'] as const) {
    const ref = patch[key]
    if (ref === undefined) continue
    if (ref === null) {
      if (key === 'file') throw new FilesError('file-not-found')
      next[key] = null
      continue
    }
    if (sameRef(ref, model[key])) continue
    const entry = entries.find(e => sameRef(e.ref, ref))
    if (!entry) throw new FilesError('file-not-found')
    if (entry.kind !== KIND_OF[key]) throw new FilesError('wrong-kind')
    if (key === 'file') {
      if (!entry.complete) throw new FilesError('file-incomplete')
      const other = enabledIdOf(doc, ref)
      if (other && other !== model.id) throw new FilesError('file-in-use')
    }
    next[key] = { dirId: entry.ref.dirId, rel: entry.ref.rel }
  }
  Object.assign(model, next)
  return model
}

// ---- First start: thinking / vision / MTP ----------------------------------------------------

export interface FirstSetup {
  /** Context form value; absent keeps compatibility with older clients, null omits the flag. */
  ctxSize?: number | null
  /** Also update every global defaults set; the current profile keeps its own value. */
  setGlobalContext?: boolean
  /** Let the model think before answering (`--reasoning on`, no length limit) or not (`off`). */
  thinking: boolean
  /** Vision projector file (must be a scanned mmproj); null = no vision. */
  mmproj: FileRef | null
  mtp: boolean
  /** Explicit choice when MTP is enabled; no candidate-based capability inference. */
  mtpMode?: MtpMode | null
  /** Separate MTP file (scanned draft), for models that do not carry MTP themselves; null = none. */
  draft: FileRef | null
  /** Tokens proposed per step (`--spec-draft-n-max`). */
  mtpN: number
}

/** Validate MTP before any model/profile mutations. File mode always needs a fresh, complete neighbour. */
export function validateMtp(model: ModelConfig, input: MtpInput, entries: ScanEntry[]): void {
  if (!mtpValid(input)) throw new ProfileError('bad-setup')
  if (!input.enabled || input.mode !== 'file') return
  const entry = entries.find(e => sameRef(e.ref, input.draft))
  if (!entry) throw new FilesError('file-not-found')
  if (entry.kind !== 'draft') throw new FilesError('wrong-kind')
  if (!sameDirectory(model.file, entry.ref)) throw new FilesError('draft-not-neighbour')
  if (!entry.complete) throw new FilesError('file-incomplete')
}

/**
 * Apply the answers of the first-start dialog to the current profile and the model's files, and
 * mark the model confirmed. Files are checked against the scan like any other file edit; nothing
 * changes when one is refused.
 */
export function applyFirstSetup(doc: ModelsDoc, modelId: string, input: FirstSetup, entries: ScanEntry[]): ModelConfig {
  if (input.ctxSize !== undefined && input.ctxSize !== null && (typeof input.ctxSize !== 'number' || !Number.isFinite(input.ctxSize))) throw new ProfileError('bad-context')
  if (input.setGlobalContext !== undefined && typeof input.setGlobalContext !== 'boolean') throw new ProfileError('bad-context')
  if (input.setGlobalContext && input.ctxSize === undefined) throw new ProfileError('bad-context')
  const model = findModel(doc, modelId)
  const profile = model.profiles[model.activeProfile]
  if (!profile) throw new ProfileError('profile-not-found')
  const mtp: MtpInput = { enabled: input.mtp, mode: input.mtpMode ?? null, n: input.mtpN, draft: input.mtp ? input.draft : null }
  validateMtp(model, mtp, entries)
  const files: FilesPatch = { mmproj: input.mmproj, draft: input.mtp ? input.draft : null }
  applyFiles(doc, modelId, files, entries)

  profile.overrides = { ...profile.overrides, ...(input.ctxSize === undefined ? {} : { ctxSize: input.ctxSize }), reasoning: input.thinking ? 'on' : 'off', ...(input.thinking ? { reasoningBudget: -1 } : {}) }
  profile.extraArgs = mtpExtraArgs(profile.extraArgs, mtp)
  model.confirmed = true
  return model
}

/** File names in data/templates/ (chat templates a profile can use), sorted. */
export function listTemplates(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'templates'), { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Profile names are used in `model:profile` (split at the last colon), so no colon. */
export function validateProfileName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 40 || /[:\u0000-\u001f]/.test(name) || RESERVED_NAMES.has(name)) throw new ProfileError('name-invalid')
  return name
}

/** Keep only known form keys; `''` means "do not pass" (null); other than string / number is rejected. */
export function sanitizeOverrides(raw: unknown): ParamOverrides {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('bad-overrides')
  const out: Record<string, ParamValue> = {}
  for (const d of PARAM_DEFS) {
    const v = (raw as Record<string, unknown>)[d.key]
    if (v === undefined) continue
    if (v === null || v === '') out[d.key] = null
    else if (typeof v === 'number' && Number.isFinite(v)) out[d.key] = v
    else if (typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v)) out[d.key] = v.trim()
    else throw new ProfileError('bad-overrides', 'bad-overrides', d.key)
    if (!paramValueOk(d.key, out[d.key]!)) throw new ProfileError('bad-overrides', 'bad-overrides', d.key)
  }
  return out as ParamOverrides
}

export interface ProfileForm {
  overrides: ParamOverrides
  extraArgs: string
  chatTemplate: string | null
  /** llama.cpp build reference; undefined = leave the saved choice, null = follow the model / global version. */
  runtime?: string | null
  /** Device: undefined = leave the saved choice, null = follow the model / global default. */
  device?: string | null
  /** Set when the client sent any device field (device / devices / splitMode / tensorSplit / mainGpu): then it is the whole choice (decision 45). */
  gpu?: ReturnType<typeof sanitizeGpuChoice> & object
  /** Present only when the dedicated MTP control changed. Stored using existing args + draft fields. */
  mtp?: MtpInput
}

/** The whole device choice from a client body (single value or GPU group + split settings); throws `device-invalid` when it does not hold together. */
export function sanitizeGpu(raw: unknown): NonNullable<ProfileForm['gpu']> {
  const c = sanitizeGpuChoice(raw)
  if (!c) throw new ProfileError('device-invalid')
  return c
}

/** A device choice from the client: empty / null clears it; one valid value (`auto`, `cpu`, `CUDA0`) is kept. */
export function sanitizeDevice(raw: unknown): string | null {
  const v = normalizeDevice(raw)
  if (v === null) throw new ProfileError('device-invalid')
  return v || null
}

/** A runtime reference from the client: empty / null clears it; anything else must look like one (`cuda:b123`, `custom:<id>`). */
export function sanitizeRuntimeRef(raw: unknown): string | null {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string' || !parseRuntimeRef(raw)) throw new ProfileError('runtime-invalid')
  return raw
}

/** Shape-check form input from the client (values only; saveProfile checks the template and extra args). */
export function sanitizeForm(raw: unknown): ProfileForm {
  if (!raw || typeof raw !== 'object') throw new ProfileError('bad-overrides')
  const r = raw as Record<string, unknown>
  const extraArgs = r.extraArgs ?? ''
  if (typeof extraArgs !== 'string' || extraArgs.length > 10_000) throw new ProfileError('bad-extra-args')
  const chatTemplate = r.chatTemplate === undefined || r.chatTemplate === '' ? null : r.chatTemplate
  if (chatTemplate !== null && typeof chatTemplate !== 'string') throw new ProfileError('template-not-found')
  return {
    overrides: sanitizeOverrides(r.overrides), extraArgs, chatTemplate,
    ...(r.mtp === undefined ? {} : { mtp: sanitizeMtp(r.mtp) }),
    ...(r.runtime === undefined ? {} : { runtime: sanitizeRuntimeRef(r.runtime) }),
    ...(hasGpuFields(r)
      ? (() => { const gpu = sanitizeGpu(r); return { gpu, device: gpu.device || null } })()
      : {}),
  }
}

function sanitizeMtp(raw: unknown): MtpInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('bad-setup')
  const input = raw as MtpInput
  if (!mtpValid(input)) throw new ProfileError('bad-setup')
  return { enabled: input.enabled, mode: input.enabled ? input.mode : null, n: input.n,
    draft: input.enabled && input.mode === 'file' ? { dirId: input.draft!.dirId, rel: input.draft!.rel } : null }
}

/** Save the form into a profile. Extra args must parse and the template must exist. */
export function saveProfile(doc: ModelsDoc, modelId: string, name: string, form: ProfileForm, templates: string[], runtimeOk?: (ref: string) => boolean, deviceOk?: (device: string) => boolean, entries: ScanEntry[] = []): Profile {
  const model = findModel(doc, modelId)
  if (!Object.hasOwn(model.profiles, name)) throw new ProfileError('profile-not-found')
  try {
    splitArgs(form.extraArgs)
  } catch (e) {
    if (e instanceof ArgsSyntaxError) throw new ProfileError('bad-extra-args', 'bad-extra-args', e.message)
    throw e
  }
  if (form.chatTemplate !== null && !templates.includes(form.chatTemplate)) {
    throw new ProfileError('template-not-found', 'template-not-found', form.chatTemplate)
  }
  if (form.runtime && runtimeOk && !runtimeOk(form.runtime)) throw new ProfileError('runtime-invalid')
  const chosen = form.gpu ? form.gpu.device || form.gpu.devices[0] : form.device
  if (chosen && deviceOk && !deviceOk(chosen)) throw new ProfileError('device-invalid')
  if (form.mtp) validateMtp(model, form.mtp, entries)
  const profile = model.profiles[name]!
  // Other fields (per-profile preprocess overrides) are kept.
  profile.overrides = form.overrides
  profile.extraArgs = form.mtp ? mtpExtraArgs(form.extraArgs, form.mtp) : form.extraArgs
  if (form.mtp) model.draft = form.mtp.enabled && form.mtp.mode === 'file' ? form.mtp.draft : null
  profile.chatTemplate = form.chatTemplate
  if (form.runtime !== undefined) {
    if (form.runtime) profile.runtime = form.runtime
    else delete profile.runtime
  }
  if (form.gpu) applyGpuChoice(profile, form.gpu)
  else if (form.device !== undefined) {
    if (form.device) profile.device = form.device
    else delete profile.device
  }
  return profile
}

/** The model's own llama.cpp build (profiles can still choose their own); null follows the global version. */
export function setModelRuntime(doc: ModelsDoc, modelId: string, ref: string | null, runtimeOk?: (ref: string) => boolean): void {
  const model = findModel(doc, modelId)
  if (ref && runtimeOk && !runtimeOk(ref)) throw new ProfileError('runtime-invalid')
  if (ref) model.runtime = ref
  else delete model.runtime
}

/** The model's own device choice, single or GPU group (profiles can still choose their own); empty follows the global default. */
export function setModelGpu(doc: ModelsDoc, modelId: string, choice: NonNullable<ProfileForm['gpu']>, deviceOk?: (device: string) => boolean): void {
  const model = findModel(doc, modelId)
  const chosen = choice.device || choice.devices[0]
  if (chosen && deviceOk && !deviceOk(chosen)) throw new ProfileError('device-invalid')
  applyGpuChoice(model, choice)
}

/** The model's own device (profiles can still choose their own); null follows the global default. */
export function setModelDevice(doc: ModelsDoc, modelId: string, device: string | null, deviceOk?: (device: string) => boolean): void {
  const model = findModel(doc, modelId)
  if (device && deviceOk && !deviceOk(device)) throw new ProfileError('device-invalid')
  if (device) model.device = device
  else delete model.device
}

/** New profile: empty, or a copy of `from`. Returns the (trimmed) name. */
export function createProfile(doc: ModelsDoc, modelId: string, rawName: unknown, from?: string): string {
  const model = findModel(doc, modelId)
  const name = validateProfileName(rawName)
  if (Object.hasOwn(model.profiles, name)) throw new ProfileError('profile-exists')
  if (from !== undefined) {
    if (!Object.hasOwn(model.profiles, from)) throw new ProfileError('profile-not-found')
    model.profiles[name] = structuredClone(model.profiles[from]!)
  } else {
    model.profiles[name] = { overrides: {}, extraArgs: '' }
  }
  return name
}

/** Rename keeping the profile order; the current profile follows the rename. */
export function renameProfile(doc: ModelsDoc, modelId: string, from: string, rawTo: unknown): string {
  const model = findModel(doc, modelId)
  if (!Object.hasOwn(model.profiles, from)) throw new ProfileError('profile-not-found')
  const to = validateProfileName(rawTo)
  if (to === from) return to
  if (Object.hasOwn(model.profiles, to)) throw new ProfileError('profile-exists')
  const next: Record<string, Profile> = {}
  for (const [k, v] of Object.entries(model.profiles)) next[k === from ? to : k] = v
  model.profiles = next
  if (model.activeProfile === from) model.activeProfile = to
  return to
}

/** Delete a profile; the last one cannot go. Deleting the current one selects the first left. */
export function deleteProfile(doc: ModelsDoc, modelId: string, name: string): void {
  const model = findModel(doc, modelId)
  if (!Object.hasOwn(model.profiles, name)) throw new ProfileError('profile-not-found')
  const names = Object.keys(model.profiles)
  if (names.length <= 1) throw new ProfileError('last-profile')
  delete model.profiles[name]
  if (model.activeProfile === name) model.activeProfile = names.find(n => n !== name)!
}
