// Enable a scanned model file: { dirId, rel }. The file is re-scanned here rather than
// trusting client-supplied metadata; the new model gets a default profile and no mmproj.
import type { ModelConfig } from '../../core/config'
import { fmt, t } from '../../core/i18n'
import { EnableError, planEnable, sameRef } from '../../core/models-admin'
import { scanModelDirs } from '../../core/scanner'
import { getContext } from '../../service/context'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ dirId?: unknown, rel?: unknown }>(event)
  if (typeof body?.dirId !== 'string' || typeof body?.rel !== 'string') {
    throw createError({ statusCode: 400, message: t.models.errors.badRequest })
  }
  const ref = { dirId: body.dirId, rel: body.rel }
  const ctx = getContext()
  const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
  const entry = entries.find(e => sameRef(e.ref, ref))
  try {
    let created: ModelConfig | undefined
    // planEnable runs inside the update so a concurrent enable cannot create a duplicate.
    ctx.updateModels((doc) => {
      created = planEnable(entry, doc)
      doc.models.push(created)
    })
    return { model: created }
  } catch (e) {
    if (e instanceof EnableError) {
      const status = e.code === 'not-found' ? 404 : 409
      throw createError({ statusCode: status, message: fmt(t.models.errors[e.code], { file: body.rel }) })
    }
    throw e
  }
})
