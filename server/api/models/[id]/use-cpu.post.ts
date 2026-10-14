import { useCpuBuild } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { editError, requireModel, restartIfUp } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: string, restart?: boolean }>(event)
  const ctx = getContext()
  let result!: ReturnType<typeof useCpuBuild>
  try {
    ctx.updateModels(doc => {
      result = useCpuBuild(doc, model.id, body?.profile, ctx.getSettings(), ctx.runtimes.env())
    })
  } catch (e) { editError(e) }
  const restarted = body?.restart === true && restartIfUp(model.id)
  return { ok: true, runtime: result.runtime, deviceCleared: result.deviceCleared, restarted }
})
