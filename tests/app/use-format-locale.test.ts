// `formatClock` / `formatCount` follow the language the interface is showing (stage 11, the task left
// open by the 11-2 wiring).
//
// Why these tests spy on the two Intl entry points instead of only comparing the text: in Bun's ICU a
// 24-hour clock and a grouped integer read the same in `zh-CN` and `en` (`17:53:20`, `1,234`), so
// "the output equals the value formatted in the current language" would also pass with `'zh-CN'` still
// hardcoded. Recording the locale tag of every call is what proves the tag comes from `getUiLocale()`,
// and that it is read per call instead of once when the module is imported.
import { afterEach, describe, expect, test } from 'bun:test'
import { LOCALES } from '../../i18n/messages'
import { applyUiLocale, getUiLocale } from '../../app/composables/useLocale'
import { formatClock, formatCount } from '../../app/composables/useFormat'

// Built from local time parts, so the clock text does not depend on the machine's time zone.
const MS = new Date(2026, 9, 8, 17, 53, 20).getTime()

type ClockCall = { locale: string, options: Record<string, unknown> }
type CountCall = { locale: string, value: number, options: Record<string, unknown> }

/** Run `run` with `toLocaleTimeString` / `toLocaleString` recorded (still formatting for real), then
 * put the originals back. Nothing here depends on the machine's system locale: every call below hands
 * over an explicit tag, and the recorded tag is what the code under test passed. */
function withFormatSpied<T>(run: () => T): { result: T, clock: ClockCall[], count: CountCall[] } {
  const clock: ClockCall[] = []
  const count: CountCall[] = []
  const realClock = Date.prototype.toLocaleTimeString
  const realCount = Number.prototype.toLocaleString
  Date.prototype.toLocaleTimeString = function (this: Date, locales?: unknown, options?: unknown): string {
    clock.push({ locale: String(locales), options: (options ?? {}) as Record<string, unknown> })
    return realClock.apply(this, [locales, options] as unknown as Parameters<typeof realClock>)
  }
  Number.prototype.toLocaleString = function (this: number, locales?: unknown, options?: unknown): string {
    count.push({ locale: String(locales), options: options as Record<string, unknown>, value: this })
    return realCount.apply(this, [locales, options] as unknown as Parameters<typeof realCount>)
  }
  try {
    return { result: run(), clock, count }
  } finally {
    Date.prototype.toLocaleTimeString = realClock
    Number.prototype.toLocaleString = realCount
  }
}

afterEach(() => applyUiLocale({ locale: 'zh-CN' }))

describe('formatClock / formatCount read the interface locale (11-4)', () => {
  test('the clock tag is the current UI locale, and the clock stays 24-hour', () => {
    for (const code of LOCALES) {
      applyUiLocale({ locale: code })
      // The switch really took (an unknown code is ignored by `applyUiLocale`), so the tag the helper
      // has to pass is known before the call is recorded.
      expect(getUiLocale()).toBe(code)
      const { clock } = withFormatSpied(() => formatClock(MS))
      expect(clock.length).toBe(1)
      // A hardcoded tag, or no tag at all (the system locale), lands here as a mismatch.
      expect(clock[0]!.locale).toBe(code)
      expect(clock[0]!.options.hour12).toBe(false)
    }
  })
})

describe('the tag is read on every call, not once at import', () => {
  test('formatCount: the recorded tags follow the switch in call order', () => {
    const { count } = withFormatSpied(() => {
      applyUiLocale({ locale: 'en' })
      formatCount(1234)
      applyUiLocale({ locale: 'zh-CN' })
      formatCount(1234)
    })
    expect(count.map((c) => c.locale)).toEqual(['en', 'zh-CN'])
  })

  test('formatClock: the recorded tag follows the same switch', () => {
    const { clock } = withFormatSpied(() => {
      applyUiLocale({ locale: 'en' })
      formatClock(MS)
      applyUiLocale({ locale: 'zh-CN' })
      formatClock(MS)
      applyUiLocale({ locale: 'en' })
      formatClock(MS)
    })
    expect(clock.map((c) => c.locale)).toEqual(['en', 'zh-CN', 'en'])
  })
})

describe('the text itself (behaviour kept from the hardcoded version)', () => {
  test('the text is the value formatted with the tag of the language being shown', () => {
    for (const code of LOCALES) {
      applyUiLocale({ locale: code })
      expect(formatClock(MS)).toBe(new Date(MS).toLocaleTimeString(code, { hour12: false }))
      expect(formatCount(1234567)).toBe((1234567).toLocaleString(code))
    }
  })

  test('a 24-hour clock in every locale: no AM/PM marker, 17:53:20 for 5:53:20 PM', () => {
    for (const code of LOCALES) {
      applyUiLocale({ locale: code })
      const text = formatClock(MS)
      expect(text.startsWith('17:')).toBe(true)
      expect(/[AP]\s?\.?M/i.test(text)).toBe(false)
    }
  })

  test('formatCount still rounds to an integer and groups the digits', () => {
    applyUiLocale({ locale: 'en' })
    expect(formatCount(1234.4)).toBe('1,234')
    expect(formatCount(1234.5)).toBe('1,235')
    expect(formatCount(1234567)).toBe('1,234,567')
    applyUiLocale({ locale: 'zh-CN' })
    expect(formatCount(1234567)).toBe('1,234,567')
  })

  test('the rounding happens before the locale formatter is called', () => {
    applyUiLocale({ locale: 'en' })
    const { count } = withFormatSpied(() => formatCount(1234.5))
    expect(count[0]!.value).toBe(1235)
    expect(count[0]!.locale).toBe('en')
  })
})
