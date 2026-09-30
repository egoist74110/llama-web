// Start a model (its current profile unless { profile } is given). Returns at once; the
// load runs in the background and progress arrives through /api/stream.
import { getContext } from '../../../service/context'
import { background, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown }>(event)
  const profile = requireProfile(model, body?.profile ?? model.activeProfile)
  background(`start ${model.id}:${profile}`, () => getContext().scheduler.start({ modelId: model.id, profile }))
  return { ok: true }
})
