// Retry preparation or connection; a selected mirror is scoped to this action.
import { getContext } from '../../service/context'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  if (body?.remember === true) ctx.updateSettings(s => { s.network.downloadSource = 'auto' })
  ctx.tunnel.retry({ mirror: typeof body?.mirror === 'string' ? body.mirror : undefined })
  return { ok: true }
})
