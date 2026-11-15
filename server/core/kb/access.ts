// What a request may do with the knowledge bases (decisions 65 ⑧ / 69 ⑧). Pure module: the secrets are passed in and
// looked up on every request, so revoking or editing a key applies at once.
import type { SecretsDoc } from '../keys'
import type { RequestMeta } from '../request-log'

export interface KbAccess {
  /** Who is acting, as the change log records it: 'local' or 'key:<name>'. */
  actor: string
  /** Knowledge base ids the caller may use; null = all. */
  allowed: string[] | null
  /** May write knowledge bases. */
  write: boolean
}

/**
 * A request without `keyId` came in on the main port (this machine or the LAN): no key is involved and nothing is
 * restricted (decision 65 ⑧). A request with `keyId` came through the public entry: the key decides. A key that is gone
 * or revoked since the public entry authenticated it gets nothing.
 */
export function kbAccessOf(meta: RequestMeta | undefined, secrets: SecretsDoc): KbAccess {
  if (!meta?.keyId) return { actor: 'local', allowed: null, write: true }
  const key = secrets.apiKeys.find(k => k.id === meta.keyId)
  const name = key?.name ?? meta.keyName ?? meta.keyId
  if (!key || key.revoked) return { actor: `key:${name}`, allowed: [], write: false }
  return { actor: `key:${key.name}`, allowed: key.kbs ? [...key.kbs] : null, write: key.kbWrite }
}
