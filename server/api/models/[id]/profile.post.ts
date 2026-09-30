// Change the model's current profile: { profile }. A model that is loading or running is
// restarted on the new profile (a profile change is a restart); a stopped or failed one only
// has its current profile changed (failed / crashed marks are cleared).
import { getContext } from '../../../service/context'
import { switchProfile } from '../../../core/models-admin'
import { background, requireModel, requireProfile } from '../../../service/models-api'

const ACTIVE = new Set(['loading', 'ready', 'draining', 'unloading'])

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ profile?: unknown }>(event)
  const profile = requireProfile(model, body?.profile)
  const ctx = getContext()
  if (profile === model.activeProfile) return { ok: true, restarted: false }

  const mine = ctx.scheduler.snapshot().models.filter(s => s.modelId === model.id)
  const up = mine.filter(s => ACTIVE.has(s.state))
  // Something is up on another profile -> restart; already up on this one -> leave it running.
  const restart = up.some(s => s.profile !== profile)
  ctx.updateModels((doc) => { switchProfile(doc, model.id, profile) })
  if (restart) {
    background(`restart ${model.id}:${profile}`, async () => {
      await ctx.scheduler.stop(model.id)
      await ctx.scheduler.start({ modelId: model.id, profile })
    })
  } else if (mine.length && !up.length) {
    background(`clear ${model.id}`, () => ctx.scheduler.stop(model.id))
  }
  return { ok: true, restarted: restart }
})
