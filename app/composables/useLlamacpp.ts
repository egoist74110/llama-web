// Switching the current llama.cpp version (rollback). One confirmation dialog for the whole app
// (LlamacppSwitchModal in the layout); the settings card and the failure card only ask for it.
import t from '~~/i18n/zh-CN'

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

export function useLlamacpp() {
  const toast = useToast()
  /** Version waiting for confirmation; null when the dialog is closed. */
  const pending = useState<string | null>('llamacpp-pending', () => null)
  const busy = useState<boolean>('llamacpp-busy', () => false)

  const ask = (tag: string) => { pending.value = tag }

  async function confirm() {
    const tag = pending.value
    if (!tag || busy.value) return
    busy.value = true
    try {
      // The live snapshot picks up the new current version by itself.
      await $fetch('/api/llamacpp/current', { method: 'POST', body: { tag } })
      toast.add({ title: fmt(t.llamacpp.switched, { tag }), color: 'success', icon: 'i-lucide-check' })
      pending.value = null
    } catch (e) {
      toast.add({ title: t.llamacpp.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    } finally {
      busy.value = false
    }
  }

  return { pending, busy, ask, confirm }
}
