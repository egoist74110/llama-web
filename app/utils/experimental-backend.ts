// Helpers for experimental runtimes (Vulkan, SYCL, ROCm) under decision 61.
import { t } from '../composables/useLocale'
import { accelLabel } from './runtime-choices'

export const EXPERIMENTAL_ACCELS = ['vulkan', 'sycl', 'rocm'] as const
export type ExperimentalAccel = (typeof EXPERIMENTAL_ACCELS)[number]

/** Whether a runtime acceleration type is experimental. */
export function isExperimentalAccel(accel: string | undefined | null): boolean {
  return !!accel && (EXPERIMENTAL_ACCELS as readonly string[]).includes(accel)
}

/**
 * Channel name in the channel header: "Vulkan（实验性，Intel / AMD / 老 N 卡）" style wording
 * in the channel header only; elsewhere just "Vulkan" (+ badge).
 */
export function channelHeaderTitle(accel: string, isMac: boolean): string {
  if (isMac) return ''
  if (accel === 'vulkan') {
    return t.llamacpp.manage.channelHeaders?.vulkan ?? (t.llamacpp.manage.channels as Record<string, string>)[accel] ?? 'Vulkan'
  }
  return accelLabel(accel, isMac)
}

/** Human-readable explanation corresponding to an acceleration choice needed reason. */
export function choicePromptReasonText(reason: 'nvidia-missing' | 'nvidia-failed' | 'cuda-unusable' | null | undefined): string {
  if (!reason) return ''
  return (t.llamacpp.choicePrompt.reasons as Record<string, string>)[reason] ?? ''
}

/** Extract runtime info recorded in process launch log if present in the tail. */
export function extractRuntimeFromTail(tail: readonly string[] | undefined | null): { accel: string, ref: string } | null {
  if (!tail?.length) return null
  const prefix = '# llama-web runtime: '
  for (const line of tail) {
    if (line.startsWith(prefix)) {
      try {
        const meta = JSON.parse(line.slice(prefix.length))
        if (meta?.runtime?.accel) {
          return { accel: String(meta.runtime.accel), ref: String(meta.runtime.ref ?? '') }
        }
      } catch {
        // Ignored, not valid JSON.
      }
    }
  }
  return null
}
