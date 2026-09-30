// Change the model's files: { file?, mmproj?, draft?, restart? }. Files are checked against a
// fresh scan, not against client-supplied metadata. `null` clears mmproj / draft.
import { FilesError, applyFiles, type FilesPatch } from '../../../core/models-admin'
import { scanModelDirs } from '../../../core/scanner'
import { t } from '../../../core/i18n'
import { getContext } from '../../../service/context'
import { editError, requireModel, restartIfUp } from '../../../service/models-api'

const isRef = (v: unknown): v is { dirId: string, rel: string } =>
  !!v && typeof v === 'object' && typeof (v as any).dirId === 'string' && typeof (v as any).rel === 'string'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<Record<string, unknown>>(event)
  const patch: FilesPatch = {}
  for (const key of ['file', 'mmproj', 'draft'] as const) {
    const v = body?.[key]
    if (v === undefined) continue
    if (v !== null && !isRef(v)) throw createError({ statusCode: 400, message: t.models.errors.badRequest })
    ;(patch as Record<string, unknown>)[key] = v === null ? null : { dirId: v.dirId, rel: v.rel }
  }
  const ctx = getContext()
  const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
  try {
    ctx.updateModels((doc) => { applyFiles(doc, model.id, patch, entries) })
  } catch (e) {
    if (e instanceof FilesError) editError(e)
    throw e
  }
  const restarted = body?.restart === true && restartIfUp(model.id)
  return { ok: true, restarted }
})
