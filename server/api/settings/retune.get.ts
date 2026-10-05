// Preview of "recommend again for this machine": the global launch defaults that would change
// (old -> recommended) with the hardware detected now. Read-only; nothing is written.
import { planRetune } from '../../core/retune'
import { getContext } from '../../service/context'

export default defineEventHandler(async () => {
  const ctx = getContext()
  const info = await ctx.getSystem({ refresh: true })
  return planRetune(ctx.getSettings(), info, ctx.platform)
})
