// Open the native folder dialog on this machine and return the chosen path ({ path: null } = cancelled).
// Only for pages opened through a loopback address: the dialog appears on the server's own screen,
// so a request from another computer on the LAN must not trigger it.
import { isLoopbackHost, pickFolder } from '../../core/folder-picker'
import { t } from '../../core/i18n'

export default defineEventHandler(async (event) => {
  if (!isLoopbackHost(getRequestHeader(event, 'host'))) throw createError({ statusCode: 403, message: t.settings.dirs.pickLocalOnly })
  if (process.platform !== 'win32') throw createError({ statusCode: 501, message: t.settings.dirs.pickUnsupported })
  try {
    return { path: await pickFolder({ title: t.settings.dirs.pickTitle }) }
  } catch (e) {
    throw createError({ statusCode: 500, message: `${t.settings.dirs.pickFailed}${(e as Error).message}` })
  }
})
