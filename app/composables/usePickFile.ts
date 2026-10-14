// "Choose program…" button: the server opens the native file dialog (Windows or macOS) on this machine.
import { t } from './useLocale'

export function usePickFile() {
  const toast = useToast()
  const picking = ref(false)

  /** The chosen file path, or null when cancelled or failed (failures show a toast). */
  async function pick(): Promise<string | null> {
    if (picking.value) return null
    picking.value = true
    try {
      return (await $fetch<{ path: string | null }>('/api/fs/pick-file', { method: 'POST', body: {} })).path
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      toast.add({ title: t.llamacpp.manage.addDialog.pickExe, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
      return null
    } finally {
      picking.value = false
    }
  }
  return { picking, pick }
}
