// Management API helpers for knowledge bases (decision 65).
import { KbError } from '../core/kb/errors'
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'

const STATUS: Partial<Record<KbError['code'], number>> = {
  'not-found': 404, 'doc-not-found': 404,
  'name-taken': 409, 'duplicate': 409, 'busy': 409,
  'too-large': 413,
  'embed-failed': 502,
}

/** Message for an error code (also used for the error stored on a document) in the interface language. */
export function kbMessage(code: string, detail = ''): string {
  const errors = t.kb.errors as Record<string, string>
  return fmt(errors[code] ?? code, { detail })
}

/** Turn a KbError into an HTTP error with a message in the interface language; other errors pass through. */
export function kbError(e: unknown): never {
  if (e instanceof KbError) throw createError({ statusCode: STATUS[e.code] ?? 400, message: kbMessage(e.code, e.detail) })
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.kb.errors.store, { detail: e.message }) })
  throw e
}

/** Path parameter `docId` as a positive integer. */
export function docIdParam(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new KbError('doc-not-found')
  return n
}
