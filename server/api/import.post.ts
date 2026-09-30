// Import from the old swap-config.json: { path: string, dryRun?: boolean }.
// The LAN interface has full permissions by design (plan 关键决定 20); the public :8080 entry
// only ever forwards /v1/*, so this is not reachable from there. Cross-site writes are refused
// by middleware/admin-origin.ts.
import { extname } from 'node:path'
import { fmt, t } from '../core/i18n'
import {
  buildImport, commitImport, ImportError, ImportSaveError, readImportSource, type ImportWarning,
} from '../core/importer'
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
    // Slow part (read + scan) first; then plan against the latest documents and save in one
    // synchronous step, so config changes made during the scan are not overwritten.
    const src = await readImportSource({ configPath: path, settings: ctx.getSettings() })
    result = dryRun
      ? buildImport(src, { dataDir: ctx.dataDir, settings: ctx.getSettings(), models: ctx.getModels(), dryRun: true })
      : commitImport(src, ctx)
  } catch (e) {
    if (e instanceof ImportError) {
      throw createError({ statusCode: 400, message: fmt(t.import.errors[e.code], { detail: e.message }) })
    }
    if (e instanceof ImportSaveError) {
      const msg = e.rolledBack ? t.import.errors.saveFailed : t.import.errors.saveFailedPartial
      throw createError({ statusCode: 500, message: fmt(msg, { detail: e.message }) })
    }
    throw e
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
