// Throw away the staged preview: { stageId? }.
import { getContext } from '../../../service/context'

export default defineEventHandler(async (event) => {
  const b = await readBody<Record<string, unknown>>(event)
  getContext().runtimeAdd.cancel(typeof b?.stageId === 'string' ? b.stageId : undefined)
  return { ok: true }
})
