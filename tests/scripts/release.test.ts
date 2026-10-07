import { describe, expect, test } from 'bun:test'
import { nextVersion } from '../../scripts/release'

describe('release nextVersion', () => {
  test('next bumps the pre-release counter', () => {
    expect(nextVersion('0.1.0-beta.7', 'next')).toBe('0.1.0-beta.8')
  })
  test('next on a stable version bumps the patch', () => {
    expect(nextVersion('0.1.3', 'next')).toBe('0.1.4')
  })
  test('patch / minor / major drop the pre-release part', () => {
    expect(nextVersion('0.1.0-beta.7', 'patch')).toBe('0.1.0')
    expect(nextVersion('0.1.0-beta.7', 'minor')).toBe('0.1.0')
    expect(nextVersion('0.1.4', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.4', 'major')).toBe('1.0.0')
  })
  test('an exact version is used as given', () => {
    expect(nextVersion('0.1.0-beta.7', '0.2.0-rc.1')).toBe('0.2.0-rc.1')
  })
  test('rejects unknown bumps', () => {
    expect(() => nextVersion('0.1.0', 'wat')).toThrow()
  })
})
