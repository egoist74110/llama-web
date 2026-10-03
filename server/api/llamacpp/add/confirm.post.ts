// Register the previewed build: { stageId, label?, acceptUnverified? }.
import { getContext } from '../../../service/context'
import { describeLlamacpp, runtimeError } from '../../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const b = await readBody<Record<string, unknown>>(event)
  const ctx = getContext()
  try {
    const entry = ctx.runtimeAdd.confirm(String(b?.stageId ?? ''), {
      label: typeof b?.label === 'string' ? b.label : undefined, acceptUnverified: b?.acceptUnverified === true,
    })
    ctx.live.notify()
    return { entry, ...describeLlamacpp() }
  } catch (e) {
    runtimeError(e)
  }
})
