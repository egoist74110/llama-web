// Save the first-start answers { thinking, mmproj, mtp, draft, mtpN, start? } into the model's
// current profile and files, mark the model confirmed, and optionally start it.
import { applyFirstSetup, type FirstSetup } from '../../../core/models-admin'
import { scanModelDirs } from '../../../core/scanner'
import { t } from '../../../core/i18n'
import { getContext } from '../../../service/context'
import { background, editError, requireModel } from '../../../service/models-api'

const isRef = (v: unknown): v is { dirId: string, rel: string } =>
  !!v && typeof v === 'object' && typeof (v as any).dirId === 'string' && typeof (v as any).rel === 'string'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<Record<string, unknown>>(event)
  const ref = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (!isRef(v)) throw createError({ statusCode: 400, message: t.models.errors.badRequest })
    return { dirId: v.dirId, rel: v.rel }
  }
  if (typeof body?.thinking !== 'boolean' || typeof body?.mtp !== 'boolean' || typeof body?.mtpN !== 'number') {
    throw createError({ statusCode: 400, message: t.models.errors.badRequest })
  }
  const input: FirstSetup = { thinking: body.thinking, mmproj: ref(body.mmproj), mtp: body.mtp, draft: ref(body.draft), mtpN: body.mtpN }
  const ctx = getContext()
  const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
  try {
    ctx.updateModels((doc) => { applyFirstSetup(doc, model.id, input, entries) })
  } catch (e) {
    editError(e)
  }
  const profile = ctx.getModels().models.find(m => m.id === model.id)?.activeProfile ?? model.activeProfile
  if (body.start === true) background(`start ${model.id}:${profile}`, () => ctx.ops.start({ modelId: model.id, profile }))
  return { ok: true }
})
