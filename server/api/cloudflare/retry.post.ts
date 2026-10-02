// Continue a failed run from the step that failed.
import { getContext } from '../../service/context'
import { cloudflareError, savedClient } from '../../service/cloudflare-api'

export default defineEventHandler(async () => {
  const api = savedClient()
  try {
    const { cloudflare } = getContext()
    await cloudflare.retry(api)
    return cloudflare.view()
  } catch (e) {
    cloudflareError(e)
  }
})
