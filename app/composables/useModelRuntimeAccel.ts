// Helper to determine the effective runtime of a model or failed run (decision 61).
import { t } from './useLocale'
import { isExperimentalAccel, extractRuntimeFromTail } from '../utils/experimental-backend'

export function useModelRuntimeAccel(
  getModelId: () => string | undefined,
  getProfile: () => string | undefined,
  getTail?: () => readonly string[] | undefined,
) {
  const accel = ref<string>('')
  const copying = ref(false)
  const toast = useToast()

  async function resolve() {
    const modelId = getModelId()
    if (!modelId) {
      accel.value = ''
      return
    }
    const tail = getTail?.()
    const fromTail = extractRuntimeFromTail(tail)
    if (fromTail) {
      accel.value = fromTail.accel
      return
    }
    try {
      const prof = getProfile()
      const detail = await $fetch<{ effectiveRuntime: { accel: string } | null }>(
        `/api/models/${encodeURIComponent(modelId)}`,
        { query: prof ? { profile: prof } : undefined },
      )
      accel.value = detail.effectiveRuntime?.accel ?? ''
    } catch {
      accel.value = ''
    }
  }

  const isExperimental = computed(() => isExperimentalAccel(accel.value))

  async function copyDiagnostics() {
    const modelId = getModelId()
    if (!modelId || copying.value) return
    copying.value = true
    try {
      const res = await $fetch<{ text: string }>(`/api/models/${encodeURIComponent(modelId)}/diagnostics`)
      await navigator.clipboard.writeText(res.text)
      toast.add({ title: t.failure.diagnosticsCopied, color: 'success', icon: 'i-lucide-check' })
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      toast.add({ title: t.failure.diagnosticsFailed, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
    } finally {
      copying.value = false
    }
  }

  return { accel, isExperimental, resolve, copyDiagnostics, copying }
}
