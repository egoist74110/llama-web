// First download of the other channel (CPU beside CUDA on Windows): { channel: 'cpu' | 'cuda' }. Runs in
// the background; its progress is in `secondary.status` of GET /api/llamacpp. Later updates follow automatically.
import { t } from '../../core/i18n'
import { getContext } from '../../service/context'
import { describeLlamacpp } from '../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  if (!ctx.secondary || body?.channel !== ctx.secondary.accel) throw createError({ statusCode: 400, message: t.llamacpp.errors['bad-channel'] })
  if (ctx.secondary.updater.getStatus().state !== 'working') void ctx.downloadSecondary()
  return describeLlamacpp()
})
