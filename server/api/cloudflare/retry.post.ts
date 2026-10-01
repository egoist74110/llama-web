// Continue a failed run from the step that failed.
import { getContext } from '../../service/context'
import { cloudflareError, savedClient } from '../../service/cloudflare-api'

export default defineEventHandler(async () => {
  const api = savedClient()
  try {
    return { job: await getContext().cloudflare.retry(api) }
  } catch (e) {
    cloudflareError(e)
  }
})
