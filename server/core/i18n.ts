// Server-side access to the UI strings (decision 18): the dictionary of the locale this process was
// told to use. `t` stays an object - a Proxy over the current dictionary - so the 26 import points
// need no change and a settings save can switch the language without a restart.
import { DEFAULT_LOCALE, dictionaries, type LocaleCode, type Messages } from '../../i18n/messages'

let locale: LocaleCode = DEFAULT_LOCALE

/** The dictionary of the locale this process answers in. */
const current = () => dictionaries[locale]

/**
 * Switch the language of everything this module produces: event texts, API errors, the messages of
 * the management interface - and the errors of `/v1/*`, which third-party clients read (decision 18).
 * An unknown code is ignored: settings validation owns hand-edited values.
 */
export function setLocale(next: LocaleCode): void {
  if (!(next in dictionaries)) return
  locale = next
}

/** The locale `t` is answering in right now. */
export const getLocale = (): LocaleCode => locale

/**
 * The dictionary of the current locale. The Proxy keeps one `t` across `setLocale`, so nothing that
 * imports it has to know about the switch; reading it behaves like reading the source object.
 */
export const t: Messages = new Proxy({} as Messages, {
  get: (_target, key) => Reflect.get(current(), key),
  has: (_target, key) => Reflect.has(current(), key),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(current(), key),
})

/** Replace `{key}` placeholders. Unknown keys are left as-is. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
