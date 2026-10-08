// How a stored profile name is shown (decision 18, work package 11-2). The stored name is the data:
// `DEFAULT_PROFILE` is `默认` in models.json and every migration keeps it - only the English
// interface reads it as `Default`. Everything that puts a profile name on screen goes through here;
// nothing that sends a name to the server does.
import { DISPLAY_LABELS } from '../../i18n/messages'
import { getUiLocale } from '../composables/useLocale'

/** The name to show for a stored profile name in the language the interface is showing. */
export function profileLabel(name: string | null | undefined): string {
  if (name === null || name === undefined) return ''
  const map = DISPLAY_LABELS[getUiLocale()] ?? {}
  return map[name] ?? name
}

/** Select items for a profile list: the value stays the stored name, only the label is mapped. */
export function profileItems(names: readonly string[]): Array<{ label: string, value: string }> {
  return names.map(name => ({ label: profileLabel(name), value: name }))
}
