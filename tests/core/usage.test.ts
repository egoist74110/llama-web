import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, normalizeSettings } from '../../server/core/config'
import type { RequestRecord } from '../../server/core/request-log'
import { UsageError, UsageStore, csvCell, dayRange, normalizeUsageKeepDays } from '../../server/core/usage'

let dir: string
let clock: Date
let keep = 30
const mk = () => new UsageStore({ dir, keepDays: () => keep, now: () => clock, flushMs: 5 })

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'lw-usage-')), 'usage')
  clock = new Date(2026, 9, 3, 12, 0, 0)
  keep = 30
})
afterEach(() => { rmSync(join(dir, '..'), { recursive: true, force: true }) })

function rec(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 1, at: new Date(2026, 9, 3, 9, 30).getTime(), source: 'local', keyName: null, method: 'POST', path: '/v1/chat/completions',
    modelId: 'm1', modelName: 'Model One', profile: 'default', stream: false, status: 200, outcome: 'ok', error: null,
    durationMs: 1000, promptTokens: 10, completionTokens: 20, images: null, params: { temperature: 0.7, messages: 3 }, ...over,
  }
}

describe('aggregation', () => {
  test('same hour / model / profile / source / key accumulates into one row', () => {
    const u = mk()
    u.record(rec())
    u.record(rec({ outcome: 'error', status: 500, promptTokens: null, completionTokens: null, durationMs: 500 }))
    u.record(rec({ outcome: 'aborted', durationMs: 250, images: { count: 2, beforeBytes: 1, afterBytes: 1, compressed: 1, maxEdgeBefore: 1, maxEdgeAfter: 1 } }))
    const rows = u.rowsOf('2026-10-03')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hour: 9, requests: 3, ok: 1, error: 1, aborted: 1, promptTokens: 20, completionTokens: 40, durationMs: 1750, images: 2,
    })
  })

  test('different hour, model, source or key make separate rows', () => {
    const u = mk()
    u.record(rec())
    u.record(rec({ at: new Date(2026, 9, 3, 10, 0).getTime() }))
    u.record(rec({ modelId: 'm2', modelName: 'Two' }))
    u.record(rec({ source: 'public', keyName: 'alice' }))
    u.record(rec({ source: 'public', keyName: 'bob' }))
    expect(u.rowsOf('2026-10-03')).toHaveLength(5)
  })

  test('requests across midnight land in their own day (local time)', () => {
    const u = mk()
    u.record(rec({ at: new Date(2026, 9, 2, 23, 59, 59).getTime() }))
    u.record(rec({ at: new Date(2026, 9, 3, 0, 0, 0).getTime() }))
    expect(u.rowsOf('2026-10-02')[0]).toMatchObject({ hour: 23, requests: 1 })
    expect(u.rowsOf('2026-10-03')[0]).toMatchObject({ hour: 0, requests: 1 })
  })

  test('stores counters only: no params, path or content in the file', () => {
    const u = mk()
    u.record(rec())
    u.flush()
    const text = readFileSync(join(dir, '2026-10-03.json'), 'utf8')
    expect(text).not.toContain('temperature')
    expect(text).not.toContain('/v1/chat')
    expect(Object.keys(JSON.parse(text).rows[0]).sort()).toEqual([
      'aborted', 'completionTokens', 'durationMs', 'error', 'hour', 'images', 'keyName', 'modelId', 'modelName', 'ok', 'profile', 'promptTokens', 'requests', 'source',
    ])
  })

  test('a failed request without a model is kept under no model', () => {
    const u = mk()
    u.record(rec({ modelId: null, modelName: null, profile: null, status: 404, outcome: 'error', promptTokens: null, completionTokens: null }))
    expect(u.report('2026-10-03', '2026-10-03').by.model[0]).toMatchObject({ key: '', requests: 1, error: 1 })
  })
})

describe('persistence', () => {
  test('flush writes atomically (no temp file left) and close flushes the rest', () => {
    const u = mk()
    u.record(rec())
    expect(existsSync(join(dir, '2026-10-03.json'))).toBe(false)
    u.close()
    expect(readdirSync(dir)).toEqual(['2026-10-03.json'])
    // Records after close are ignored.
    u.record(rec())
    u.flush()
    expect(JSON.parse(readFileSync(join(dir, '2026-10-03.json'), 'utf8')).rows[0].requests).toBe(1)
  })

  test('a restart on the same day continues the file instead of replacing it', () => {
    const a = mk()
    a.record(rec())
    a.close()
    const b = mk()
    b.record(rec())
    b.close()
    expect(JSON.parse(readFileSync(join(dir, '2026-10-03.json'), 'utf8')).rows[0]).toMatchObject({ requests: 2, promptTokens: 20 })
  })

  test('the timer writes changed days by itself', async () => {
    const u = mk()
    u.start()
    u.record(rec())
    await new Promise(r => setTimeout(r, 40))
    u.close()
    expect(existsSync(join(dir, '2026-10-03.json'))).toBe(true)
  })

  test('a half-written or foreign file is skipped on read and does not stop the report', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-10-01.json'), '{"version":1,"day":"2026-10-01","rows":[{"hour":3,"sour')
    writeFileSync(join(dir, '2026-10-02.json'), JSON.stringify({ version: 1, day: '2026-10-02', rows: [
      { hour: 4, modelId: 'm1', modelName: 'M', profile: 'p', source: 'local', keyName: null, requests: 2, ok: 2, error: 0, aborted: 0, promptTokens: 5, completionTokens: 6, durationMs: 10, images: 0 },
      { hour: 99, source: 'local', requests: 100 }, // invalid hour
      'junk', null,
      { hour: 5, source: 'bogus', requests: 100 }, // invalid source
    ] }))
    const r = mk().report('2026-10-01', '2026-10-03')
    expect(r.daily.map(d => d.requests)).toEqual([0, 2, 0])
    expect(r.total).toMatchObject({ requests: 2, promptTokens: 5, completionTokens: 6 })
  })

  test('a corrupt file of today is replaced by fresh counts, not a crash', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-10-03.json'), 'not json')
    const u = mk()
    u.record(rec())
    u.close()
    expect(JSON.parse(readFileSync(join(dir, '2026-10-03.json'), 'utf8')).rows[0].requests).toBe(1)
  })

  test('unwritable directory does not throw from record / flush', () => {
    const blocker = join(dir, '..', 'file')
    writeFileSync(blocker, 'x')
    const u = new UsageStore({ dir: join(blocker, 'usage'), keepDays: () => 30, now: () => clock })
    expect(() => { u.record(rec()); u.flush(); u.close() }).not.toThrow()
  })
})

describe('retention', () => {
  const seed = (...days: string[]) => {
    mkdirSync(dir, { recursive: true })
    for (const d of days) writeFileSync(join(dir, `${d}.json`), JSON.stringify({ version: 1, day: d, rows: [] }))
  }

  test('keeps exactly the kept days ending today and removes older day files', () => {
    seed('2026-09-03', '2026-09-04', '2026-09-05', '2026-10-03')
    mk().prune()
    // 30 days ending 2026-10-03 start at 2026-09-04.
    expect(readdirSync(dir).sort()).toEqual(['2026-09-04', '2026-09-05', '2026-10-03'].map(d => `${d}.json`))
  })

  test('only files named YYYY-MM-DD.json are touched', () => {
    seed('2026-01-01')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, '2026-01-01.json.bak'), 'x')
    writeFileSync(join(dir, '2026-1-1.json'), 'x')
    mkdirSync(join(dir, '2026-01-02.json'))
    mk().prune()
    expect(readdirSync(dir).sort()).toEqual(['2026-01-01.json.bak', '2026-01-02.json', '2026-1-1.json', 'notes.txt'])
  })

  test('smaller keepDays applies at the next prune; hand-edited values are normalised', () => {
    seed('2026-09-25', '2026-09-26', '2026-10-03')
    keep = 7
    const u = mk()
    u.prune()
    expect(readdirSync(dir).sort()).toEqual(['2026-10-03.json'])
    keep = 500 // never more than 30
    seed('2026-09-03', '2026-09-04')
    u.prune()
    expect(readdirSync(dir).sort()).toEqual(['2026-09-04.json', '2026-10-03.json'])
  })

  test('a missing directory is fine', () => {
    expect(() => mk().prune()).not.toThrow()
  })

  test('the daily timer prunes when the day changes', async () => {
    seed('2026-09-04')
    const u = mk()
    u.prune() // 09-04 is the oldest kept day on 10-03
    expect(existsSync(join(dir, '2026-09-04.json'))).toBe(true)
    clock = new Date(2026, 9, 4, 0, 5)
    u.start()
    await new Promise(r => setTimeout(r, 40))
    u.close()
    expect(existsSync(join(dir, '2026-09-04.json'))).toBe(false)
  })

  test('normalizeUsageKeepDays picks 7 / 14 / 30, never above 30', () => {
    expect([7, 14, 30, 1, 8, 15, 29, 31, 9999].map(normalizeUsageKeepDays)).toEqual([7, 14, 30, 7, 14, 30, 30, 30, 30])
    for (const bad of [undefined, null, '14', NaN, Infinity]) expect(normalizeUsageKeepDays(bad)).toBe(30)
  })

  test('settings: default 30, old settings files get it, bad values are normalised', () => {
    expect(defaultSettings().logs.usageKeepDays).toBe(30)
    const old = defaultSettings()
    delete (old.logs as Partial<typeof old.logs>).usageKeepDays
    expect(normalizeSettings(old).logs.usageKeepDays).toBe(30)
    old.logs.usageKeepDays = 20
    expect(normalizeSettings(old).logs.usageKeepDays).toBe(30)
    old.logs.usageKeepDays = 10
    expect(normalizeSettings(old).logs.usageKeepDays).toBe(14)
  })
})

describe('report', () => {
  test('daily totals, groups, ordering and live (unflushed) data', () => {
    const u = mk()
    u.record(rec({ at: new Date(2026, 9, 1, 8).getTime(), promptTokens: 100, completionTokens: 50 }))
    u.record(rec({ at: new Date(2026, 9, 3, 8).getTime(), modelId: 'm2', modelName: 'Two', promptTokens: 1000, completionTokens: 1 }))
    u.record(rec({ at: new Date(2026, 9, 3, 8).getTime(), source: 'public', keyName: 'alice' }))
    const r = u.report('2026-10-01', '2026-10-03')
    expect(r.daily.map(d => [d.day, d.requests])).toEqual([['2026-10-01', 1], ['2026-10-02', 0], ['2026-10-03', 2]])
    expect(r.total).toMatchObject({ requests: 3, promptTokens: 1110, completionTokens: 71, ok: 3 })
    expect(r.by.model.map(g => [g.key, g.label, g.requests])).toEqual([['m2', 'Two', 1], ['m1', 'Model One', 2]])
    expect(r.by.source.map(g => g.key).sort()).toEqual(['local', 'public'])
    expect(r.by.key.find(g => g.key === 'alice')?.requests).toBe(1)
    expect(r.by.profile[0]).toMatchObject({ key: 'default', requests: 3 })
  })

  test('days outside the range are not counted; the default range is the kept 30 days', () => {
    const u = mk()
    u.record(rec({ at: new Date(2026, 8, 3).getTime() })) // 31 days ago: outside the default window
    u.record(rec())
    const r = u.report()
    expect(r.from).toBe('2026-09-04')
    expect(r.to).toBe('2026-10-03')
    expect(r.daily).toHaveLength(30)
    expect(r.total.requests).toBe(1)
  })

  test('dayRange validates dates and length', () => {
    expect(dayRange('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
    for (const [a, b] of [['2026-10-03', '2026-10-01'], ['2026-13-01', '2026-13-02'], ['2026-02-30', '2026-03-01'], ['x', 'y'], ['2026-01-01', '2026-12-31']]) {
      expect(() => dayRange(a!, b!)).toThrow(UsageError)
    }
  })
})

describe('csv', () => {
  test('hourly rows by default, one row per day and group when grouped', () => {
    const u = mk()
    u.record(rec())
    u.record(rec({ at: new Date(2026, 9, 3, 11).getTime(), modelId: 'm2', modelName: 'Two' }))
    const lines = u.csv('2026-10-03', '2026-10-03').trim().split('\r\n')
    expect(lines[0]).toBe('day,hour,model,profile,source,key,requests,ok,error,aborted,promptTokens,completionTokens,durationMs,images')
    expect(lines.slice(1)).toEqual([
      '2026-10-03,9,Model One,default,local,,1,1,0,0,10,20,1000,0',
      '2026-10-03,11,Two,default,local,,1,1,0,0,10,20,1000,0',
    ])
    const grouped = u.csv('2026-10-03', '2026-10-03', 'model').trim().split('\r\n')
    expect(grouped[0]).toBe('day,model,requests,ok,error,aborted,promptTokens,completionTokens,durationMs,images')
    expect(grouped).toHaveLength(3)
  })

  test('cells with commas / quotes are quoted and formula prefixes are defused', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
  })
})
