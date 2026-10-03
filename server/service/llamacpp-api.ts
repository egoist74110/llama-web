// Shared by the /api/llamacpp routes: the version document the settings page shows.
import { currentTagFor } from '../core/config'
import { fmt, t } from '../core/i18n'
import { UpdateError, type LlamacppDoc } from '../core/updater'
import { AddError } from '../core/runtime-add'
import { DeleteError } from '../core/runtime-manager'
import { StoreError } from '../core/store'
import { getContext } from './context'

export function describeLlamacpp(): LlamacppDoc {
  const ctx = getContext()
  const { autoUpdate, keepVersions } = ctx.getSettings().llamacpp
  const current = currentTagFor(ctx.getSettings(), ctx.platform, ctx.runtimeTarget.acceleration)
  ctx.updater.refresh()
  const sec = ctx.secondary
  sec?.updater.refresh()
  return {
    current, status: ctx.updater.getStatus(), versions: ctx.updater.versions(), rollback: ctx.updater.rollbackTarget(),
    autoUpdate, keepVersions: Math.max(2, Math.floor(keepVersions) || 2),
    runtimes: ctx.runtimes.list(),
    secondary: sec ? { accel: sec.accel, current: sec.current(), status: sec.updater.getStatus(), versions: sec.updater.versions() } : null,
  }
}

/** Turn an update / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function llamacppError(e: unknown): never {
  const errors = t.llamacpp.errors
  if (e instanceof UpdateError) throw createError({ statusCode: e.code === 'not-installed' ? 404 : 400, message: errors[e.code] })
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(errors.store, { detail: e.message }) })
  throw e
}

/** Turn an add / delete failure into an HTTP error with a Chinese message (a delete that needs confirmation carries the plan in `data`). */
export function runtimeError(e: unknown): never {
  const msgs = t.llamacpp.runtimes
  if (e instanceof AddError) {
    const status = e.code === 'not-found' ? 404 : e.code === 'network' ? 502
      : ['busy', 'stale-stage', 'needs-digest-confirm'].includes(e.code) ? 409 : 400
    throw createError({ statusCode: status, message: fmt((msgs.add as Record<string, string>)[e.code] ?? e.code, { detail: e.detail ?? '' }) })
  }
  if (e instanceof DeleteError) {
    const status = e.code === 'not-found' ? 404 : e.code === 'bad-ref' ? 400 : e.code === 'failed' ? 500 : 409
    throw createError({
      statusCode: status, message: fmt((msgs.remove as Record<string, string>)[e.code] ?? e.code, { detail: typeof e.detail === 'string' ? e.detail : '' }),
      ...(e.code === 'needs-confirm' ? { data: e.detail } : {}),
    })
  }
  return llamacppError(e)
}
