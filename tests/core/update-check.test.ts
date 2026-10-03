import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateCheckStore, UPDATE_CHECK_INTERVAL_MS } from '../../server/core/update-check'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-check-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

test('application, CUDA and CPU checks keep independent timestamps when stores overlap', () => {
  const cuda = new UpdateCheckStore(data)
  const cpu = new UpdateCheckStore(data)
  const app = new UpdateCheckStore(data)
  cuda.save('cuda', 1000)
  cpu.save('cpu', 2000)
  app.save('app', 3000, { list: [] })
  const restored = new UpdateCheckStore(data)
  expect(restored.get('cuda')?.at).toBe(1000)
  expect(restored.get('cpu')?.at).toBe(2000)
  expect(restored.get('app')).toEqual({ at: 3000, result: { list: [] } })
  expect(JSON.parse(readFileSync(join(data, 'update-checks.json'), 'utf8')).version).toBe(1)
})

test('cooldown ends at exactly 24 hours; a clock correction does not block checks indefinitely', () => {
  const cache = new UpdateCheckStore(data)
  cache.save('app', 1000)
  expect(cache.remaining('app', 999)).toBe(0)
  expect(cache.remaining('app', 1000)).toBe(UPDATE_CHECK_INTERVAL_MS)
  expect(cache.remaining('app', 1000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(1)
  expect(cache.remaining('app', 1000 + UPDATE_CHECK_INTERVAL_MS)).toBe(0)
})

test('invalid timestamps are ignored without accepting a malformed cache result', () => {
  writeFileSync(join(data, 'update-checks.json'), JSON.stringify({ version: 1, checks: { app: { at: 'never' }, cpu: { at: -1 } } }))
  const cache = new UpdateCheckStore(data)
  expect(cache.remaining('app', 1000)).toBe(0)
  expect(cache.get('cpu')).toBeUndefined()
})
