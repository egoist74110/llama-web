// Follow explicit starts through the shared live feed: HTTP only acknowledges the background job.
import { t } from './useLocale'
import type { ActivityEvent } from '~~/server/core/live'

interface Attempt {
  token: number
  modelId: string
  profile: string | undefined
  name: string
  after: number
  since: number | null | undefined
  accepted: boolean
}

export interface ModelStartNotice {
  modelId?: string
  profile?: string
  name: string
  kind: string
  message?: string
}

export function useModelStartFeedback() {
  const { state, events } = useLive()
  const guard = useStartGuard()
  const pending = useState<Record<string, Attempt>>('model-start-pending', () => ({}))
  const notices = useState<ModelStartNotice[]>('model-start-notices', () => [])
  const seq = useState('model-start-seq', () => 0)
  const notice = computed(() => notices.value[0] ?? null)

  function cancel(modelId: string) {
    const { [modelId]: _old, ...rest } = pending.value
    pending.value = rest
  }

  function begin(modelId: string, profile?: string): Attempt {
    const model = state.value?.models.find(m => m.id === modelId)
    const selected = profile ?? model?.activeProfile
    const attempt: Attempt = {
      token: ++seq.value, modelId, profile: selected, name: model?.name ?? modelId,
      after: Math.max(0, ...events.value.map(e => e.id)),
      since: model?.instances.find(i => i.profile === selected)?.since,
      accepted: false,
    }
    pending.value = { ...pending.value, [modelId]: attempt }
    return attempt
  }

  function show(attempt: Attempt, kind: string, message?: string) {
    if (pending.value[attempt.modelId]?.token !== attempt.token) return
    cancel(attempt.modelId)
    notices.value = [...notices.value, { modelId: attempt.modelId, profile: attempt.profile, name: attempt.name, kind, message }]
  }

  // A start the memory check refused after the request was accepted (the answer changed while it waited, or it came from a
  // profile switch / restart that asked nobody) becomes the usual start dialog; risky / unknown can be confirmed there.
  let seenNoRoom: number | null = null
  function refused(e: Extract<ActivityEvent, { kind: 'no-room' }>) {
    const p = pending.value[e.modelId]
    if (p) cancel(e.modelId)
    const reason = e.reason === 'memory' ? 'nofit' : e.reason === 'unconfirmed' ? (e.tier ?? 'risky') : e.reason === 'limit' || e.reason === 'unknown' ? e.reason : null
    if (!reason) return
    const model = state.value?.models.find(m => m.id === e.modelId)
    guard.open({
      modelId: e.modelId, profile: e.profile, name: model?.name ?? e.modelId, action: 'start',
      guard: { reason, limit: null, estimateMiB: e.estimateMiB, availableMiB: e.availableMiB, pool: e.pool },
    })
  }

  function receive(list: ActivityEvent[]) {
    // The first batch is history (a reconnect sends history too): only later no-room events open a dialog.
    if (seenNoRoom === null) seenNoRoom = Math.max(0, ...list.map(e => e.id))
    // Only events newer than the user's action belong to it.
    for (const e of [...list].sort((a, b) => a.id - b.id)) {
      if (e.kind === 'no-room' && e.manual && e.id > seenNoRoom) {
        seenNoRoom = e.id
        if (Date.now() - e.at < 30_000) refused(e) // an old one replayed after a reconnect is history
        continue
      }
      if (e.kind !== 'state') continue
      const p = pending.value[e.modelId]
      if (!p || e.id <= p.after || (p.profile !== undefined && e.profile !== p.profile)) continue
      if (e.error && (e.to === 'failed' || e.to === 'crashed' || e.to === 'stopped')) show(p, e.error)
      else if (e.to === 'ready' || e.to === 'stopped') cancel(p.modelId)
    }
  }

  function reconcile() {
    if (!state.value) return
    for (const p of Object.values(pending.value)) {
      if (!p.accepted) continue
      const model = state.value.models.find(m => m.id === p.modelId)
      if (!model) { cancel(p.modelId); continue }
      const inst = model.instances.find(i => i.profile === p.profile)
      if (inst?.state === 'ready') cancel(p.modelId)
      // Snapshot fallback for a lost event. An old failed mark must not fail a new retry.
      else if (inst && inst.since !== p.since && (inst.state === 'failed' || inst.state === 'crashed')) {
        show(p, inst.failure?.kind ?? inst.error ?? 'unknown')
      }
    }
  }

  function accepted(attempt: Attempt) {
    const p = pending.value[attempt.modelId]
    if (!p || p.token !== attempt.token) return
    pending.value = { ...pending.value, [p.modelId]: { ...p, accepted: true } }
    reconcile()
  }

  function httpFailure(error: unknown, attempt?: Attempt, name = '') {
    const err = error as { data?: { message?: string }, message?: string }
    const message = err?.data?.message ?? err?.message ?? String(error)
    const kind = message === t.models.errors.modelNotFound ? 'model-missing'
      : message === t.models.errors.profileNotFound ? 'profile-missing' : 'unknown'
    if (attempt) show(attempt, kind, message)
    else notices.value = [...notices.value, { name, kind, message }]
  }

  // Installed once by the layout's modal; Vue disposes both watchers when it unmounts.
  function follow() {
    watch(events, receive, { immediate: true, flush: 'sync' })
    watch(state, reconcile, { flush: 'sync' })
  }

  return { notice, begin, accepted, httpFailure, cancel, follow, dismiss: () => { notices.value = notices.value.slice(1) } }
}
