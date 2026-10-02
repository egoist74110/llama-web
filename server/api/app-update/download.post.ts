// Desktop only: download and verify the installer of the offered version (progress in the live state).
import { getContext } from '../../service/context'
import { appUpdateError } from '../../service/app-update-api'

export default defineEventHandler(() => {
  const u = getContext().appUpdate
  try {
    u.startDownload()
  } catch (e) {
    appUpdateError(e)
  }
  return u.view()
})
