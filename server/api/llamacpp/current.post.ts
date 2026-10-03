// Switch the current llama.cpp version: { tag, channel? } (rollback; the page asks for confirmation first).
// Without `channel` (or with the main one) it is the main channel; `channel` of the other channel on a
// Windows host switches that one instead.
// Running models keep their process; the next load uses the chosen version.
import { t } from '../../core/i18n'
import { getContext } from '../../service/context'
import { describeLlamacpp, runtimeError } from '../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    const ctx = getContext()
    if (body?.channel !== undefined && body.channel !== ctx.runtimeTarget.acceleration) {
      if (!ctx.secondary || body.channel !== ctx.secondary.accel) throw createError({ statusCode: 400, message: t.llamacpp.errors['bad-channel'] })
      ctx.runtimes.useCurrent(ctx.secondary.accel, body?.tag)
    } else ctx.updater.use(body?.tag)
  } catch (e) {
    runtimeError(e)
  }
  return describeLlamacpp()
})
