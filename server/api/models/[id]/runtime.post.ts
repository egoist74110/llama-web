// The model's own llama.cpp build: { runtime: '<ref>' | null, restart? }. null follows the global version.
// Only builds of this computer can be chosen. A profile's own choice (profiles.post `save` with form.runtime) wins over this.
import { ProfileError, sanitizeRuntimeRef, setModelRuntime } from '../../../core/models-admin'
import { selectableHere } from '../../../core/runtimes'
import { getContext } from '../../../service/context'
import { editError, requireModel, restartIfUp } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ runtime?: unknown, restart?: unknown }>(event)
  const ctx = getContext()
  try {
    const ref = sanitizeRuntimeRef(body?.runtime ?? null)
    const env = ctx.runtimes.env()
    ctx.updateModels((doc) => { setModelRuntime(doc, model.id, ref, r => selectableHere(r, env)) })
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
  const restarted = body?.restart === true && restartIfUp(model.id)
  return { ok: true, restarted }
})
