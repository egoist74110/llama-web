// Snapshot for the status page: enabled models with their scheduler state, queue and llama.cpp.
import { getContext } from '../service/context'

export default defineEventHandler(() => {
  const ctx = getContext()
  const snap = ctx.scheduler.snapshot()
  const settings = ctx.getSettings()
  const errorText = (e: unknown) => (e ? String((e as { code?: string }).code ?? (e as Error).message ?? e) : null)
  return {
    models: ctx.getModels().models.map((m) => {
      const running = snap.models.filter(s => s.modelId === m.id && s.state !== 'stopped')
      return {
        id: m.id,
        name: m.name,
        activeProfile: m.activeProfile,
        profiles: Object.keys(m.profiles),
        hasMmproj: !!m.mmproj,
        instances: running.map(s => ({
          profile: s.profile, state: s.state, inflight: s.inflight, error: errorText(s.error),
        })),
      }
    }),
    queue: snap.queue.map(q => ({ modelId: q.modelId, profile: q.profile, started: q.started, waiting: q.waiting })),
    llamacpp: { current: settings.llamacpp.current, runtime: ctx.getRuntimeStatus() },
  }
})
