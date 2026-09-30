// Import from the old swap-config.json: { path: string, dryRun?: boolean }.
// The LAN interface has full permissions by design (plan 关键决定 20); the public :8080 entry
// only ever forwards /v1/*, so this is not reachable from there.
import { extname } from 'node:path'
import { fmt, t } from '../core/i18n'
import { ImportError, importSwapConfig, type ImportWarning } from '../core/importer'
import { getContext } from '../service/context'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path?: unknown, dryRun?: unknown }>(event)
  const path = typeof body?.path === 'string' ? body.path.trim().replace(/^"(.*)"$/, '$1') : ''
  if (!path) throw createError({ statusCode: 400, message: t.import.errors.pathRequired })
  if (extname(path).toLowerCase() !== '.json') throw createError({ statusCode: 400, message: t.import.errors.badPath })
  const dryRun = body?.dryRun === true

  const ctx = getContext()
  let result
  try {
    result = await importSwapConfig({
      dataDir: ctx.dataDir, configPath: path, settings: ctx.getSettings(), models: ctx.getModels(), dryRun,
    })
  } catch (e) {
    if (e instanceof ImportError) {
      throw createError({ statusCode: 400, message: fmt(t.import.errors[e.code], { detail: e.message }) })
    }
    throw e
  }

  if (!dryRun && result.report.imported.length > 0) {
    try {
      // Settings first: models reference the directory id that may be new.
      ctx.updateSettings(() => result.settings)
      ctx.updateModels(() => result.models)
    } catch (e) {
      throw createError({ statusCode: 500, message: fmt(t.import.errors.saveFailed, { detail: (e as Error).message }) })
    }
  }

  const warn = (w: ImportWarning) => fmt(t.import.warnings[w.code], { subject: w.subject, detail: w.detail ?? '' })
  const r = result.report
  return {
    dryRun,
    imported: r.imported,
    defaultsApplied: r.defaultsApplied && r.imported.length > 0,
    warnings: r.warnings.map(warn),
  }
})
