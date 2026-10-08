// How a stored profile name is shown (decision 18, work package 11-2). The name in models.json is
// the data - `默认` everywhere, kept by every migration; only the English interface reads it as
// `Default`, through the display table in i18n/messages.ts. Nothing that sends a name to the server
// goes through the mapping.
import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_PROFILE } from '../../server/core/config'
import { applyUiLocale } from '../../app/composables/useLocale'
import { profileItems, profileLabel } from '../../app/utils/profile-label'

afterEach(() => applyUiLocale({ locale: 'zh-CN' }))

describe('profile display mapping (work package 11-2)', () => {
  test('the stored name is unchanged data: 默认 is still the built-in profile name', () => {
    expect(DEFAULT_PROFILE).toBe('默认')
  })

  test('Chinese shows every stored name as it is', () => {
    expect(profileLabel('默认')).toBe('默认')
    expect(profileLabel('快')).toBe('快')
  })

  test('English reads the built-in profile as Default; a user-chosen name stays as it is', () => {
    applyUiLocale({ locale: 'en' })
    expect(profileLabel('默认')).toBe('Default')
    expect(profileLabel('快')).toBe('快')
  })

  test('null / undefined read as nothing (a request record without a profile)', () => {
    expect(profileLabel(null)).toBe('')
    expect(profileLabel(undefined)).toBe('')
  })

  test('profileItems maps labels only: the value sent to the server stays the stored name', () => {
    applyUiLocale({ locale: 'en' })
    expect(profileItems(['默认', '快'])).toEqual([
      { label: 'Default', value: '默认' },
      { label: '快', value: '快' },
    ])
  })
})
