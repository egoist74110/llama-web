// Server-side access to the UI strings in i18n/zh-CN.ts.
import zh from '../../i18n/zh-CN'

export const t = zh

/** Replace `{key}` placeholders. Unknown keys are left as-is. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
