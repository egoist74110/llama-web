// API keys for the public entry (data/secrets.json, plan 12b): create, list (masked), reveal,
// revoke, and check an Authorization header. Pure module (no Nitro). Keys are stored in plain
// text by decision; they never appear in logs, request records or list responses.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface ApiKey {
  id: string
  name: string
  key: string
  /** ISO time. */
  createdAt: string
  revoked: boolean
  /** ISO time, set when revoked. */
  revokedAt?: string | null
  /** Placeholder (plan 坑位): stored, not enforced. */
  allowSwitch: boolean
}

export interface SecretsDoc {
  version: number
  apiKeys: ApiKey[]
  /** Cloudflare tunnel token (plain text by decision, like the keys); '' = none. Never in logs, events or API responses. */
  tunnelToken: string
}

export const SECRETS_VERSION = 2

/** `migrations[n]` turns a version-n secrets.json into version n + 1. */
export const SECRETS_MIGRATIONS: Record<number, (old: any) => any> = {
  // 2: tunnel token.
  1: old => ({ ...old, tunnelToken: '' }),
}

export function defaultSecrets(): SecretsDoc {
  return { version: SECRETS_VERSION, apiKeys: [], tunnelToken: '' }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Validate a (possibly hand-edited) secrets.json. Throws on a wrong shape. */
export function normalizeSecrets(doc: SecretsDoc): SecretsDoc {
  if (!isObj(doc)) throw new Error('secrets must be an object')
  if (doc.apiKeys === undefined) doc.apiKeys = []
  if (!Array.isArray(doc.apiKeys)) throw new Error('"apiKeys" must be an array')
  if (doc.tunnelToken === undefined || doc.tunnelToken === null) doc.tunnelToken = ''
  if (typeof doc.tunnelToken !== 'string') throw new Error('"tunnelToken" must be a string')
  const ids = new Set<string>()
  for (const k of doc.apiKeys) {
    if (!isObj(k) || typeof k.id !== 'string' || !k.id) throw new Error('every API key needs a string "id"')
    if (ids.has(k.id)) throw new Error(`duplicate API key id "${k.id}"`)
    ids.add(k.id)
    if (typeof k.key !== 'string' || k.key.length < MIN_KEY_LENGTH) throw new Error(`API key "${k.id}" needs a "key" of at least ${MIN_KEY_LENGTH} characters`)
    if (typeof k.name !== 'string' || !k.name) k.name = k.id
    k.revoked = k.revoked === true
    k.allowSwitch = k.allowSwitch !== false
    if (typeof k.createdAt !== 'string') k.createdAt = ''
  }
  return doc
}

/** Hand-edited keys shorter than this are refused (a short key is guessable). */
export const MIN_KEY_LENGTH = 16
export const MAX_KEYS = 100
export const MAX_NAME_LENGTH = 40

export type KeyErrorCode = 'bad-name' | 'name-taken' | 'not-found' | 'too-many'

export class KeyError extends Error {
  constructor(public code: KeyErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'KeyError'
  }
}

type Rand = (n: number) => Buffer

/** `sk-` + 32 random bytes (base64url, 43 characters). */
export function generateKey(rand: Rand = randomBytes): string {
  return `sk-${rand(32).toString('base64url')}`
}

function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new KeyError('bad-name')
  const name = raw.trim()
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) throw new KeyError('bad-name')
  return name
}

/** Add a new key to the draft and return it. Names must be unique among keys that are not revoked. */
export function createKey(draft: SecretsDoc, rawName: unknown, opts: { now?: Date, rand?: Rand } = {}): ApiKey {
  const name = cleanName(rawName)
  if (draft.apiKeys.length >= MAX_KEYS) throw new KeyError('too-many')
  if (draft.apiKeys.some(k => !k.revoked && k.name === name)) throw new KeyError('name-taken', name)
  const rand = opts.rand ?? randomBytes
  const ids = new Set(draft.apiKeys.map(k => k.id))
  let id: string
  do id = `k-${rand(4).toString('hex')}`
  while (ids.has(id))
  const key: ApiKey = {
    id, name, key: generateKey(rand), createdAt: (opts.now ?? new Date()).toISOString(),
    revoked: false, revokedAt: null, allowSwitch: true,
  }
  draft.apiKeys.push(key)
  return key
}

/** Mark a key revoked (kept in the list so request records stay readable). Revoking twice is a no-op. */
export function revokeKey(draft: SecretsDoc, id: unknown, now = new Date()): ApiKey {
  const key = draft.apiKeys.find(k => k.id === id)
  if (!key) throw new KeyError('not-found')
  if (!key.revoked) {
    key.revoked = true
    key.revokedAt = now.toISOString()
  }
  return key
}

export function findKey(doc: SecretsDoc, id: unknown): ApiKey {
  const key = doc.apiKeys.find(k => k.id === id)
  if (!key) throw new KeyError('not-found')
  return key
}

/** `sk-AbCd…wxYz`: enough to tell keys apart, not enough to use one. */
export function maskKey(key: string): string {
  if (key.length < 12) return '…'
  const head = key.startsWith('sk-') ? key.slice(0, 7) : key.slice(0, 4)
  return `${head}…${key.slice(-4)}`
}

/** A key as list responses show it: never the key itself. */
export interface KeyView {
  id: string
  name: string
  masked: string
  createdAt: string
  revoked: boolean
  revokedAt: string | null
}

export function viewKey(k: ApiKey): KeyView {
  return { id: k.id, name: k.name, masked: maskKey(k.key), createdAt: k.createdAt, revoked: k.revoked, revokedAt: k.revokedAt ?? null }
}

/** Newest first. */
export function listKeys(doc: SecretsDoc): KeyView[] {
  return doc.apiKeys.map(viewKey).reverse()
}

// ---------------------------------------------------------------------------------------
// Authentication

export type AuthResult =
  | { ok: true, key: ApiKey }
  | { ok: false, reason: 'missing' | 'malformed' | 'invalid' }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/**
 * Check `Authorization: Bearer <key>` against the keys that are not revoked. Every stored key is
 * compared (fixed-length digests, constant-time compare), so timing does not reveal which keys
 * exist or how much of a guess matched. A revoked key is simply `invalid`.
 */
export function authenticate(doc: SecretsDoc, header: string | null | undefined): AuthResult {
  if (!header) return { ok: false, reason: 'missing' }
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  if (!m) return { ok: false, reason: 'malformed' }
  const given = digest(m[1]!)
  let found: ApiKey | null = null
  for (const k of doc.apiKeys) {
    if (timingSafeEqual(given, digest(k.key)) && !k.revoked && !found) found = k
  }
  return found ? { ok: true, key: found } : { ok: false, reason: 'invalid' }
}
