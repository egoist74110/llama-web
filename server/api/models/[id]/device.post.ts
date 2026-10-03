// The model's own device choice: { device: 'auto' | 'cpu' | '<id>' | null, devices?, splitMode?, tensorSplit?, mainGpu?, restart? }.
// Empty / null follows the global default; `devices` (two or more ids) is a GPU group with its split settings (decision 45).
// A profile's own choice (profiles.post `save`) wins over this. Refused on a Mac.
import { hasDeviceSelection } from '../../../core/config'
import { ProfileError, sanitizeGpu, setModelGpu } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { editError, requireModel, restartIfUp } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<Record<string, unknown>>(event)
  const ctx = getContext()
  try {
    const choice = sanitizeGpu(body ?? {})
    ctx.updateModels((doc) => { setModelGpu(doc, model.id, choice, () => hasDeviceSelection(ctx.platform)) })
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
  const restarted = body?.restart === true && restartIfUp(model.id)
  return { ok: true, restarted }
})
