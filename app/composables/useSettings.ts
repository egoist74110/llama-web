// The settings document (GET /api/settings) shared by the settings page and the setup wizard,
// and the one place that saves a patch and reports the outcome.
import { applyUiLocale, t } from './useLocale'
import type { SettingsDoc } from '~~/server/core/settings-admin'

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

export function useSettings() {
  const toast = useToast()
  const doc = useState<SettingsDoc | null>('settings-doc', () => null)
  const saving = useState<string>('settings-saving', () => '')
  const loadError = useState<string>('settings-load-error', () => '')

  async function load() {
    try {
      doc.value = await $fetch<SettingsDoc>('/api/settings')
      // The document carries the saved language, so the page shows it even before the next snapshot.
      applyUiLocale(doc.value.ui)
      loadError.value = ''
    } catch (e) {
      loadError.value = messageOf(e)
    }
  }

  /** Save a patch; `section` names the card that shows the spinner. Returns whether it was saved. */
  async function save(section: string, patch: object, opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (saving.value) return false
    saving.value = section
    try {
      doc.value = await $fetch<SettingsDoc>('/api/settings', { method: 'POST', body: patch })
      // A language saved here takes effect on this page at once; the live snapshot carries it to the others.
      applyUiLocale(doc.value.ui)
      if (!opts.quiet) toast.add({ title: t.settings.saved, color: 'success', icon: 'i-lucide-check' })
      return true
    } catch (e) {
      toast.add({ title: t.settings.saveFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
      return false
    } finally {
      saving.value = ''
    }
  }

  return { doc, saving, loadError, load, save }
}
