// Save the Cloudflare API token after checking it with Cloudflare: { token }, or { token: '' } to
// clear it. Returns the masked token and what the token can see; never the token itself.
import { cleanApiToken, inspect } from '../../core/cloudflare'
import { getContext } from '../../service/context'
import { clientFor, cloudflareError, tokenView } from '../../service/cloudflare-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    if (typeof body?.token === 'string' && body.token.trim() === '') {
      ctx.updateSecrets((draft) => { draft.cloudflareToken = '' })
      return { ...tokenView(), inspection: null }
    }
    const token = cleanApiToken(body?.token)
    const inspection = await inspect(clientFor(token))
    ctx.updateSecrets((draft) => { draft.cloudflareToken = token })
    return { ...tokenView(), inspection }
  } catch (e) {
    cloudflareError(e)
  }
})
