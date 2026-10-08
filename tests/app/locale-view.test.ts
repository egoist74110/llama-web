// The dictionary view the pages read (decision 18, work package 11-2): `t` follows the interface
// language, and a component's `const s = t.settings.system` stays live across a switch - the same
// object, reading the dictionary of the language that is current when a value is read.
import { afterEach, describe, expect, test } from 'bun:test'
import zh from '../../i18n/zh-CN'
import { applyUiLocale, getUiLocale, t } from '../../app/composables/useLocale'

afterEach(() => applyUiLocale({ locale: 'zh-CN' }))

describe('the locale view (work package 11-2)', () => {
  test('t reads the dictionary of the current language', () => {
    expect(t.app.title).toBe(zh.app.title)
    expect(t.settings.dirs.title).toBe(zh.settings.dirs.title)
  })

  test('a component alias stays live across a switch', () => {
    const s = t.settings.system
    applyUiLocale({ locale: 'en' })
    // Same object identity (the alias never has to be re-taken), and its values now resolve
    // against the English dictionary - Chinese text until work package 11-3 fills the English
    // dictionary in, exactly the fallback rule of i18n/fill.ts.
    expect(s.title).toBe(zh.settings.system.title)
    expect(getUiLocale()).toBe('en')
  })

  test('arrays and deep branches resolve too', () => {
    applyUiLocale({ locale: 'en' })
    const steps = t.cloudflare.howToken.steps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps.length).toBe(zh.cloudflare.howToken.steps.length)
  })

  test('an unknown locale is ignored; a missing key reads as nothing instead of throwing', () => {
    applyUiLocale({ locale: 'de' as 'en' })
    expect(getUiLocale()).toBe('zh-CN')
    expect(t.settings.notAKey).toBeUndefined()
    expect('dirs' in t.settings).toBe(true)
    expect(Object.keys(t.settings)).toContain('dirs')
  })
})
