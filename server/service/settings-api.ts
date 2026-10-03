// Shared by the settings routes: the document the settings page works with.
import { DEFAULT_LAUNCH_DEFAULTS } from '../core/args'
import { DEFAULT_CPU_DEFAULTS, hasCpuChannel } from '../core/config'
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { existsSync } from 'node:fs'
import { cloudflaredPath, findCloudflared, maskToken, TunnelError } from '../core/tunnel'
import { dirStatus, SettingsError, type SettingsDoc } from '../core/settings-admin'
import { getContext } from './context'

/** What the page may know about the saved tunnel token. */
export function tunnelTokenView(token: string): { hasToken: boolean, maskedToken: string | null } {
  return token ? { hasToken: true, maskedToken: maskToken(token) } : { hasToken: false, maskedToken: null }
}

/** Where cloudflared would come from if the tunnel started now (file checks only, no process). */
function cloudflaredState(dataDir: string): SettingsDoc['public']['cloudflared'] {
  const own = cloudflaredPath(dataDir)
  if (existsSync(own)) return 'runtime'
  return findCloudflared({ skip: [own] }) ? 'system' : 'none'
}

export function describeSettings(): SettingsDoc {
  const ctx = getContext()
  const s = ctx.getSettings()
  return {
    modelDirs: s.modelDirs.map(d => ({ ...d, ...dirStatus(d) })),
    defaults: s.defaults,
    builtinDefaults: DEFAULT_LAUNCH_DEFAULTS,
    ...(hasCpuChannel(ctx.platform) ? { defaultsCpu: s.defaultsCpu, builtinDefaultsCpu: DEFAULT_CPU_DEFAULTS } : {}),
    image: s.preprocess.image,
    server: {
      port: s.server.port,
      portRange: s.scheduler.portRange,
      loadTimeoutSec: s.scheduler.loadTimeoutSec,
      drainTimeoutSec: s.scheduler.drainTimeoutSec,
      maxLoaded: s.scheduler.maxLoaded,
    },
    public: {
      ...s.public,
      status: ctx.publicEntry.status(),
      activeKeys: ctx.getSecrets().apiKeys.filter(k => !k.revoked).length,
      tunnel: tunnelTokenView(ctx.getSecrets().tunnelToken),
      cloudflared: cloudflaredState(ctx.dataDir),
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

/** Turn a tunnel token / store failure into an HTTP error with a Chinese message (never echoing the input). */
export function tunnelError(e: unknown): never {
  const errors = t.tunnel.errors
  if (e instanceof TunnelError) throw createError({ statusCode: 400, message: errors['bad-token'] })
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(errors.store, { detail: e.message }) })
  throw e
}
