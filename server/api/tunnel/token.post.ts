// Save or clear the Cloudflare tunnel token: { token } (the bare token or the whole command the
// Cloudflare page shows) or { token: '' } to clear it. The response never contains the token.
import { extractToken } from '../../core/tunnel'
import { getContext } from '../../service/context'
import { describeSettings, tunnelError, tunnelTokenView } from '../../service/settings-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const clear = typeof body?.token === 'string' && body.token.trim() === ''
    const token = clear ? '' : extractToken(body?.token)
    ctx.updateSecrets((draft) => { draft.tunnelToken = token })
  } catch (e) {
    tunnelError(e)
  }
  return { ...tunnelTokenView(ctx.getSecrets().tunnelToken), settings: describeSettings() }
})
