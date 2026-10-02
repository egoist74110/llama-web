// Shared by the /api/app-update routes: refusals become HTTP errors with a Chinese message.
import { AppUpdateError } from '../core/app-update'
import { t } from '../core/i18n'

export function appUpdateError(e: unknown): never {
  if (e instanceof AppUpdateError) {
    const status = e.code === 'busy' ? 409 : e.code === 'not-desktop' || e.code === 'nothing-new' || e.code === 'not-ready' ? 400 : 502
    throw createError({ statusCode: status, message: t.appUpdate.errors[e.code] })
  }
  throw e
}
