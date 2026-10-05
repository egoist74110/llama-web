// The dialog of a manual start the server did not simply allow (HTTP 409, decisions 41-42): shared state, opened by
// useModelActions and shown by StartGuardModal in the layout.
import type { StartGuard } from '~/utils/memory-check'

export interface PendingGuard {
  modelId: string
  profile: string | undefined
  name: string
  action: 'start' | 'retry'
  guard: StartGuard
}

export function useStartGuard() {
  const pending = useState<PendingGuard | null>('start-guard', () => null)
  return { pending, open: (g: PendingGuard) => { pending.value = g }, close: () => { pending.value = null } }
}
