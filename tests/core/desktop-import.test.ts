import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importData } from '../../desktop/import-data'
import { acquireDataLock } from '../../server/core/data-lock'
test('desktop import backs up selected data, excludes run state, preserves source and refuses overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-import-'))
  try {
    const source = join(root, 'source'), target = join(root, 'target')
    mkdirSync(source)
    writeFileSync(join(source, 'settings.json'), '{"version":3}')
    writeFileSync(join(source, 'models.json'), '{"version":1,"models":[]}')
    writeFileSync(join(source, 'secrets.json'), '{"version":3,"apiKeys":[]}')
    mkdirSync(join(source, 'run'))
    writeFileSync(join(source, 'run', 'pids.json'), '{"version":2,"processes":[]}')
    const backup = importData(source, target)
    expect(readFileSync(join(target, 'secrets.json'), 'utf8')).toBe(readFileSync(join(backup, 'secrets.json'), 'utf8'))
    expect(readFileSync(join(source, 'settings.json'), 'utf8')).toBe('{"version":3}')
    expect(() => readFileSync(join(target, 'run', 'pids.json'))).toThrow()
    expect(() => importData(source, target)).toThrow('not empty')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('desktop import refuses an active source and nested target', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-import-'))
  try {
    const source = join(root, 'source')
    mkdirSync(source)
    const lock = acquireDataLock(source)
    try { expect(() => importData(source, join(root, 'target'))).toThrow('already in use') }
    finally { lock.release() }
    expect(() => importData(source, join(source, 'nested'))).toThrow('separate')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
