// Give up a failed run and delete what it created (its new tunnel / DNS record only).
import { getContext } from '../../service/context'
import { cloudflareError, savedClient } from '../../service/cloudflare-api'

export default defineEventHandler(async () => {
  const api = savedClient()
  try {
    const { cloudflare } = getContext()
    await cloudflare.cleanup(api)
    return cloudflare.view()
  } catch (e) {
    cloudflareError(e)
  }
})
