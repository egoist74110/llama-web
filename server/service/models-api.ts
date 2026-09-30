// Shared by the per-model action routes.
import { fmt, t } from '../core/i18n'
import { FilesError, ProfileError } from '../core/models-admin'
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

const UP = new Set(['loading', 'ready', 'draining', 'unloading'])

/** Profiles of this model that have a live instance (loading / running / winding down). */
export function upProfiles(modelId: string): string[] {
  return getContext().scheduler.snapshot().models
    .filter(s => s.modelId === modelId && UP.has(s.state))
    .map(s => s.profile)
}

/**
 * Restart the model on the profile that is up, when `only` is unset or names that profile.
 * Used after edits that only apply on the next load. Returns whether a restart was scheduled.
 */
export function restartIfUp(modelId: string, only?: string): boolean {
  const ctx = getContext()
  const profile = upProfiles(modelId).find(p => only === undefined || p === only)
  if (!profile) return false
  background(`restart ${modelId}:${profile}`, async () => {
    await ctx.scheduler.stop(modelId)
    await ctx.scheduler.start({ modelId, profile })
  })
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
  job().catch(e => console.error(`[llama-web] ${what}:`, (e as Error)?.message ?? e))
}
