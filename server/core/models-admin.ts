// Model management rules behind the models page: enabling a scanned file, switching the
// active profile, checking that configured files still exist. Pure module (no Nitro).
import { existsSync } from 'node:fs'
import type { ModelConfig, ModelsDoc } from './config'
import { aliasOf } from './importer'
import { resolveFileRef, type ScanEntry } from './scanner'
import type { FileRef, ModelDir } from './types'

export const DEFAULT_PROFILE = '默认'

export type ModelFile = 'model' | 'mmproj' | 'draft'

export type EnableErrorCode = 'not-found' | 'not-model' | 'incomplete' | 'already-enabled'

export class EnableError extends Error {
  constructor(public code: EnableErrorCode, message = code) {
    super(message)
    this.name = 'EnableError'
  }
}

export class ProfileError extends Error {
  constructor(public code: 'model-not-found' | 'profile-not-found', message = code) {
    super(message)
    this.name = 'ProfileError'
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
