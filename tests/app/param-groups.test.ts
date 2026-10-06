import { describe, expect, test } from 'bun:test'
import { COMMON_FIELDS, MORE_FIELDS, PARAM_FIELDS } from '../../app/composables/useParamFields'

describe('parameter groups (common vs more)', () => {
  test('common = the first-start items; context and thinking, no duplicates anywhere', () => {
    expect(COMMON_FIELDS.map(f => f.key)).toEqual(['ctxSize', 'reasoning', 'mmprojOffload'])
    const more = MORE_FIELDS.map(f => f.key)
    expect(more.some(k => ['ctxSize', 'reasoning', 'mmprojOffload'].includes(k))).toBe(false)
  })

  test('every main parameter is shown exactly once; the raw thinking limit is replaced by the shortcut', () => {
    const shown = [...COMMON_FIELDS, ...MORE_FIELDS].map(f => f.key)
    expect(new Set(shown).size).toBe(shown.length)
    expect(shown).not.toContain('reasoningBudget')
    expect([...shown, 'reasoningBudget'].sort()).toEqual(PARAM_FIELDS.map(f => f.key).sort())
  })
})
