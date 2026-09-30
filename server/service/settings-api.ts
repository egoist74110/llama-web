// Shared by the settings routes: the document the settings page works with.
import { DEFAULT_LAUNCH_DEFAULTS } from '../core/args'
import { fmt, t } from '../core/i18n'
import { dirStatus, SettingsError, type SettingsDoc } from '../core/settings-admin'
import { getContext } from './context'

export function describeSettings(): SettingsDoc {
  const ctx = getContext()
  const s = ctx.getSettings()
  return {
    modelDirs: s.modelDirs.map(d => ({ ...d, ...dirStatus(d) })),
    defaults: s.defaults,
    builtinDefaults: DEFAULT_LAUNCH_DEFAULTS,
    image: s.preprocess.image,
    server: {
      port: s.server.port,
      portRange: s.scheduler.portRange,
      loadTimeoutSec: s.scheduler.loadTimeoutSec,
      drainTimeoutSec: s.scheduler.drainTimeoutSec,
      maxLoaded: s.scheduler.maxLoaded,
    },
    setupDone: s.setup.done,
    restartRequired: s.server.port !== ctx.bootPort,
    bootPort: ctx.bootPort,
  }
}

/** Turn a validation failure into an HTTP error with a Chinese message; other errors pass through. */
export function settingsError(e: unknown): never {
  if (e instanceof SettingsError) {
    const errors = t.settings.errors as Record<string, string>
    const status = e.code === 'dir-in-use' ? 409 : 400
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail: e.detail }) })
  }
  throw e
}
