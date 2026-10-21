// The model's own knowledge binding (decision 65 ⑨): { knowledge: { enabled, all, kbs, mode, topK } | null }.
// null turns it off. Applied per request, so the model is never restarted. A profile's own binding wins over this.
import { ProfileError, sanitizeKnowledge, setModelKnowledge } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { editError, requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ knowledge?: unknown }>(event)
  const ctx = getContext()
  try {
    const binding = sanitizeKnowledge(body?.knowledge ?? null)
    const kbIds = ctx.getKnowledge().bases.map(b => b.id)
    ctx.updateModels((doc) => { setModelKnowledge(doc, model.id, binding, kbIds) })
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
  return { ok: true, model: requireModel(model.id) }
})
