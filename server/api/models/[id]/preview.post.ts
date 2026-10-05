// Command preview for the edit form: { profile, form?, files? }. Built by the same argument
// builder the launcher uses; `form` / `files` are the (possibly unsaved) values on screen.
import { ProfileError } from '../../../core/models-admin'
import { buildPreview, type PreviewBody } from '../../../service/model-check'
import { editError, requireModel, requireProfile } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<PreviewBody>(event)
  const name = requireProfile(model, body?.profile)
  try {
    return (await buildPreview(model, body, name)).preview
  } catch (e) {
    if (e instanceof ProfileError) editError(e)
    throw e
  }
})
