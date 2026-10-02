// Desktop only: verify the downloaded installer again and hand it to the shell, which stops the
// service (and every model) and starts the installer. The page asks for confirmation first.
import { getContext } from '../../service/context'
import { appUpdateError } from '../../service/app-update-api'

export default defineEventHandler(async () => {
  const u = getContext().appUpdate
  try {
    await u.install()
  } catch (e) {
    appUpdateError(e)
  }
  return u.view()
})
