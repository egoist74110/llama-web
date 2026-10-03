// Explicit download of the main or secondary official channel, regardless of autoUpdate.
import { t } from '../../core/i18n'
import { getContext } from '../../service/context'
import { describeLlamacpp } from '../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  const channel = body?.channel ?? ctx.runtimeTarget.acceleration
  const secondary = ctx.secondary
  const updater = channel === ctx.runtimeTarget.acceleration ? ctx.updater : secondary && secondary.accel === channel ? secondary.updater : null
  if (!updater) throw createError({ statusCode: 400, message: t.llamacpp.errors['bad-channel'] })
  if (updater.getStatus().state === 'working') throw createError({ statusCode: 409, message: t.appUpdate.errors.busy })
  await ctx.getSystem()
  void updater.run({ force: true })
  return describeLlamacpp()
})
