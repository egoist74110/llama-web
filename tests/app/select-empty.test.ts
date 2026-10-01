import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue, withEmptyOption } from '../../app/utils/select-empty'

// No DOM library in the project, so the original failure is pinned at its two ends: the library
// rule that throws, and the component code that used to violate it.
const root = join(import.meta.dir, '..', '..')

describe('empty select options', () => {
  test('reka-ui SelectItem still throws for value "" (why the sentinel exists)', () => {
    const src = readFileSync(join(root, 'node_modules/reka-ui/dist/Select/SelectItem.js'), 'utf8')
    expect(src).toMatch(/props\.value === ""\) throw new Error\("A <SelectItem \/> must have a value prop that is not an empty string/)
  })

  test('no component builds a select item with value ""', () => {
    const dir = join(root, 'app/components')
    const offenders = readdirSync(dir).filter(f => f.endsWith('.vue'))
      .filter(f => /label:[^\n]*,\s*value:\s*''\s*\}/.test(readFileSync(join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  test('items built with withEmptyOption never carry ""', () => {
    const items = withEmptyOption('none', [{ label: 'a', value: 'a' }])
    expect(items.every(i => i.value !== '')).toBe(true)
  })

  test('empty value round-trips through the select as the sentinel', () => {
    expect(toSelectValue('')).toBe(EMPTY_SELECT_VALUE)
    expect(toSelectValue(null)).toBe(EMPTY_SELECT_VALUE)
    expect(fromSelectValue(EMPTY_SELECT_VALUE)).toBe('')
    expect(fromSelectValue(toSelectValue(''))).toBe('')
  })

  test('real values pass through unchanged, so picking one then "empty" saves ""', () => {
    expect(fromSelectValue(toSelectValue('q8_0'))).toBe('q8_0')
    const picked = fromSelectValue('q8_0')
    expect(picked).toBe('q8_0')
    expect(fromSelectValue(EMPTY_SELECT_VALUE)).toBe('')
  })
})
