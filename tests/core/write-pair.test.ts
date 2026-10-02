import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../../server/core/store'
import { Hold, writePair } from '../../server/core/write-pair'

interface Doc { version: number, value: string }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-pair-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const store = (name: string) => new JsonStore<Doc>({ dataDir: dir, name, version: 1, defaults: () => ({ version: 1, value: 'old' }) })

test('both writes succeed: both files carry the new values', () => {
  const a = store('a.json')
  const b = store('b.json')
  a.load(); b.load()
  writePair(() => a.update((d) => { d.value = 'new' }), () => b.update((d) => { d.value = 'new' }), () => a.update((d) => { d.value = 'old' }))
  expect([a.get().value, b.get().value]).toEqual(['new', 'new'])
})

test('second file unwritable (hand-edited into invalid JSON): the first is put back, the error is the second one\'s', () => {
  const a = store('a.json')
  const b = store('b.json')
  a.load(); b.load()
  writeFileSync(b.file, '{ not json')
  let undone = 0
  expect(() => writePair(
    () => a.update((d) => { d.value = 'new' }),
    () => b.update((d) => { d.value = 'new' }),
    () => { undone++; a.update((d) => { d.value = 'old' }) },
  )).toThrow()
  expect(undone).toBe(1)
  expect(store('a.json').load().value).toBe('old')
})

test('first write fails: nothing to undo, the second is not attempted', () => {
  let second = 0
  let undone = 0
  expect(() => writePair(() => { throw new Error('first') }, () => { second++ }, () => { undone++ })).toThrow('first')
  expect([second, undone]).toEqual([0, 0])
})

test('undo failing as well reports both', () => {
  try {
    writePair(() => {}, () => { throw new Error('second') }, () => { throw new Error('undo') })
    throw new Error('did not throw')
  } catch (e) {
    expect(e).toBeInstanceOf(AggregateError)
    expect((e as Error).message).toContain('second')
    expect((e as Error).message).toContain('undo')
  }
})

test('Hold: muted while held, one reconciliation afterwards on success and on failure, nested groups reconcile once at the end', () => {
  const hold = new Hold()
  const log: string[] = []
  const onChange = () => { if (!hold.held) log.push('apply'); else log.push('muted') }
  hold.run(() => { onChange(); onChange() }, () => log.push('reconcile'))
  expect(log).toEqual(['muted', 'muted', 'reconcile'])
  expect(hold.held).toBe(false)
  log.length = 0
  expect(() => hold.run(() => { onChange(); throw new Error('write failed') }, () => log.push('reconcile'))).toThrow('write failed')
  expect(log).toEqual(['muted', 'reconcile'])
  log.length = 0
  hold.run(() => hold.run(() => onChange(), () => log.push('inner')), () => log.push('outer'))
  expect(log).toEqual(['muted', 'outer'])
  onChange()
  expect(log.at(-1)).toBe('apply')
})
