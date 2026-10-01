// One log file: GET /api/logs/file?kind=model|events|requests&name=<file>[&model=<id>]
// Returns the end of the file (see LogStore.read). Names are validated; nothing outside data/logs is readable.
import { LogError, type LogKind } from '../../core/logs'
import { t } from '../../core/i18n'
import { getContext } from '../../service/context'

const KINDS: LogKind[] = ['model', 'events', 'requests']

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const kind = String(q.kind ?? '') as LogKind
  const name = String(q.name ?? '')
  const model = typeof q.model === 'string' ? q.model : undefined
  if (!KINDS.includes(kind)) throw createError({ statusCode: 400, message: t.logs.errors.badRequest })
  try {
    return getContext().logs.read(kind, name, model)
  } catch (e) {
    if (e instanceof LogError) {
      throw createError({ statusCode: e.code === 'not-found' ? 404 : 400, message: e.code === 'not-found' ? t.logs.errors.notFound : t.logs.errors.badRequest })
    }
    throw e
  }
})
