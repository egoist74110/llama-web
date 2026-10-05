// Memory checks of saved profiles (POST /api/models/:id/check), shared by the model rows, the online list and the GPU cards
// on the overview. Requests go one after another (each one reads the model's file and the machine's memory), an answer
// younger than `FRESH_MS` is reused, and a change of what is online (which changes the free memory) asks again.
import { ONLINE_STATES, onlineSignature, type CheckDoc } from '~/utils/memory-check'

const FRESH_MS = 15_000

export const checkKey = (modelId: string, profile: string) => `${modelId}\u0000${profile}`

// One queue for the whole page; the answers live in useState so every component sees them.
let chain: Promise<void> = Promise.resolve()
const inflight = new Set<string>()

export function useMemoryChecks() {
  const { state } = useLive()
  const docs = useState<Record<string, CheckDoc | null>>('memory-checks', () => ({}))
  const at = useState<Record<string, number>>('memory-checks-at', () => ({}))

  function request(modelId: string, profile: string, force = false) {
    const key = checkKey(modelId, profile)
    if (inflight.has(key) || (!force && Date.now() - (at.value[key] ?? 0) < FRESH_MS)) return
    inflight.add(key)
    chain = chain.then(async () => {
      try {
        const r = await $fetch<CheckDoc>(`/api/models/${encodeURIComponent(modelId)}/check`, { method: 'POST', body: { profile } })
        docs.value = { ...docs.value, [key]: r }
      } catch {
        // The chip simply stays away; the edit drawer shows its own error.
        docs.value = { ...docs.value, [key]: null }
      } finally {
        at.value = { ...at.value, [key]: Date.now() }
        inflight.delete(key)
      }
    })
  }

  const get = (modelId: string, profile: string): CheckDoc | null => docs.value[checkKey(modelId, profile)] ?? null

  /** Ask for the checks of the models that are online now, and again whenever that set changes. */
  function followOnline() {
    watch(() => onlineSignature(state.value), () => {
      for (const m of state.value?.models ?? []) for (const i of m.instances) if (ONLINE_STATES.includes(i.state)) request(m.id, i.profile, true)
    }, { immediate: true })
  }

  /** Ask for one model's active profile, and again when the online set changes. */
  function followModel(modelId: () => string, profile: () => string) {
    watch(() => [modelId(), profile(), onlineSignature(state.value)].join('\u0001'), (_, prev) => {
      request(modelId(), profile(), prev !== undefined)
    }, { immediate: true })
  }

  return { get, request, followOnline, followModel }
}
