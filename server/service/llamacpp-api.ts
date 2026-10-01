// Shared by the /api/llamacpp routes: the version document the settings page shows.
import { fmt, t } from '../core/i18n'
import { UpdateError, type LlamacppDoc } from '../core/updater'
import { StoreError } from '../core/store'
import { getContext } from './context'

export function describeLlamacpp(): LlamacppDoc {
  const ctx = getContext()
  const { current, autoUpdate, keepVersions } = ctx.getSettings().llamacpp
  ctx.updater.refresh()
  return {
    current, status: ctx.updater.getStatus(), versions: ctx.updater.versions(), rollback: ctx.updater.rollbackTarget(),
    autoUpdate, keepVersions: Math.max(2, Math.floor(keepVersions) || 2),
  }
}

/** Turn an update / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function llamacppError(e: unknown): never {
  const errors = t.llamacpp.errors
  if (e instanceof UpdateError) throw createError({ statusCode: e.code === 'not-installed' ? 404 : 400, message: errors[e.code] })
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(errors.store, { detail: e.message }) })
  throw e
}
