import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextBootSeq } from '../../server/core/boot-seq'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-boot-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const file = () => join(dir, 'run', 'boot.json')
const quiet = () => {}

test('the start number rises by one per start, whatever the clock says, and survives in the file', () => {
  const seen = [0, 1, 2].map(() => nextBootSeq(dir, quiet))
  expect(seen).toEqual([1, 2, 3])
  expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, seq: 3 })
})

test('a damaged or unknown-version file counts again from 1, like a missing one, without the clock', () => {
  mkdirSync(join(dir, 'run'), { recursive: true })
  const warnings: string[] = []
  for (const bad of ['{not json', JSON.stringify({ version: 2, seq: 4 }), JSON.stringify({ version: 1, seq: -1 }), JSON.stringify({ version: 1, seq: 'x' })]) {
    writeFileSync(file(), bad)
    expect(nextBootSeq(dir, m => warnings.push(m))).toBe(1)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, seq: 1 })
  }
  expect(warnings.length).toBe(4)
  expect(nextBootSeq(dir, quiet)).toBe(2) // and it counts on from there
})

test('a failed write publishes nothing, and the next start does not reuse a published number', () => {
  expect(nextBootSeq(dir, quiet)).toBe(1)
  expect(nextBootSeq(dir, quiet)).toBe(2)
  // A valid file, but the run directory refuses the replacement.
  chmodSync(join(dir, 'run'), 0o500)
  const warnings: string[] = []
  const got = nextBootSeq(dir, m => warnings.push(m))
  chmodSync(join(dir, 'run'), 0o700)
  if (process.getuid?.() === 0) return // root ignores the mode: nothing to prove here
  expect(got).toBeNull()
  expect(warnings.some(w => w.includes('cannot write'))).toBe(true)
  expect(JSON.parse(readFileSync(file(), 'utf8')).seq).toBe(2)
  // The failed run published nothing, so 3 is first handed out now; 2 was never reused.
  expect(nextBootSeq(dir, quiet)).toBe(3)
})
