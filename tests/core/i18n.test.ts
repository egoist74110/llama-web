// Stage 11 (decision 18): the locale table, the fallback rules of i18n/fill.ts, and switching the
// language of the server-side text without a restart.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zh from '../../i18n/zh-CN'
import { enSkeleton } from '../../i18n/en'
import { deepMergeWithFallback } from '../../i18n/fill'
import { DEFAULT_LOCALE, dictionaries, LOCALES } from '../../i18n/messages'
import {
  defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION, type Settings,
} from '../../server/core/config'
import { JsonStore, StoreError } from '../../server/core/store'
import { fmt, getLocale, setLocale, t } from '../../server/core/i18n'

afterEach(() => setLocale(DEFAULT_LOCALE))

describe('dictionaries', () => {
  test('LOCALES is the locale table and every locale has a complete dictionary', () => {
    expect(LOCALES).toEqual(['zh-CN', 'en'])
    for (const code of LOCALES) {
      expect(dictionaries[code]).toBeDefined()
      // Shape only: the wording of this key is translated batch by batch.
      expect(dictionaries[code]!.api.modelNotFound.trim()).not.toBe('')
      expect(dictionaries[code].api.modelNotFound).toContain('{name}')
    }
  })

  test('the English dictionary is a complete copy, not a view on the Chinese one', () => {
    expect(dictionaries.en.desktop).not.toBe(dictionaries['zh-CN'].desktop)
    expect(dictionaries.en.cloudflare.howToken.steps).not.toBe(zh.cloudflare.howToken.steps)
    expect(Array.isArray(dictionaries.en.cloudflare.howToken.steps)).toBe(true)
    expect(dictionaries.en.api).not.toBe(dictionaries['zh-CN'].api)
  })
})

describe('deepMergeWithFallback', () => {
  // A small dictionary of the same shape, so the rules can be tested on their own.
  const fallback = {
    group: { one: 'fallback one', two: 'fallback two' },
    list: ['fallback one', 'fallback two', 'fallback three'],
    deep: { nested: { text: 'fallback text' } },
  }

  test('a key the patch does not have keeps the fallback text', () => {
    const merged = deepMergeWithFallback(fallback, { group: { one: 'translated' } })
    expect(merged.group.one).toBe('translated')
    expect(merged.group.two).toBe('fallback two')
  })

  test('a patch value of the wrong type falls back instead of breaking the dictionary', () => {
    const merged = deepMergeWithFallback(fallback, { group: { one: 42, two: null }, list: 'not an array' })
    expect(merged.group.one).toBe('fallback one')
    expect(merged.group.two).toBe('fallback two')
    expect(merged.list).toEqual(['fallback one', 'fallback two', 'fallback three'])
  })

  test('arrays are merged entry by index and keep the length of the fallback', () => {
    const merged = deepMergeWithFallback(fallback, { list: ['translated one', 'translated two'] })
    expect(merged.list).toEqual(['translated one', 'translated two', 'fallback three'])
    expect(Array.isArray(merged.list)).toBe(true)
    expect(merged.list.length).toBe(3)
  })

  test('a group the fallback does not have is dropped', () => {
    const merged = deepMergeWithFallback(fallback, { invented: { text: 'x' } })
    expect('invented' in merged).toBe(false)
  })

  test('the fallback is not modified and shares no branch with the result', () => {
    const merged = deepMergeWithFallback(fallback, { group: { one: 'translated' } })
    expect(fallback.group.one).toBe('fallback one')
    expect(merged.group).not.toBe(fallback.group)
    expect(merged.deep.nested).not.toBe(fallback.deep.nested)
  })

  test('the real dictionaries: en covers every key of zh-CN and falls back where nothing is written', () => {
    const en = deepMergeWithFallback(dictionaries['zh-CN'], enSkeleton)
    // Shape only: every key of zh-CN is present, and the wording is whatever batch has written it.
    expect(typeof en.desktop.choose).toBe('string')
    expect(en.desktop.choose.trim()).not.toBe('')
    // Translated arrays keep the Chinese length and order (merged entry by index), not the text.
    expect(en.models.edit.rd.gpu.confirmNotes.length).toBe(zh.models.edit.rd.gpu.confirmNotes.length)
    expect(en.cloudflare.howDomain.steps.length).toBe(zh.cloudflare.howDomain.steps.length)
  })
})

describe('server locale', () => {
  test('setLocale changes which dictionary t answers from; an unknown code is ignored', () => {
    expect(getLocale()).toBe('zh-CN')
    expect(t.api).toBe(dictionaries['zh-CN'].api)
    setLocale('en')
    expect(getLocale()).toBe('en')
    // The English wording is not written yet, so the text is still Chinese - but it is the text of the
    // English dictionary, which is a different object than the Chinese one.
    expect(t.api).toBe(dictionaries.en.api)
    expect(t.api).not.toBe(dictionaries['zh-CN'].api)
    setLocale('de')
    expect(getLocale()).toBe('en')
  })

  test('t keeps one identity across the switch, so the import points do not have to know about it', () => {
    const first = t.nav.overview
    setLocale('en')
    setLocale('zh-CN')
    expect(t.nav.overview).toBe(first)
  })

  test('reading t behaves like reading the object it wraps', () => {
    expect(Object.keys(t).length).toBe(Object.keys(zh).length)
    expect('nav' in t).toBe(true)
    expect('nope' in t).toBe(false)
    expect(t.loadError['split-mode-failed']).toBe(zh.loadError['split-mode-failed'])
    expect(t.cloudflare.howToken.steps.length).toBe(9)
    expect(t.cloudflare.howToken.steps.map((s) => s.length).every((n) => n > 0)).toBe(true)
  })

  test('fmt is unchanged: placeholders are replaced, unknown keys are left alone', () => {
    expect(fmt('a {a} b {b}', { a: 1, b: 2 })).toBe('a 1 b 2')
    expect(fmt('keep {unknown}', { a: 1 })).toBe('keep {unknown}')
    expect(fmt('no placeholders')).toBe('no placeholders')
    expect(fmt('{a}{a}', { a: 'x' })).toBe('xx')
    expect(fmt(t.desktop.portInUse, { port: 5001 })).toContain('5001')
  })
})

describe('settings locale reaches the server text', () => {
  test('a settings document with ui.locale en makes the server answer in the English dictionary', () => {
    // The wiring itself (context.ts / settings-api.ts) needs a running context; what is testable
    // here is the rule it applies: the saved value is what setLocale receives.
    const saved = normalizeSettings({ ...defaultSettings(), ui: { locale: 'en' } }).ui.locale
    setLocale(saved)
    expect(getLocale()).toBe('en')
    expect(t.api).toBe(dictionaries.en.api)
  })

  test('a settings file of a newer version is refused instead of half-read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-i18n-store-'))
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: SETTINGS_VERSION + 1, ui: { locale: 'en' } }))
      const store = new JsonStore<Settings>({
        dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings,
        validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS,
      })
      try {
        expect(() => store.load()).toThrow(StoreError)
        expect((() => { try { store.load() } catch (e) { return (e as StoreError).code } })()).toBe('newer-version')
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
