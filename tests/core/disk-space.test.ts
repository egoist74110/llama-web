// Free disk space before a download (decision 44): at least three times the download, nothing is fetched otherwise.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOWNLOAD_SPACE_FACTOR, freeBytes, neededBytes } from '../../server/core/disk-space'
import { download, RuntimeError } from '../../server/core/llamacpp'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-disk-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('three times the size is needed; an unknown size needs nothing', () => {
  expect(DOWNLOAD_SPACE_FACTOR).toBe(3)
  expect(neededBytes(100)).toBe(300)
  for (const v of [undefined, null, 0, -1, Number.NaN]) expect(neededBytes(v)).toBeNull()
})

test('free space is read for a directory that does not exist yet (nearest parent)', () => {
  const n = freeBytes(join(dir, 'not', 'yet'))
  expect(n).not.toBeNull()
  expect(n!).toBeGreaterThan(0)
})

test('a download that would not leave three times its size is refused before anything is fetched', async () => {
  let fetched = 0
  const fetchFn = (async () => { fetched++; return new Response('x') }) as typeof fetch
  const asset = { name: 'a.zip', browser_download_url: 'https://github.com/x/a.zip', size: 100, digest: null }
  const err = await download(fetchFn, asset, join(dir, 'a.zip'), {}, true, () => 299).catch(e => e)
  expect(err).toBeInstanceOf(RuntimeError)
  expect(err.code).toBe('disk-space')
  expect(err.detail).toBe('300')
  expect(fetched).toBe(0)
})

test('enough room, unknown room or unknown size: the download goes on', async () => {
  const fetchFn = (async () => new Response('hello')) as typeof fetch
  const asset = { name: 'a.zip', browser_download_url: 'https://github.com/x/a.zip', size: 100, digest: null }
  await download(fetchFn, asset, join(dir, 'ok.zip'), {}, true, () => 300)
  expect(readFileSync(join(dir, 'ok.zip'), 'utf8')).toBe('hello')
  await download(fetchFn, asset, join(dir, 'unknown.zip'), {}, true, () => null)
  await download(fetchFn, { ...asset, size: undefined }, join(dir, 'nosize.zip'), {}, true, () => 1)
  expect(readFileSync(join(dir, 'nosize.zip'), 'utf8')).toBe('hello')
})
