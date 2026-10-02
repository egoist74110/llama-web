// llama-web's own updates: the state comes from the live snapshot (`appUpdate`); actions call
// /api/app-update. One prompt dialog for the whole app (AppUpdatePrompt in the layout).
import t from '~~/i18n/zh-CN'
import type { AppUpdateView } from '~~/server/core/app-update'

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

export function useAppUpdate() {
  const { state } = useLive()
  const toast = useToast()
  const view = computed<AppUpdateView | null>(() => state.value?.appUpdate ?? null)
  const release = computed(() => (view.value?.check.state === 'available' ? view.value.check.release : null))
  /** Prompt dialog open (layout); `confirming` = the install confirmation step. */
  const open = useState<boolean>('app-update-open', () => false)
  const confirming = useState<boolean>('app-update-confirm', () => false)
  const busy = useState<string | null>('app-update-busy', () => null)

  async function call(action: string, body?: Record<string, unknown>) {
    if (busy.value) return
    busy.value = action
    try {
      await $fetch(`/api/app-update/${action}`, { method: 'POST', ...(body ? { body } : {}) })
    } catch (e) {
      toast.add({ title: t.appUpdate.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
    } finally {
      busy.value = null
    }
  }

  return {
    view, release, open, confirming, busy,
    check: () => call('check'),
    download: () => call('download'),
    cancel: () => call('cancel'),
    install: () => call('install'),
    setAutoCheck: (autoCheck: boolean) => call('prefs', { autoCheck }),
    skip: (version: string | null) => call('prefs', { skipped: version }),
  }
}

export function appUpdateErrorText(code: string): string {
  return (t.appUpdate.errors as Record<string, string>)[code] ?? code
}
