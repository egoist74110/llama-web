// Everything the edit drawer needs: the model's saved configuration, the global defaults
// (what "inherit" means), the importable chat templates, which profiles are up right now and
// which cannot be renamed / deleted (also queued or about to be restarted onto).
import { defaultsFor } from '../../../core/config'
import { effectiveRuntime } from '../../../core/launch'
import { listTemplates } from '../../../core/models-admin'
import { getContext } from '../../../service/context'
import { requireModel, requireProfile, upProfiles } from '../../../service/models-api'

export default defineEventHandler((event) => {
  const model = requireModel(getRouterParam(event, 'id'))
  const ctx = getContext()
  const profile = requireProfile(model, getQuery(event).profile ?? model.activeProfile)
  const settings = ctx.getSettings()
  return {
    model,
    effectiveRuntime: effectiveRuntime(model, model.profiles[profile]!.runtime, {
      dataDir: ctx.dataDir, settings, platform: ctx.platform.os,
      target: ctx.runtimeTarget, runtimeEnv: ctx.runtimes.env(),
    }),
    // What "inherit" means: the defaults of the main channel (the form does not know yet which build a profile will pick).
    defaults: defaultsFor(settings, ctx.platform, ctx.runtimeTarget.acceleration),
    templates: listTemplates(ctx.dataDir),
    up: upProfiles(model.id),
    inUse: ctx.ops.inUseProfiles(model.id),
  }
})
