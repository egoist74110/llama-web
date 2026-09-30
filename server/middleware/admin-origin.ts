// Refuse cross-site writes to the management API (see core/origin.ts).
import { t } from '../core/i18n'
import { checkAdminRequest } from '../core/origin'

export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  const rejection = checkAdminRequest({ method: event.method, headers: event.headers })
  if (rejection === 'cross-origin') throw createError({ statusCode: 403, message: t.admin.crossOrigin })
  if (rejection === 'json-required') throw createError({ statusCode: 415, message: t.admin.jsonRequired })
})
