// Log files on disk: model output per start (by model), event and request files per day.
import { getContext } from '../../service/context'

export default defineEventHandler(() => {
  const ctx = getContext()
  const names = new Map(ctx.getModels().models.map(m => [m.id, m.name]))
  const listing = ctx.logs.list()
  return {
    ...listing,
    models: listing.models.map(m => ({ ...m, name: names.get(m.model) ?? m.model })),
  }
})
