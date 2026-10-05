// Manual retry of a failed / crashed profile: { profile? } (defaults to the current profile).
import { checkedStart } from '../../../service/admission'
import { getContext } from '../../../service/context'
import { background, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown, confirm?: unknown }>(event)
  const profile = requireProfile(model, body?.profile ?? model.activeProfile)
  // With several models online the interface may need an answer first (limit / does not fit / needs `confirm: true`).
  await checkedStart({ modelId: model.id, profile }, body?.confirm === true)
  background(`retry ${model.id}:${profile}`, () => getContext().ops.retry({ modelId: model.id, profile }))
  return { ok: true }
})
