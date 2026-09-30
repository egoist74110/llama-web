// Change the model's current profile: { profile }. A model that is loading or running is
// restarted on the new profile (a profile change is a restart); a stopped or failed one only
// has its current profile changed (failed / crashed marks are cleared).
import { getContext } from '../../../service/context'
import { switchProfile } from '../../../core/models-admin'
import { background, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown }>(event)
  const profile = requireProfile(model, body?.profile)
  const ctx = getContext()
  if (profile === model.activeProfile) return { ok: true, restarted: false }

  ctx.updateModels((doc) => { switchProfile(doc, model.id, profile) })
  // A restart still waiting for the old process is superseded by this one (see ModelOps).
  const { restarted, work } = ctx.ops.switchTo(model.id, profile)
  if (work) background(`${restarted ? 'restart' : 'clear'} ${model.id}:${profile}`, () => work)
  return { ok: true, restarted }
})
