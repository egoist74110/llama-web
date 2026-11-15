// KbError -> HTTP status and message (decision 65 / 69), shared by the management API (/api/kb) and the external API
// (/v1/kb, MCP). Pure module (no Nitro).
import { fmt, t } from '../i18n'
import type { KbError } from './errors'

export const KB_STATUS: Partial<Record<KbError['code'], number>> = {
  'not-found': 404, 'doc-not-found': 404, 'entry-not-found': 404, 'version-not-found': 404,
  'name-taken': 409, 'duplicate': 409, 'busy': 409, 'version-conflict': 409, 'not-in-trash': 409, 'no-raw': 409,
  'too-large': 413,
  'embed-failed': 502,
}

/** HTTP status of a KbError code (400 unless mapped). */
export const kbStatus = (code: KbError['code']): number => KB_STATUS[code] ?? 400

/** Message for an error code (also used for the error stored on a document) in the interface language. */
export function kbMessage(code: string, detail = ''): string {
  const errors = t.kb.errors as Record<string, string>
  return fmt(errors[code] ?? code, { detail })
}
