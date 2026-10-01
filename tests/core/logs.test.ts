import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogError, LogStore, modelDirName, modelIdFromDir } from '../../server/core/logs'

let dir: string
let clock: Date
let retention = { keepRunsPerModel: 3, keepDays: 2 }
const mk = () => new LogStore({ dir, retention: () => retention, now: () => clock, flushMs: 5 })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-logs-'))
  clock = new Date(2026, 8, 30, 14, 2, 5)
  retention = { keepRunsPerModel: 3, keepDays: 2 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('model directory names', () => {
  test('safe ids stay readable, others are encoded and decode back', () => {
    expect(modelDirName('qwen-27b_v2')).toBe('qwen-27b_v2')
    for (const id of ['a b', '模型', 'x/y', '..', 'a~b', 'con:1', '']) {
      const d = modelDirName(id)
      expect(d).toMatch(/^[A-Za-z0-9_~-]+$/)
      expect(modelIdFromDir(d)).toBe(id)
    }
  })
})

describe('model output files', () => {
  test('one file per start, named by local time, lines flushed on close', () => {
    const logs = mk()
    const run = logs.startRun('m1')
    run.append('line one')
    run.append('line two')
    run.close()
    const files = readdirSync(join(dir, 'models', 'm1'))
    expect(files).toEqual(['2026-09-30_14-02-05.log'])
    expect(readFileSync(join(dir, 'models', 'm1', files[0]!), 'utf8')).toBe('line one\nline two\n')
    // A second start in the same second gets its own file.
    const again = logs.startRun('m1')
    again.close()
    expect(readdirSync(join(dir, 'models', 'm1')).sort()).toEqual(['2026-09-30_14-02-05-2.log', '2026-09-30_14-02-05.log'])
  })

  test('buffered lines reach the file without close() (a crash keeps them)', async () => {
    const logs = mk()
    const run = logs.startRun('m1')
    run.append('before crash')
    await Bun.sleep(40)
    expect(readFileSync(run.file, 'utf8')).toBe('before crash\n')
    logs.closeAll()
    expect(run.isOpen).toBe(false)
  })

  test('keeps the newest N runs per model and never removes a file that is still open', () => {
    const logs = mk()
    const open = logs.startRun('m1') // oldest, still open
    for (let i = 1; i <= 5; i++) {
      clock = new Date(2026, 8, 30, 14, 2, 5 + i)
      logs.startRun('m1').close()
    }
    clock = new Date(2026, 8, 30, 15, 0, 0)
    logs.startRun('other').close()
    const files = readdirSync(join(dir, 'models', 'm1')).sort()
    expect(files).toHaveLength(4) // newest 3 closed + the open one
    expect(files).toContain('2026-09-30_14-02-05.log')
    expect(files).toContain('2026-09-30_14-02-10.log')
    expect(readdirSync(join(dir, 'models', 'other'))).toHaveLength(1)
    open.close()
    logs.prune()
    expect(readdirSync(join(dir, 'models', 'm1'))).toHaveLength(3)
  })
})

describe('events and requests', () => {
  test('append jsonl per day and drop files older than keepDays', () => {
    const logs = mk()
    logs.appendEvent({ id: 1, kind: 'state' })
    logs.appendRequest({ id: 1, status: 200 })
    logs.appendRequest({ id: 2, status: 404 })
    expect(readFileSync(join(dir, 'requests', '2026-09-30.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).id)).toEqual([1, 2])
    expect(existsSync(join(dir, 'events', '2026-09-30.jsonl'))).toBe(true)

    for (const day of ['2026-09-26', '2026-09-27', '2026-09-28']) {
      writeFileSync(join(dir, 'requests', `${day}.jsonl`), '{}\n')
      writeFileSync(join(dir, 'events', `${day}.jsonl`), '{}\n')
    }
    logs.prune()
    // keepDays 2 on 09-30: 09-28 is the oldest kept day.
    expect(readdirSync(join(dir, 'requests')).sort()).toEqual(['2026-09-28.jsonl', '2026-09-30.jsonl'])
    expect(readdirSync(join(dir, 'events')).sort()).toEqual(['2026-09-28.jsonl', '2026-09-30.jsonl'])
  })

  test('a new day prunes by itself', () => {
    const logs = mk()
    logs.appendRequest({ id: 1 })
    clock = new Date(2026, 9, 3, 9, 0, 0)
    logs.appendRequest({ id: 2 })
    expect(readdirSync(join(dir, 'requests'))).toEqual(['2026-10-03.jsonl'])
  })
})

describe('listing and reading', () => {
  test('lists models (newest first), event and request days', () => {
    const logs = mk()
    logs.startRun('b').close()
    clock = new Date(2026, 8, 30, 14, 3, 0)
    logs.startRun('a').close()
    logs.startRun('a').close()
    logs.appendEvent({ id: 1 })
    logs.appendRequest({ id: 1 })
    const l = logs.list()
    expect(l.models.map(m => m.model)).toEqual(['a', 'b'])
    expect(l.models[0]!.files.map(f => f.name)).toEqual(['2026-09-30_14-03-00-2.log', '2026-09-30_14-03-00.log'])
    expect(l.events.map(f => f.name)).toEqual(['2026-09-30.jsonl'])
    expect(l.requests[0]!.size).toBeGreaterThan(0)
  })

  test('read returns the end of a file and reports truncation', () => {
    const logs = mk()
    const run = logs.startRun('m1')
    for (let i = 0; i < 100; i++) run.append(`line ${i}`)
    run.close()
    const name = readdirSync(join(dir, 'models', 'm1'))[0]!
    expect(logs.read('model', name, 'm1').lines).toHaveLength(100)
    const tail = logs.read('model', name, 'm1', { maxLines: 10 })
    expect(tail.lines[0]).toBe('line 90')
    expect(tail.truncated).toBe(true)
    const bytes = logs.read('model', name, 'm1', { maxBytes: 40 })
    expect(bytes.truncated).toBe(true)
    expect(bytes.lines.at(-1)).toBe('line 99')
    expect(bytes.lines.every(l => /^line \d+$/.test(l))).toBe(true) // the cut-off first line is dropped
  })

  test('only plain log file names inside the log root can be read', () => {
    const logs = mk()
    logs.startRun('m1').close()
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'x.log'), 'nope')
    const outcome = (kind: 'model' | 'events' | 'requests', name: string, model?: string) => {
      try { logs.read(kind, name, model) } catch (e) { return (e as LogError).code }
      return 'read'
    }
    expect(outcome('model', '../../secrets/x.log', 'm1')).toBe('bad-name')
    expect(outcome('model', '..\\..\\secrets\\x.log', 'm1')).toBe('bad-name')
    expect(outcome('model', 'x.log', 'm1')).toBe('bad-name')
    expect(outcome('events', '../secrets/x.log')).toBe('bad-name')
    expect(outcome('model', '2026-09-30_14-02-05.log')).toBe('bad-name') // no model
    expect(outcome('model', '2026-09-30_14-02-05.log', '../secrets')).toBe('not-found') // encoded, so just a missing directory
    expect(outcome('model', '2026-01-01_00-00-00.log', 'm1')).toBe('not-found')
    expect(outcome('model', '2026-09-30_14-02-05.log', 'm1')).toBe('read')
  })

  test('a missing log directory lists as empty', () => {
    const logs = new LogStore({ dir: join(dir, 'nowhere'), retention: () => retention })
    expect(logs.list()).toEqual({ models: [], events: [], requests: [] })
    logs.prune()
  })

  test('file times are kept for the listing', () => {
    const logs = mk()
    const run = logs.startRun('m1')
    run.close()
    const t = new Date(2026, 0, 2, 3, 4, 5)
    utimesSync(run.file, t, t)
    expect(logs.list().models[0]!.files[0]!.mtime).toBe(t.getTime())
  })
})

describe('symlinks (review CR-002)', () => {
  test('a link with a valid log name is not followed', () => {
    const logs = mk()
    mkdirSync(join(dir, 'requests'), { recursive: true })
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'secret\n')
    try { symlinkSync(outside, join(dir, 'requests', '2026-09-30.jsonl')) } catch { return } // no symlink right on this machine
    expect(() => logs.read('requests', '2026-09-30.jsonl')).toThrow(LogError)
  })
})
