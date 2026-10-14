// Open a native file dialog on the server's screen, only for a loopback page.
import { isLoopbackHost, pickFile } from '../../core/folder-picker'
import { t } from '../../core/i18n'

export default defineEventHandler(async (event) => {
  if (!isLoopbackHost(getRequestHeader(event, 'host'))) throw createError({ statusCode: 403, message: t.settings.dirs.pickLocalOnly })
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw createError({ statusCode: 501, message: t.settings.dirs.pickUnsupported })
  try {
    return { path: await pickFile(t.llamacpp.runtimes.pickFile) }
  } catch (e) {
    throw createError({ statusCode: 500, message: `${t.settings.dirs.pickFailed}${(e as Error).message}` })
  }
})
