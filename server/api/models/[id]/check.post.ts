// Check of a profile before it is saved (decisions 43, 44), nothing is saved:
//   { profile, form?, files?, fresh? }  one profile, as it is on screen (`form` / `files`) or as saved
//   { all: true, fresh? }               every profile of the model as saved, each calculated on its own
// `fresh` asks the llama.cpp build for its devices again (otherwise the answer of the last minute is used).
// Returns { tier, estimate, params, issues, blocked, online }: the memory tier with its breakdown per memory pool, and the
// parameter findings (`error` = cannot start, `warning` = starts but is probably not what was meant).
import { ProfileError } from '../../../core/models-admin'
import { checkProfile, type PreviewBody } from '../../../service/model-check'
import { editError, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<PreviewBody & { all?: unknown, fresh?: unknown }>(event)
  const fresh = body?.fresh === true
  try {
    if (body?.all === true) {
      const profiles: Record<string, Awaited<ReturnType<typeof checkProfile>>> = {}
      for (const name of Object.keys(model.profiles)) profiles[name] = await checkProfile(model, name, undefined, { fresh: fresh && Object.keys(profiles).length === 0 })
      return { profiles }
    }
    const name = requireProfile(model, body?.profile)
    return { profile: name, ...(await checkProfile(model, name, body, { fresh })) }
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
})
