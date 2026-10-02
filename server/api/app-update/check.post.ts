// Check this project's Releases for a newer llama-web now.
import { getContext } from '../../service/context'
import { appUpdateError } from '../../service/app-update-api'

export default defineEventHandler(async () => {
  const u = getContext().appUpdate
  try {
    await u.check()
  } catch (e) {
    appUpdateError(e)
  }
  return u.view()
})
