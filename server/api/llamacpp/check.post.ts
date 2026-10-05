// Explicit checks fetch release metadata of the main and installed secondary channels.
import { getContext } from '../../service/context'
import { describeLlamacpp } from '../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const mirror = typeof body?.mirror === 'string' ? body.mirror : undefined
  const ctx = getContext()
  await ctx.getSystem()
  await Promise.all([
    ctx.updater.run({ manual: true, mirror }),
    ...(ctx.secondary?.updater.refresh().length ? [ctx.secondary.updater.run({ manual: true, mirror })] : []),
  ])
  return describeLlamacpp()
})
