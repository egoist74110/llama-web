// The llama.cpp document of the settings page (GET /api/llamacpp): the builds of this computer
// with their channels, and the other channel on Windows. Shared by the version card and the
// build choices in the edit drawer; `bump()` asks every user to read it again after a change.
import type { LlamacppDoc } from '~~/server/core/updater'

export function useRuntimeDoc() {
  const doc = useState<LlamacppDoc | null>('runtime-doc', () => null)
  const rev = useState<number>('runtime-doc-rev', () => 0)
  const rows = computed(() => doc.value?.runtimes?.rows ?? [])

  async function load(): Promise<boolean> {
    try {
      doc.value = await $fetch<LlamacppDoc>('/api/llamacpp')
      return true
    } catch {
      return false
    }
  }
  const bump = () => { rev.value++ }
  return { doc, rev, rows, load, bump }
}
