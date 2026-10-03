// The model's own device: { device: 'auto' | 'cpu' | '<id>' | null, restart? }. null follows the global default.
// A profile's own choice (profiles.post `save` with form.device) wins over this. Refused on a Mac.
import { hasDeviceSelection } from '../../../core/config'
import { ProfileError, sanitizeDevice, setModelDevice } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { editError, requireModel, restartIfUp } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ device?: unknown, restart?: unknown }>(event)
  const ctx = getContext()
  try {
    const device = sanitizeDevice(body?.device ?? null)
    ctx.updateModels((doc) => { setModelDevice(doc, model.id, device, () => hasDeviceSelection(ctx.platform)) })
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
  const restarted = body?.restart === true && restartIfUp(model.id)
  return { ok: true, restarted }
})
