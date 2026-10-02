// { autoCheck?: boolean, skipped?: string | null }: automatic checks and the skipped version.
import { getContext } from '../../service/context'
import { parseVersion } from '../../core/app-update'
import { t } from '../../core/i18n'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) as { autoCheck?: unknown, skipped?: unknown } | null
  const patch: { autoCheck?: boolean, skipped?: string | null } = {}
  if (body?.autoCheck !== undefined) {
    if (typeof body.autoCheck !== 'boolean') throw createError({ statusCode: 400, message: t.appUpdate.errors['bad-request'] })
    patch.autoCheck = body.autoCheck
  }
  if (body?.skipped !== undefined) {
    if (body.skipped !== null && (typeof body.skipped !== 'string' || !parseVersion(body.skipped))) throw createError({ statusCode: 400, message: t.appUpdate.errors['bad-request'] })
    patch.skipped = body.skipped as string | null
  }
  return getContext().appUpdate.setPrefs(patch)
})
