import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore, resolveDataDir, StoreError, writeFileAtomic } from '../../server/core/store'

interface Doc { version: number, items: string[], extra?: string }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const make = (over: Partial<ConstructorParameters<typeof JsonStore<Doc>>[0]> = {}) =>
  new JsonStore<Doc>({ dataDir: dir, name: 'doc.json', version: 1, defaults: () => ({ version: 1, items: [] }), ...over })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(25)
  return cond()
}

test('resolveDataDir honours LLAMA_WEB_DATA', () => {
  expect(resolveDataDir({ LLAMA_WEB_DATA: dir }, 'X:\\proj')).toBe(dir)
  expect(resolveDataDir({}, dir)).toBe(join(dir, 'data'))
})

test('load creates the file from defaults', () => {
  const s = make()
  expect(s.load()).toEqual({ version: 1, items: [] })
  expect(JSON.parse(readFileSync(s.file, 'utf8')).version).toBe(1)
})

test('save is atomic: no temp files left, content replaced', () => {
  const s = make()
  s.load()
  s.save({ version: 1, items: ['a'] })
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  expect(JSON.parse(readFileSync(s.file, 'utf8')).items).toEqual(['a'])
})

test('writeFileAtomic cleans up the temp file when the rename fails', () => {
  const target = join(dir, 'sub')
  writeFileAtomic(join(target, 'x.json'), '{}') // creates the directory
  // Renaming a file over a directory fails on every platform.
  expect(() => writeFileAtomic(target, '{}')).toThrow()
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
})

const backupItems = () => readdirSync(join(dir, 'backups'))
  .map(f => JSON.parse(readFileSync(join(dir, 'backups', f), 'utf8')).items[0] as string)
  .sort((a, b) => Number(a) - Number(b))

test('every overwrite keeps a backup of the previous content; old backups are pruned', () => {
  let t = Date.parse('2026-01-01T00:00:00Z')
  const s = make({ keepBackups: 3, now: () => new Date(t += 5) })
  s.load()
  for (let i = 1; i <= 6; i++) s.save({ version: 1, items: [String(i)] })
  // Backups hold the content from before each of the last three saves.
  expect(backupItems()).toEqual(['3', '4', '5'])
})

test('same-millisecond backups are pruned oldest first, including two-digit suffixes', () => {
  const fixed = new Date('2026-01-01T00:00:00Z')
  const s = make({ keepBackups: 3, now: () => fixed })
  s.load()
  s.save({ version: 1, items: ['0'] })
  for (let i = 1; i <= 13; i++) s.save({ version: 1, items: [String(i)] })
  expect(backupItems()).toEqual(['10', '11', '12'])
})

test('backups of different files do not prune each other', () => {
  const a = make({ name: 'a.json', keepBackups: 1 })
  const ab = make({ name: 'a.b.json', keepBackups: 1 })
  a.load(); ab.load()
  a.save({ version: 1, items: ['x'] }); ab.save({ version: 1, items: ['y'] })
  a.save({ version: 1, items: ['x2'] }); ab.save({ version: 1, items: ['y2'] })
  const names = readdirSync(join(dir, 'backups'))
  expect(names.filter(n => n.startsWith('a.b.')).length).toBe(1)
  expect(names.filter(n => !n.startsWith('a.b.')).length).toBe(1)
})

test('update mutates a copy and saves', () => {
  const s = make()
  s.load()
  s.update(d => { d.items.push('z') })
  expect(s.get().items).toEqual(['z'])
})

test('migrates old versions step by step and backs up the old file', () => {
  writeFileSync(join(dir, 'doc.json'), JSON.stringify({ version: 1, items: ['a'] }))
  const s = make({
    version: 3,
    defaults: () => ({ version: 3, items: [] }),
    migrations: {
      1: old => ({ ...old, extra: 'v2' }),
      2: old => ({ ...old, extra: `${old.extra}+v3` }),
    },
  })
  const doc = s.load()
  expect(doc).toEqual({ version: 3, items: ['a'], extra: 'v2+v3' })
  expect(JSON.parse(readFileSync(s.file, 'utf8')).version).toBe(3)
  const backups = readdirSync(join(dir, 'backups'))
  expect(backups.length).toBe(1)
  expect(JSON.parse(readFileSync(join(dir, 'backups', backups[0]!), 'utf8')).version).toBe(1)
})

test('rejects corrupt JSON, missing version, newer version and missing migration without touching the file', () => {
  const p = join(dir, 'doc.json')
  const codeOf = (text: string, opts = {}) => {
    writeFileSync(p, text)
    try { make(opts).load() } catch (e) { return (e as StoreError).code }
    return null
  }
  expect(codeOf('{ nope')).toBe('corrupt')
  expect(codeOf('{"items":[]}')).toBe('invalid')
  expect(codeOf('{"version":9,"items":[]}')).toBe('newer-version')
  expect(codeOf('{"version":1,"items":[]}', { version: 2, defaults: () => ({ version: 2, items: [] }) })).toBe('invalid')
  expect(readFileSync(p, 'utf8')).toBe('{"version":1,"items":[]}')
  expect(existsSync(join(dir, 'backups'))).toBe(false)
})

test('validate failures are reported as invalid', () => {
  writeFileSync(join(dir, 'doc.json'), '{"version":1,"items":"oops"}')
  const s = make({ validate: d => { if (!Array.isArray(d.items)) throw new Error('items must be an array'); return d } })
  expect(() => s.load()).toThrow(StoreError)
})

test('watch reloads hand edits, ignores own saves, keeps old value on bad edits', async () => {
  const s = make()
  s.load()
  const changes: string[][] = []
  const errors: unknown[] = []
  s.watch(next => changes.push(next.items), e => errors.push(e))
  try {
    s.save({ version: 1, items: ['own'] })
    await sleep(400)
    expect(changes).toEqual([])

    writeFileSync(s.file, JSON.stringify({ version: 1, items: ['edited'] }))
    expect(await waitFor(() => changes.length === 1)).toBe(true)
    expect(changes[0]).toEqual(['edited'])
    expect(s.get().items).toEqual(['edited'])

    writeFileSync(s.file, '{ broken')
    expect(await waitFor(() => errors.length === 1)).toBe(true)
    expect(s.get().items).toEqual(['edited'])
  } finally {
    s.close()
  }
})

test('update starts from a hand edit already on disk, even before the watcher reports it', () => {
  const s = make()
  s.load()
  s.watch(() => {})
  try {
    writeFileSync(s.file, JSON.stringify({ version: 1, items: ['hand'] }))
    s.update(d => { d.items.push('mine') }) // immediately, inside the watcher's debounce
    expect(JSON.parse(readFileSync(s.file, 'utf8')).items).toEqual(['hand', 'mine'])
  } finally {
    s.close()
  }
})

test('refresh / update refuse to overwrite a broken hand edit', () => {
  const s = make()
  s.load()
  writeFileSync(s.file, '{ half-typed')
  expect(() => s.refresh()).toThrow(StoreError)
  expect(() => s.update(d => { d.items.push('x') })).toThrow(StoreError)
  expect(readFileSync(s.file, 'utf8')).toBe('{ half-typed')
})

test('a hand edit picked up by refresh is reported even when the following save fails', async () => {
  const s = make()
  s.load()
  const seen: string[][] = []
  s.watch(next => seen.push(next.items))
  try {
    writeFileSync(join(dir, 'backups'), 'not a directory') // backup (and so the save) fails
    writeFileSync(s.file, JSON.stringify({ version: 1, items: ['hand'] }))
    expect(() => s.update(d => { d.items.push('mine') })).toThrow()
    expect(seen).toEqual([['hand']]) // reported at once, not left to the watcher
    await sleep(300)
    expect(seen).toEqual([['hand']]) // and not twice
    expect(JSON.parse(readFileSync(s.file, 'utf8')).items).toEqual(['hand'])
  } finally {
    s.close()
  }
})

test('context openStore: after a failed save the getter still shows the valid hand edit', async () => {
  const { openStore } = await import('../../server/service/context')
  const store = make()
  const ref = openStore(store, () => ({ version: 1, items: [] }))
  try {
    writeFileSync(join(dir, 'backups'), 'not a directory')
    writeFileSync(store.file, JSON.stringify({ version: 1, items: ['hand'] }))
    expect(() => ref.update(d => { d.items.push('mine') })).toThrow()
    expect(ref.get().items).toEqual(['hand'])
    await sleep(300)
    expect(ref.get().items).toEqual(['hand'])
  } finally {
    store.close()
  }
})
