// Usage summary: GET /api/usage[?from=YYYY-MM-DD&to=YYYY-MM-DD][&format=csv[&groupBy=model|profile|source|key]]
// JSON: per-day totals plus totals grouped by model / profile / source / key. Counters only.
import { UsageError, type UsageGroupBy } from '../../core/usage'
import { t } from '../../core/i18n'
import { getContext } from '../../service/context'

const GROUPS: UsageGroupBy[] = ['model', 'profile', 'source', 'key']

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const from = typeof q.from === 'string' && q.from ? q.from : undefined
  const to = typeof q.to === 'string' && q.to ? q.to : undefined
  const groupBy = typeof q.groupBy === 'string' && q.groupBy ? q.groupBy as UsageGroupBy : undefined
  if (groupBy && !GROUPS.includes(groupBy)) throw createError({ statusCode: 400, message: t.usage.errors.badRequest })
  const { usage } = getContext()
  try {
    if (q.format === 'csv') {
      const body = usage.csv(from, to, groupBy)
      setHeader(event, 'content-type', 'text/csv; charset=utf-8')
      setHeader(event, 'content-disposition', `attachment; filename="usage-${from ?? 'recent'}_${to ?? 'today'}.csv"`)
      // BOM so spreadsheet apps read the Chinese model names as UTF-8.
      return `﻿${body}`
    }
    return usage.report(from, to)
  } catch (e) {
    if (e instanceof UsageError) throw createError({ statusCode: 400, message: t.usage.errors.badRange })
    throw e
  }
})
