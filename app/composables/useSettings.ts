// The settings document (GET /api/settings) shared by the settings page and the setup wizard,
// and the one place that saves a patch and reports the outcome.
import { acceptSettingsRev, applyUiLocale, t } from './useLocale'
import type { SettingsDoc } from '~~/server/core/settings-admin'

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

// How many times a load re-reads when every answer turns out to be older than what the page holds.
const MAX_LOAD_ATTEMPTS = 3

export function useSettings() {
  const toast = useToast()
  const doc = useState<SettingsDoc | null>('settings-doc', () => null)
  const saving = useState<string>('settings-saving', () => '')
  const loadError = useState<string>('settings-load-error', () => '')

  async function load() {
    try {
      // A response older than what the page already applied (a save or a snapshot overtook it) is dropped
      // and read again, so an old document never switches the language back.
      for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
        const fresh = await $fetch<SettingsDoc>('/api/settings')
        if (!acceptSettingsRev(fresh.rev, fresh.boot)) continue
        doc.value = fresh
        // The document carries the saved language, so the page shows it even before the next snapshot.
        applyUiLocale(fresh.ui)
        loadError.value = ''
        return
      }
      // Settings kept changing under the load: say so instead of leaving the page empty.
      loadError.value = t.settings.loadStale
    } catch (e) {
      loadError.value = messageOf(e)
    }
  }

  /** Save a patch; `section` names the card that shows the spinner. Returns whether it was saved. */
  async function save(section: string, patch: object, opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (saving.value) return false
    saving.value = section
    try {
      const saved = await $fetch<SettingsDoc>('/api/settings', { method: 'POST', body: patch })
      if (acceptSettingsRev(saved.rev, saved.boot)) {
        doc.value = saved
        // A language saved here takes effect on this page at once; the live snapshot carries it to the others.
        applyUiLocale(saved.ui)
      } else {
        // The save went through, but another page saved after it: this answer is already old. Fetch the current document.
        void load()
      }
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
