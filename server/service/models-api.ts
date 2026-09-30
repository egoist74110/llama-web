// Shared by the per-model action routes.
import { t } from '../core/i18n'
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

/** Run a slow scheduler operation without holding the HTTP request; the outcome shows up in the live state. */
export function background(what: string, job: () => Promise<unknown>): void {
  job().catch(e => console.error(`[llama-web] ${what}:`, (e as Error)?.message ?? e))
}
