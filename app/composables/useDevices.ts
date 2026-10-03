// Device lists (GET /api/devices) per llama.cpp build, for the device choices. A Mac has none (decision 38):
// nothing is requested there and every list is null.
import type { DevicesView } from '~~/server/core/devices'

export function useDevices() {
  const ui = usePlatformUi()
  const views = useState<Record<string, DevicesView | null>>('devices-views', () => ({}))
  const failed = useState<Record<string, boolean>>('devices-failed', () => ({}))
  const key = (runtime: string) => runtime || '-'

  /** Read the list of one build ('' = the global version). Concurrent callers share the cached answer unless `refresh`. */
  async function load(runtime: string, refresh = false): Promise<DevicesView | null> {
    if (!ui.value.hasGpu) return null
    const k = key(runtime)
    if (!refresh && k in views.value) return views.value[k] ?? null
    try {
      const r = await $fetch<DevicesView | { applicable: false }>('/api/devices', { query: { runtime: runtime || undefined, refresh: refresh ? '1' : undefined } })
      views.value = { ...views.value, [k]: 'gpus' in r ? r : null }
      failed.value = { ...failed.value, [k]: false }
    } catch {
      failed.value = { ...failed.value, [k]: true }
      views.value = { ...views.value, [k]: null }
    }
    return views.value[k] ?? null
  }
  const viewOf = (runtime: string): DevicesView | null => views.value[key(runtime)] ?? null
  const failedOf = (runtime: string): boolean => !!failed.value[key(runtime)]
  return { load, viewOf, failedOf }
}
