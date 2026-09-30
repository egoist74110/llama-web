// Manual retry of a failed / crashed profile: { profile? } (defaults to the current profile).
import { getContext } from '../../../service/context'
import { background, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown }>(event)
  const profile = requireProfile(model, body?.profile ?? model.activeProfile)
  background(`retry ${model.id}:${profile}`, () => getContext().scheduler.retry({ modelId: model.id, profile }))
  return { ok: true }
})
