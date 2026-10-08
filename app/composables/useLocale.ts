// The dictionary the pages read (decision 18, work package 11-2). `t` follows the language of the
// saved settings, and switching it repaints the pages - no reload, no restart.
//
// `t` is a view, not a copy: every read resolves the branch against the dictionary of the language that
// is current at that moment. That is what keeps `const s = t.settings.system` - the alias nearly every
// component uses - live across a switch, and it is what Vue tracks: reading `t` during a render reads
// the locale ref, so the next snapshot in the new language repaints the page.
import { ref } from 'vue'
import { DEFAULT_LOCALE, dictionaries, type LocaleCode, type Messages } from '../../i18n/messages'

const locale = ref<LocaleCode>(DEFAULT_LOCALE)

/** The language the interface is showing right now. */
export const getUiLocale = (): LocaleCode => locale.value

/**
 * Show the interface in another language. An unknown code is ignored: settings validation owns
 * hand-edited values, and the live snapshot only carries the accepted one.
 */
export function setUiLocale(next: LocaleCode): void {
  if (!(next in dictionaries) || locale.value === next) return
  locale.value = next
}

/** Take the language from a settings document (`SettingsDoc.ui`). */
export function applyUiLocale(ui: { locale: LocaleCode } | null | undefined): void {
  if (ui) setUiLocale(ui.locale)
}

/** Walk the current dictionary down to one branch. */
function branchAt(path: readonly string[]): unknown {
  let node: unknown = dictionaries[locale.value]
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** The branch at `path`, or an empty object when it is not an object (a missing key reads as nothing). */
const nodeAt = (path: readonly string[]): object => {
  const node = branchAt(path)
  return node !== null && typeof node === 'object' ? node : {}
}

/**
 * A live view of one branch. Object children become views of their own - cached per branch, so a
 * component's `const s = t.settings.system` is the same object every render and still reads the current
 * language. String and array children are the values themselves, resolved when they are read.
 */
function view(path: readonly string[]): object {
  const children = new Map<string, object>()
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined
      const child = branchAt([...path, key])
      // Arrays are values, not branches: a list reads as the real array of the current language.
      if (child === null || Array.isArray(child) || typeof child !== 'object') return child
      let nested = children.get(key)
      if (!nested) {
        nested = view([...path, key])
        children.set(key, nested)
      }
      return nested
    },
    has: (_target, key) => Reflect.has(nodeAt(path), key),
    ownKeys: () => Reflect.ownKeys(nodeAt(path)),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(nodeAt(path), key),
  })
}

/** The dictionary of the current language, as one object whose identity never changes. */
export const t: Messages = view([]) as Messages
