// Startup: create the app context (config stores, residue cleanup, scheduler) and stop all
// models when Nitro closes.
import { getContext } from '../service/context'

export default defineNitroPlugin((nitroApp) => {
  const ctx = getContext()
  nitroApp.hooks.hook('close', () => ctx.shutdown())
})
