// What removing the model together with its files would do: which files go to the trash, which
// are kept because another model uses them. Read-only; nothing is touched.
import { planRemove, RemoveError } from '../../../core/model-remove'
import { getContext } from '../../../service/context'
import { removeError, requireModel } from '../../../service/models-api'

export default defineEventHandler((event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const ctx = getContext()
  const busy = ctx.ops.busy(model.id)
  try {
    const plan = planRemove(ctx.getModels(), ctx.getSettings().modelDirs, model.id)
    return { busy, files: plan.files.map(f => ({ kind: f.kind, rel: f.ref.rel, action: f.action, usedBy: f.usedBy })), unsafe: false }
  } catch (e) {
    // Files outside every registered directory: only "remove the configuration" is offered.
    if (e instanceof RemoveError && e.code === 'outside-dir') return { busy, files: [], unsafe: true }
    return removeError(e)
  }
})
