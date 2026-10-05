// The user's own mirror prefix (decision 53 follow-up): validation, storage and the unchanged limits.
import { expect, test } from 'bun:test'
import { defaultModels, defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS } from '../../server/core/config'
import type { FetchFn } from '../../server/core/llamacpp'
import { customMirror, mirrorById, mirrorFetch, normalizeCustomMirror, offeredMirrors } from '../../server/core/mirrors'
import { applySettingsPatch, SettingsError } from '../../server/core/settings-admin'

test('only https public DNS names are accepted; a trailing slash is added; empty stays empty', () => {
  expect(normalizeCustomMirror('')).toBe('')
  expect(normalizeCustomMirror('   ')).toBe('')
  expect(normalizeCustomMirror(' https://mirror.example.com ')).toBe('https://mirror.example.com/')
  expect(normalizeCustomMirror('https://mirror.example.com/gh/')).toBe('https://mirror.example.com/gh/')
  for (const bad of [
    'http://mirror.example.com/', 'ftp://mirror.example.com/', 'mirror.example.com', 'https://', 'https://u:p@mirror.example.com/',
    'https://mirror.example.com/?a=1', 'https://mirror.example.com/#x', 'https://mirror.example.com:8443/',
    'https://localhost/', 'https://foo.localhost/', 'https://intranet/', 'https://printer.local/', 'https://127.0.0.1/',
    'https://10.0.0.5/', 'https://[::1]/', 'https://192.168.1.2/', 'https://a b.example.com/',
    `https://${'a'.repeat(200)}.example.com/`,
  ]) expect(normalizeCustomMirror(bad)).toBeNull()
  expect(normalizeCustomMirror(42)).toBeNull()
})

test('the id custom resolves to the saved prefix; empty or invalid gives nothing; built-ins are unchanged', () => {
  expect(mirrorById('custom', 'https://mirror.example.com/')).toMatchObject({ id: 'custom', host: 'mirror.example.com', base: 'https://mirror.example.com/' })
  expect(mirrorById('custom', '')).toBeNull()
  expect(mirrorById('custom')).toBeNull()
  expect(mirrorById('custom', 'http://mirror.example.com/')).toBeNull()
  expect(mirrorById('ghfast', 'https://mirror.example.com/')?.host).toBe('ghfast.top')
  expect(customMirror('')).toBeNull()
  // Empty setting: the offered list is the built-in two, as before.
  expect(offeredMirrors().map(m => m.id)).toEqual(['ghfast', 'gh-proxy'])
})

test('a custom mirror keeps the domain limit and the redirect limit', async () => {
  const m = mirrorById('custom', 'https://mirror.example.com/gh/')!
  const seen: string[] = []
  const ok: FetchFn = async (url) => { seen.push(url); return new Response('ok') }
  await mirrorFetch(m, ok)('https://github.com/a/b/x')
  expect(seen).toEqual(['https://mirror.example.com/gh/https://github.com/a/b/x'])
  await expect(mirrorFetch(m, ok)('https://evil.example/x')).rejects.toThrow()
  await expect(mirrorFetch(m, ok)('http://github.com/x')).rejects.toThrow()
  const back: Record<string, Response> = {
    'https://mirror.example.com/gh/https://github.com/a/b/x': new Response(null, { status: 302, headers: { location: '/gh/https://github.com/a/b/y' } }),
    'https://mirror.example.com/gh/https://github.com/a/b/y': new Response('payload'),
  }
  expect(await (await mirrorFetch(m, async url => back[url] ?? new Response('no', { status: 404 }))('https://github.com/a/b/x')).text()).toBe('payload')
  const evil: FetchFn = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
  await expect(mirrorFetch(m, evil)('https://github.com/a/b/x')).rejects.toThrow()
})

test('saving: valid prefix is stored normalized, invalid is rejected without a change, empty clears', () => {
  const draft = defaultSettings()
  const run = (custom: unknown) => applySettingsPatch(draft, { mirror: { custom } }, defaultModels())
  run('https://mirror.example.com')
  expect(draft.mirror.custom).toBe('https://mirror.example.com/')
  expect(() => run('http://mirror.example.com/')).toThrow(SettingsError)
  expect(() => run('https://127.0.0.1/')).toThrow(SettingsError)
  expect(() => applySettingsPatch(draft, { mirror: { custom: 'https://mirror.example.com/', extra: 1 } }, defaultModels())).toThrow(SettingsError)
  expect(draft.mirror.custom).toBe('https://mirror.example.com/')
  run('')
  expect(draft.mirror.custom).toBe('')
})

test('migration 8 -> 9 adds an empty mirror; a hand-edited bad value is dropped on load', () => {
  expect(defaultSettings().mirror).toEqual({ custom: '' })
  const old: any = { ...defaultSettings(), version: 8 }
  delete old.mirror
  expect(SETTINGS_MIGRATIONS[8]!(old).mirror).toEqual({ custom: '' })
  const edited = { ...defaultSettings(), mirror: { custom: 'http://evil.example/' } }
  expect(normalizeSettings(edited).mirror.custom).toBe('')
})
