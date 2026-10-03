import { expect, test } from 'bun:test'
import { checkNewDir, dirKey } from '../../app/utils/model-dirs'

const row = (path: string, over: { enabled?: boolean, maxDepth?: number } = {}) => ({ path, enabled: true, maxDepth: 3, ...over })

test('dirKey ignores quotes, trailing separators and (on Windows only) case', () => {
  expect(dirKey('"X:\\Models\\"', true)).toBe('x:/models')
  expect(dirKey('/Volumes/Models/', false)).toBe('/Volumes/Models')
  expect(dirKey('/Volumes/Models', false)).not.toBe(dirKey('/volumes/models', false))
})

test('same folder is a duplicate, however it is written', () => {
  expect(checkNewDir([row('X:\\models')], 'x:\\Models\\', true)).toEqual({ kind: 'duplicate', path: 'X:\\models' })
  expect(checkNewDir([row('/Volumes/m')], '/Volumes/m/', false)).toEqual({ kind: 'duplicate', path: '/Volumes/m' })
})

test('a subfolder within the scan depth of an enabled folder is already covered', () => {
  const dirs = [row('/Volumes/m', { maxDepth: 2 })]
  expect(checkNewDir(dirs, '/Volumes/m/a', false)).toEqual({ kind: 'inside', path: '/Volumes/m', depth: 2 })
  expect(checkNewDir(dirs, '/Volumes/m/a/b', false)).toEqual({ kind: 'inside', path: '/Volumes/m', depth: 2 })
})

test('deeper than the scan depth, under a disabled folder, or a lookalike name is ok', () => {
  expect(checkNewDir([row('/Volumes/m', { maxDepth: 1 })], '/Volumes/m/a/b', false)).toEqual({ kind: 'ok' })
  expect(checkNewDir([row('/Volumes/m', { enabled: false })], '/Volumes/m/a', false)).toEqual({ kind: 'ok' })
  expect(checkNewDir([row('/Volumes/m')], '/Volumes/m2', false)).toEqual({ kind: 'ok' })
  expect(checkNewDir([], '/Volumes/m', false)).toEqual({ kind: 'ok' })
})

test('a folder that contains an existing one is allowed', () => {
  expect(checkNewDir([row('/Volumes/m/a')], '/Volumes/m', false)).toEqual({ kind: 'ok' })
})
