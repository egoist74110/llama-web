// Scan the enabled model directories: every .gguf with its metadata, and whether it is
// already enabled as a model. Reads headers only, so it is safe to call repeatedly.
import { scanModelDirs } from '../core/scanner'
import { enabledIdOf } from '../core/models-admin'
import { getContext } from '../service/context'

export default defineEventHandler(async () => {
  const ctx = getContext()
  const { entries, warnings } = await scanModelDirs(ctx.getSettings().modelDirs)
  const models = ctx.getModels()
  return {
    scannedAt: Date.now(),
    dirs: ctx.getSettings().modelDirs.filter(d => d.enabled).length,
    warnings,
    entries: entries.map(e => ({ ...e, enabledAs: enabledIdOf(models, e.ref) })),
  }
})
