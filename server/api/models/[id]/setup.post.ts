// Save the first-start answers { ctxSize?, setGlobalContext?, setGlobalThinking?, setGlobalThinkingLimit?, thinking, thinkingLimit?, mmproj, mtp, draft, mtpN, start? } into the model's
// current profile and files, mark the model confirmed, and optionally start it.
import { type FirstSetup } from '../../../core/models-admin'
import { saveFirstSetup } from '../../../core/first-setup'
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
  const input: FirstSetup = { thinking: body.thinking, thinkingLimit: body.thinkingLimit as FirstSetup['thinkingLimit'], mmproj: ref(body.mmproj), mmprojOffload: body.mmprojOffload as FirstSetup['mmprojOffload'], mtp: body.mtp, mtpMode: body.mtpMode as FirstSetup['mtpMode'], draft: ref(body.draft), mtpN: body.mtpN,
    ctxSize: body.ctxSize as FirstSetup['ctxSize'], setGlobalContext: body.setGlobalContext as FirstSetup['setGlobalContext'],
    setGlobalThinking: body.setGlobalThinking as FirstSetup['setGlobalThinking'], setGlobalThinkingLimit: body.setGlobalThinkingLimit as FirstSetup['setGlobalThinkingLimit'] }
  const ctx = getContext()
  const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
  try {
    saveFirstSetup(ctx, model.id, input, entries, ctx.platform)
  } catch (e) {
    editError(e)
  }
  const profile = ctx.getModels().models.find(m => m.id === model.id)?.activeProfile ?? model.activeProfile
  if (body.start === true) background(`start ${model.id}:${profile}`, () => ctx.ops.start({ modelId: model.id, profile }))
  return { ok: true }
})
