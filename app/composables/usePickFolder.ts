// "Choose folder…" button: the server opens the native Windows dialog on this machine.
import t from '~~/i18n/zh-CN'

export function usePickFolder() {
  const toast = useToast()
  const picking = ref(false)

  /** The chosen path, or null when cancelled or failed (failures show a toast). */
  async function pick(): Promise<string | null> {
    if (picking.value) return null
    picking.value = true
    try {
      return (await $fetch<{ path: string | null }>('/api/fs/pick-folder', { method: 'POST', body: {} })).path
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      toast.add({ title: t.settings.dirs.pick, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
      return null
    } finally {
      picking.value = false
    }
  }
  return { picking, pick }
}
