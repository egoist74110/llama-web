// Text that differs on a Mac (decision 38): nothing visible there may mention a GPU, video memory,
// Metal or drive letters. Components pass `isMac` from usePlatformUi(); the wording is in
// i18n/zh-CN.ts under `platform.mac`.
import t from '../../i18n/zh-CN'

const mac = t.platform.mac
type Params = typeof t.models.edit.params
type ParamKey = keyof Params

export function paramText(key: ParamKey, isMac: boolean): { label: string, hint: string } {
  const base = t.models.edit.params[key]
  const over = isMac ? (mac.params as Partial<Record<ParamKey, { label?: string, hint?: string }>>)[key] : undefined
  return { label: over?.label ?? base.label, hint: over?.hint ?? base.hint }
}

/** Short reason for a load error code. */
export function loadErrorText(code: string | null, isMac: boolean): string {
  if (!code) return ''
  const over = isMac ? (mac.loadError as Record<string, string>)[code] : undefined
  return over ?? (t.loadError as Record<string, string>)[code] ?? code
}

/** Advice shown on the failure card. */
export function failureAdvice(kind: string, isMac: boolean): string {
  const adviceFor = t.failure.advice as Record<string, string>
  const over = isMac ? (mac.advice as Record<string, string>)[kind] : undefined
  return over ?? adviceFor[kind] ?? t.failure.advice.unknown
}

export const dirPathPlaceholder = (isMac: boolean) => (isMac ? mac.pathPlaceholder : t.settings.dirs.pathPlaceholder)

/** Group notes of the parameter form / the global defaults: the Mac wording names no GPU or video memory. */
export function formHintText(key: 'commonHint' | 'moreHint' | 'defaultsMoreHint', isMac: boolean): string {
  if (isMac) return mac.form[key]
  return key === 'commonHint' ? t.models.edit.form.commonHint : key === 'moreHint' ? t.models.edit.form.moreHint : t.settings.defaults.moreHint
}
