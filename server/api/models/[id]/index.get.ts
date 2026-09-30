// Everything the edit drawer needs: the model's saved configuration, the global defaults
// (what "inherit" means), the importable chat templates, which profiles are up right now and
// which cannot be renamed / deleted (also queued or about to be restarted onto).
import { listTemplates } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { requireModel, upProfiles } from '../../../service/models-api'

export default defineEventHandler((event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const ctx = getContext()
  return {
    model,
    defaults: ctx.getSettings().defaults,
    templates: listTemplates(ctx.dataDir),
    up: upProfiles(model.id),
    inUse: ctx.ops.inUseProfiles(model.id),
  }
})
