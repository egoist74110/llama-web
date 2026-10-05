// Remove a model: { deleteFiles?: boolean }. Always drops the configuration; with deleteFiles the
// model / mmproj / draft files also go to the system trash (files another model uses are kept).
// A running, loading or queued model is refused, never stopped.
import { removeModel } from '../../../core/model-remove'
import { getContext } from '../../../service/context'
import { removeError, requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ deleteFiles?: unknown }>(event)
  const ctx = getContext()
  try {
    const result = await removeModel({
      ops: ctx.ops,
      getModels: ctx.getModels,
      updateModels: ctx.updateModels,
      dirs: () => ctx.getSettings().modelDirs,
    }, model.id, body?.deleteFiles === true)
    return { ok: true, ...result }
  } catch (e) {
    return removeError(e)
  }
})
