import { describe, expect, test } from 'bun:test'
import { diffLines, foldSame, MAX_DIFF_CELLS } from '../../app/utils/text-diff'

const ops = (a: string, b: string) => diffLines(a, b).map(r => `${r.op === 'same' ? ' ' : r.op === 'add' ? '+' : '-'}${r.text}`)

describe('diffLines', () => {
  test('empty texts', () => {
    expect(diffLines('', '')).toEqual([])
    expect(ops('', 'a\nb')).toEqual(['+a', '+b'])
    expect(ops('a\nb', '')).toEqual(['-a', '-b'])
  })

  test('identical texts are all unchanged', () => {
    expect(ops('a\nb\nc', 'a\nb\nc')).toEqual([' a', ' b', ' c'])
  })

  test('only added / only removed lines', () => {
    expect(ops('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c'])
    expect(ops('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c'])
  })

  test('a changed line in the middle is a removal followed by an addition', () => {
    expect(ops('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c'])
  })

  test('CRLF counts as LF', () => {
    expect(ops('a\r\nb', 'a\nb')).toEqual([' a', ' b'])
    expect(ops('a\r\nb\r\n', 'a\nb\nc')).toEqual([' a', ' b', '-', '+c'])
  })

  test('moved lines are found through the LCS', () => {
    expect(ops('a\nb\nc\nd', 'b\nc\nd\na')).toEqual(['-a', ' b', ' c', ' d', '+a'])
  })

  test('too big a difference degrades to remove-all then add-all', () => {
    const n = Math.floor(Math.sqrt(MAX_DIFF_CELLS)) + 5
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join('\n')
    const rows = diffLines(a, b)
    expect(rows).toHaveLength(2 * n)
    expect(rows.slice(0, n).every(r => r.op === 'del')).toBe(true)
    expect(rows.slice(n).every(r => r.op === 'add')).toBe(true)
  })

  test('a common head and tail do not count toward the limit', () => {
    const n = Math.floor(Math.sqrt(MAX_DIFF_CELLS)) + 5
    const lines = Array.from({ length: n }, (_, i) => `l${i}`)
    const changed = [...lines]
    changed[Math.floor(n / 2)] = 'x'
    const rows = diffLines(lines.join('\n'), changed.join('\n'))
    expect(rows.filter(r => r.op !== 'same')).toEqual([{ op: 'del', text: `l${Math.floor(n / 2)}` }, { op: 'add', text: 'x' }])
  })
})

describe('foldSame', () => {
  const same = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ op: 'same' as const, text: `s${from + i}` }))

  test('short runs stay as they are', () => {
    const rows = [...same(6), { op: 'add' as const, text: 'x' }, ...same(6, 6)]
    expect(foldSame(rows)).toEqual(rows)
  })

  test('a long run in the middle keeps 3 lines on both sides', () => {
    const rows = [{ op: 'del' as const, text: 'a' }, ...same(10), { op: 'add' as const, text: 'b' }]
    const folded = foldSame(rows)
    expect(folded).toHaveLength(1 + 3 + 1 + 3 + 1)
    expect(folded[4]).toEqual({ op: 'fold', rows: same(10).slice(3, 7) })
  })

  test('a long leading / trailing run keeps only the side next to a change', () => {
    const rows = [...same(9), { op: 'add' as const, text: 'x' }, ...same(9, 9)]
    const folded = foldSame(rows)
    expect(folded[0]).toEqual({ op: 'fold', rows: same(6) })
    expect(folded.slice(1, 4)).toEqual(same(9).slice(6))
    expect(folded[4]).toEqual({ op: 'add', text: 'x' })
    expect(folded.at(-1)).toEqual({ op: 'fold', rows: same(9, 9).slice(3) })
  })

  test('text without changes folds as a whole when long', () => {
    expect(foldSame(same(10))).toEqual([{ op: 'fold', rows: same(10) }])
    expect(foldSame(same(5))).toEqual(same(5))
    expect(foldSame([])).toEqual([])
  })
})
