// Register the previewed build: { stageId, label?, acceptUnverified? }.
import { entryRunsHere } from '../../../core/runtimes'
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
    return { entry, selectable: entryRunsHere(entry, ctx.runtimeTarget), ...describeLlamacpp() }
  } catch (e) {
    runtimeError(e)
  }
})
