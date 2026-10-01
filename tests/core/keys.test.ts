import { describe, expect, test } from 'bun:test'
import {
  authenticate, createKey, defaultSecrets, findKey, generateKey, KeyError, listKeys, maskKey, MAX_KEYS, normalizeSecrets,
  revokeKey, SECRETS_MIGRATIONS, type SecretsDoc,
} from '../../server/core/keys'

function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) { return e instanceof KeyError ? e.code : `other:${(e as Error).message}` }
  return 'none'
}

function docWith(...names: string[]): SecretsDoc {
  const d = defaultSecrets()
  for (const n of names) createKey(d, n)
  return d
}

describe('generateKey / createKey', () => {
  test('keys are sk- + 43 url-safe characters and differ every time', () => {
    const a = generateKey()
    const b = generateKey()
    expect(a).toMatch(/^sk-[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  test('creates a named, active key with a fresh id and creation time', () => {
    const d = defaultSecrets()
    const k = createKey(d, '  手机  ', { now: new Date('2026-10-01T00:00:00Z') })
    expect(k).toMatchObject({ name: '手机', revoked: false, revokedAt: null, allowSwitch: true, createdAt: '2026-10-01T00:00:00.000Z' })
    expect(k.id).toMatch(/^k-[0-9a-f]{8}$/)
    expect(d.apiKeys).toEqual([k])
  })

  test('rejects empty, too long, control-character and non-string names', () => {
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 42, null, undefined]) {
      expect(codeOf(() => createKey(defaultSecrets(), bad))).toBe('bad-name')
    }
    expect(codeOf(() => createKey(defaultSecrets(), 'x'.repeat(40)))).toBe('none')
  })

  test('names are unique among active keys; a revoked key frees its name', () => {
    const d = docWith('手机')
    expect(codeOf(() => createKey(d, '手机'))).toBe('name-taken')
    revokeKey(d, d.apiKeys[0]!.id)
    expect(codeOf(() => createKey(d, '手机'))).toBe('none')
    expect(d.apiKeys.length).toBe(2)
  })

  test('id collisions are retried', () => {
    const d = docWith('a')
    const taken = d.apiKeys[0]!.id
    let calls = 0
    // First 4-byte draw repeats the existing id, then a different one; 32-byte draws are random.
    const rand = (n: number) => n === 4 ? Buffer.from((calls++ === 0 ? taken.slice(2) : '0badf00d'), 'hex') : Buffer.alloc(n, 7)
    const k = createKey(d, 'b', { rand })
    expect(k.id).toBe('k-0badf00d')
  })

  test('refuses more than MAX_KEYS keys', () => {
    const d = defaultSecrets()
    for (let i = 0; i < MAX_KEYS; i++) createKey(d, `k${i}`)
    expect(codeOf(() => createKey(d, 'one-more'))).toBe('too-many')
  })
})

describe('revokeKey / findKey', () => {
  test('marks the key revoked once and keeps it in the list', () => {
    const d = docWith('a')
    const id = d.apiKeys[0]!.id
    revokeKey(d, id, new Date('2026-10-01T01:00:00Z'))
    revokeKey(d, id, new Date('2026-10-02T01:00:00Z'))
    expect(d.apiKeys[0]).toMatchObject({ revoked: true, revokedAt: '2026-10-01T01:00:00.000Z' })
  })

  test('unknown ids are not-found', () => {
    expect(codeOf(() => revokeKey(docWith('a'), 'k-nope'))).toBe('not-found')
    expect(codeOf(() => findKey(docWith('a'), undefined))).toBe('not-found')
  })
})

describe('listing never contains the key', () => {
  test('maskKey keeps a short head and the last four characters', () => {
    const key = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg'
    expect(maskKey(key)).toBe('sk-ABCD…defg')
    expect(maskKey('short')).toBe('…')
  })

  test('listKeys is newest first and its JSON has no key value', () => {
    const d = docWith('old', 'new')
    const list = listKeys(d)
    expect(list.map(k => k.name)).toEqual(['new', 'old'])
    const json = JSON.stringify(list)
    for (const k of d.apiKeys) expect(json).not.toContain(k.key)
    expect(Object.keys(list[0]!)).not.toContain('key')
  })
})

describe('authenticate', () => {
  const d = docWith('phone', 'laptop')
  const [phone, laptop] = d.apiKeys as [typeof d.apiKeys[0], typeof d.apiKeys[0]]
  revokeKey(d, laptop.id)

  test('missing header', () => {
    expect(authenticate(d, null)).toEqual({ ok: false, reason: 'missing' })
    expect(authenticate(d, '')).toEqual({ ok: false, reason: 'missing' })
  })

  test('anything but "Bearer <one token>" is malformed', () => {
    for (const h of [phone.key, `Basic ${phone.key}`, 'Bearer', 'Bearer ', `Bearer ${phone.key} extra`, `Token ${phone.key}`]) {
      expect(authenticate(d, h)).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  test('scheme is case-insensitive, surrounding blanks are allowed', () => {
    const r = authenticate(d, `bearer   ${phone.key} `)
    expect(r.ok && r.key.id).toBe(phone.id)
  })

  test('valid active key', () => {
    const r = authenticate(d, `Bearer ${phone.key}`)
    expect(r.ok && r.key.name).toBe('phone')
  })

  test('unknown, prefix-only, case-changed and revoked keys are invalid', () => {
    for (const k of ['sk-nope', phone.key.slice(0, -1), `${phone.key}x`, phone.key.toUpperCase(), laptop.key]) {
      expect(authenticate(d, `Bearer ${k}`)).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  test('no keys at all: everything is refused', () => {
    expect(authenticate(defaultSecrets(), `Bearer ${phone.key}`)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('a hand-edited duplicate stays usable through its active copy only', () => {
    const dd: SecretsDoc = { version: 1, apiKeys: [{ ...laptop }, { ...laptop, id: 'k-copy', name: 'copy', revoked: false }] }
    const r = authenticate(dd, `Bearer ${laptop.key}`)
    expect(r.ok && r.key.id).toBe('k-copy')
  })
})

describe('normalizeSecrets', () => {
  test('fills defaults of hand-edited entries', () => {
    const doc = normalizeSecrets({ version: 2, apiKeys: [{ id: 'k1', key: 'sk-0123456789abcdef' } as any] })
    expect(doc.apiKeys[0]).toMatchObject({ id: 'k1', name: 'k1', revoked: false, allowSwitch: true, createdAt: '' })
    expect(normalizeSecrets({ version: 1 } as any).apiKeys).toEqual([])
  })

  test('rejects wrong shapes, short keys and duplicate ids', () => {
    expect(() => normalizeSecrets({ version: 1, apiKeys: {} } as any)).toThrow()
    expect(() => normalizeSecrets({ version: 2, apiKeys: [{ id: 'k1', key: 'short' }] } as any)).toThrow()
    expect(() => normalizeSecrets({ version: 1, apiKeys: [{ key: 'sk-0123456789abcdef' }] } as any)).toThrow()
    const k = { id: 'k1', key: 'sk-0123456789abcdef' }
    expect(() => normalizeSecrets({ version: 1, apiKeys: [k, { ...k }] } as any)).toThrow()
  })
})

describe('secrets.json version 2 (tunnel token)', () => {
  test('defaults and old files get an empty token; a wrong type is refused', () => {
    expect(defaultSecrets().tunnelToken).toBe('')
    expect(normalizeSecrets({ version: 2, apiKeys: [] } as any).tunnelToken).toBe('')
    expect(normalizeSecrets({ version: 2, apiKeys: [], tunnelToken: null } as any).tunnelToken).toBe('')
    expect(() => normalizeSecrets({ version: 2, apiKeys: [], tunnelToken: 5 } as any)).toThrow()
  })

  test('migration 1 -> 2 keeps the keys and adds the token', () => {
    const old = { version: 1, apiKeys: [{ id: 'k1', key: 'sk-0123456789abcdef' }] }
    const next = SECRETS_MIGRATIONS[1]!(old)
    expect(next.apiKeys).toEqual(old.apiKeys)
    expect(next.tunnelToken).toBe('')
  })

  test('keys are still checked the same way with a token present', () => {
    const d = defaultSecrets()
    d.tunnelToken = 'eyJ-token'
    const k = createKey(d, 'phone')
    expect(authenticate(d, `Bearer ${k.key}`).ok).toBe(true)
    expect(authenticate(d, 'Bearer eyJ-token').ok).toBe(false)
  })
})

describe('secrets.json version 2 (tunnel token)', () => {
  test('defaults and old files get an empty token; a wrong type is refused', () => {
    expect(defaultSecrets().tunnelToken).toBe('')
    expect(normalizeSecrets({ version: 2, apiKeys: [] } as any).tunnelToken).toBe('')
    expect(normalizeSecrets({ version: 2, apiKeys: [], tunnelToken: null } as any).tunnelToken).toBe('')
    expect(() => normalizeSecrets({ version: 2, apiKeys: [], tunnelToken: 5 } as any)).toThrow()
  })

  test('migration 1 -> 2 keeps the keys and adds the token', () => {
    const old = { version: 1, apiKeys: [{ id: 'k1', key: 'sk-0123456789abcdef' }] }
    const next = SECRETS_MIGRATIONS[1]!(old)
    expect(next.apiKeys).toEqual(old.apiKeys)
    expect(next.tunnelToken).toBe('')
  })

  test('keys are checked the same way with a token present; the token is not a key', () => {
    const d = defaultSecrets()
    d.tunnelToken = 'eyJ-token-eyJ-token'
    const k = createKey(d, 'phone')
    expect(authenticate(d, `Bearer ${k.key}`).ok).toBe(true)
    expect(authenticate(d, 'Bearer eyJ-token-eyJ-token').ok).toBe(false)
  })
})
