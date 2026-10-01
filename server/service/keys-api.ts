// Shared by the /api/keys routes: the list the settings page shows and error mapping.
import { fmt, t } from '../core/i18n'
import { KeyError, listKeys, type KeyView } from '../core/keys'
import { StoreError } from '../core/store'
import { getContext } from './context'

export function describeKeys(): { keys: KeyView[] } {
  return { keys: listKeys(getContext().getSecrets()) }
}

/** Turn a key / store failure into an HTTP error with a Chinese message; other errors pass through. */
export function keysError(e: unknown): never {
  if (e instanceof KeyError) {
    const errors = t.keys.errors as Record<string, string>
    const status = e.code === 'not-found' ? 404 : e.code === 'name-taken' ? 409 : 400
    throw createError({ statusCode: status, message: fmt(errors[e.code] ?? e.code, { detail: e.detail }) })
  }
  // secrets.json is broken (hand edit): never overwrite it with the cached copy.
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.keys.errors['store'], { detail: e.message }) })
  throw e
}
