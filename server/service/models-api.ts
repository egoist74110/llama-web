// Shared by the per-model action routes.
import { fmt, t } from '../core/i18n'
import { FilesError, ProfileError } from '../core/models-admin'
import { SchedulerError } from '../core/scheduler'
import { getContext } from './context'

export function requireModel(id: string | undefined) {
  const model = getContext().getModels().models.find(m => m.id === id)
  if (!model) throw createError({ statusCode: 404, message: t.models.errors.modelNotFound })
  return model
}

export function requireProfile(model: { profiles: Record<string, unknown> }, profile: unknown): string {
  if (typeof profile !== 'string' || !Object.hasOwn(model.profiles, profile)) {
    throw createError({ statusCode: 404, message: t.models.errors.profileNotFound })
  }
  return profile
}

/** Profiles of this model that have a live instance (loading / running / winding down). */
export function upProfiles(modelId: string): string[] {
  return getContext().ops.upProfiles(modelId)
}

/** Refuse to rename / delete a profile that is up, queued for loading or about to be restarted onto. */
export function assertProfileFree(modelId: string, name: string): void {
  if (getContext().ops.inUseProfiles(modelId).includes(name)) editError(new ProfileError('in-use'))
}

/**
 * Restart the model on the profile it is serving (or about to start), when `only` is unset or
 * names that profile. Used after edits that only apply on the next load. Returns whether a
 * restart was scheduled.
 */
export function restartIfUp(modelId: string, only?: string): boolean {
  const work = getContext().ops.restartIfUp(modelId, only)
  if (!work) return false
  background(`restart ${modelId}`, () => work)
  return true
}

/** Turn a model edit failure into an HTTP error with a Chinese message; other errors pass through. */
export function editError(e: unknown, vars: Record<string, string> = {}): never {
  const errors = t.models.errors as Record<string, string>
  if (e instanceof ProfileError || e instanceof FilesError) {
    const status = e.code === 'model-not-found' || e.code === 'profile-not-found' || e.code === 'file-not-found' ? 404
      : e.code === 'profile-exists' || e.code === 'last-profile' || e.code === 'file-in-use' || e.code === 'in-use' ? 409 : 400
    const detail = e instanceof ProfileError ? (e.detail ?? '') : ''
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail, ...vars }) })
  }
  throw e
}

/** Run a slow scheduler operation without holding the HTTP request; the outcome shows up in the live state. */
export function background(what: string, job: () => Promise<unknown>): void {
  job().catch((e) => {
    // Stopped or superseded by a later action (manual stop, profile switch): not an error.
    if (e instanceof SchedulerError && e.code === 'stopped') return
    console.error(`[llama-web] ${what}:`, (e as Error)?.message ?? e)
  })
}
