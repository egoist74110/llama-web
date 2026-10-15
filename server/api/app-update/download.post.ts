// Desktop only: download and verify the installer of the offered version (progress in the live state).
import { getContext } from '../../service/context'
import { appUpdateError } from '../../service/app-update-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  if (body?.remember === true) ctx.updateSettings(s => { s.network.downloadSource = 'auto' })
  const u = ctx.appUpdate
  try {
    u.startDownload({ mirror: typeof body?.mirror === 'string' ? body.mirror : undefined })
  } catch (e) {
    appUpdateError(e)
  }
  return u.view()
})
