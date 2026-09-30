// Stop a model (every profile): waits for in-flight requests, then unloads. Returns at
// once; use { force: true } to kill it without waiting.
import { getContext } from '../../../service/context'
import { background, requireModel } from '../../../service/models-api'

export default defineEventHandler(async (event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const body = await readBody<{ force?: unknown }>(event)
  background(`stop ${model.id}`, () => getContext().ops.stop(model.id, { force: body?.force === true }))
  return { ok: true }
})
