// Clipboard-only diagnostics; available through the management API, never the public entry.
import { modelDiagnostics } from '../../../service/diagnostics'
import { requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  return modelDiagnostics(model)
})
