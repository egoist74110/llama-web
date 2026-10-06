// Start a model (its current profile unless { profile } is given). Returns at once; the
// load runs in the background and progress arrives through /api/stream.
import { checkedStart } from '../../../service/admission'
import { getContext } from '../../../service/context'
import { background, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown, confirm?: unknown }>(event)
  const profile = requireProfile(model, body?.profile ?? model.activeProfile)
  // With several models online the interface may need an answer first (limit / does not fit / needs `confirm: true`).
  const confirm = body?.confirm === true
  await checkedStart({ modelId: model.id, profile }, confirm)
  // The final check at load time may differ from this one; `confirmed` tells it whether a risk was accepted.
  background(`start ${model.id}:${profile}`, () => getContext().ops.start({ modelId: model.id, profile }, { confirmed: confirm }))
  return { ok: true }
})
