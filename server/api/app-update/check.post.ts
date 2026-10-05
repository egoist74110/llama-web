// Check this project's Releases for a newer llama-web now.
import { getContext } from '../../service/context'
import { appUpdateError } from '../../service/app-update-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const u = getContext().appUpdate
  try {
    await u.check({ manual: true, mirror: typeof body?.mirror === 'string' ? body.mirror : undefined })
  } catch (e) {
    appUpdateError(e)
  }
  return u.view()
})
