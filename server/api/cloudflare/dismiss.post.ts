// Forget the finished / failed run (keeps everything it changed in the Cloudflare account).
import { getContext } from '../../service/context'
import { cloudflareError } from '../../service/cloudflare-api'

export default defineEventHandler(() => {
  try {
    getContext().cloudflare.dismiss()
    return { job: null }
  } catch (e) {
    cloudflareError(e)
  }
})
