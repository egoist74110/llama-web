// Check the saved API token again and list the zones (domains) it can use.
import { inspect } from '../../core/cloudflare'
import { cloudflareError, savedClient, tokenView } from '../../service/cloudflare-api'

export default defineEventHandler(async () => {
  const api = savedClient()
  try {
    return { ...tokenView(), inspection: await inspect(api) }
  } catch (e) {
    cloudflareError(e)
  }
})
