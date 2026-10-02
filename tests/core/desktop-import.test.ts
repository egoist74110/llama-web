import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importData, recoverImport } from '../../desktop/import-data'
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
    expect(() => importData(source, target)).toThrow('importNotEmpty')
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
    expect(() => importData(source, join(source, 'nested'))).toThrow('importSeparate')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-import-'))
  const source = join(root, 'source'), target = join(root, 'target')
  mkdirSync(source)
  writeFileSync(join(source, 'settings.json'), '{"version":4,"modelDirs":[]}')
  writeFileSync(join(source, 'models.json'), '{"version":1,"models":[]}')
  writeFileSync(join(source, 'secrets.json'), '{"version":1,"apiKeys":[]}')
  return { root, source, target, marker: join(target, 'run', 'import.pending.json') }
}
test('failed publication keeps a complete backup and marker, recovery preserves partial edits and is repeatable', () => {
  const f = fixture()
  try {
    expect(() => importData(f.source, f.target, (phase, name) => {
      if (phase === 'publish' && name === 'settings.json') throw new Error('injected publish failure')
    })).toThrow('injected')
    expect(existsSync(f.marker)).toBe(true)
    const original = readFileSync(join(f.source, 'settings.json'), 'utf8')
    writeFileSync(join(f.target, 'settings.json'), 'partial edit')
    expect(() => importData(f.source, f.target)).toThrow('importPending')
    expect(recoverImport(f.target)).toBe(true)
    expect(recoverImport(f.target)).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
    expect(readFileSync(join(f.target, 'settings.json'), 'utf8')).toBe(original)
    const previous = readdirSync(join(f.root, 'import-backups')).find(n => n.includes('-recovery-'))!
    expect(readFileSync(join(f.root, 'import-backups', previous, 'settings.json'), 'utf8')).toBe('partial edit')
    acquireDataLock(f.source).release()
    acquireDataLock(f.target).release()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('interrupted recovery retains journal and original backup for another recovery', () => {
  const f = fixture()
  try {
    expect(() => importData(f.source, f.target, phase => { if (phase === 'backup') throw new Error('stop') })).toThrow('stop')
    expect(() => recoverImport(f.target, (_, name) => { if (name === 'models.json') throw new Error('stop recovery') })).toThrow('stop recovery')
    expect(existsSync(f.marker)).toBe(true)
    expect(recoverImport(f.target)).toBe(true)
    for (const name of ['settings.json', 'models.json', 'secrets.json']) {
      expect(readFileSync(join(f.target, name), 'utf8')).toBe(readFileSync(join(f.source, name), 'utf8'))
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('modified backup is rejected without changing partial data or clearing journal', () => {
  const f = fixture()
  try {
    expect(() => importData(f.source, f.target, phase => { if (phase === 'backup') throw new Error('stop') })).toThrow()
    const { backup } = JSON.parse(readFileSync(f.marker, 'utf8'))
    writeFileSync(join(f.root, 'import-backups', backup, 'secrets.json'), '{"version":1,"apiKeys":[],"changed":true}')
    expect(() => recoverImport(f.target)).toThrow('importBackupChanged')
    expect(existsSync(f.marker)).toBe(true)
    expect(existsSync(join(f.target, 'settings.json'))).toBe(false)
    acquireDataLock(f.target).release()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('foreign model directory paths are rejected before backup or publication', () => {
  const f = fixture()
  try {
    const path = process.platform === 'win32' ? '/Volumes/models' : 'X:\\models'
    writeFileSync(join(f.source, 'settings.json'), JSON.stringify({ version: 4, modelDirs: [{ path }] }))
    expect(() => importData(f.source, f.target)).toThrow('importForeignPaths')
    expect(existsSync(f.marker)).toBe(false)
    expect(existsSync(join(f.root, 'import-backups'))).toBe(false)
    acquireDataLock(f.source).release()
    acquireDataLock(f.target).release()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('legacy journal recovers, traversal journal is rejected and source pending import cannot be copied', () => {
  const f = fixture()
  try {
    const id = crypto.randomUUID(), backup = join(f.root, 'import-backups', id)
    mkdirSync(backup, { recursive: true })
    for (const name of ['settings.json', 'models.json', 'secrets.json']) writeFileSync(join(backup, name), readFileSync(join(f.source, name)))
    mkdirSync(join(f.target, 'run'), { recursive: true })
    writeFileSync(f.marker, JSON.stringify({ version: 1, backup: '../source' }))
    expect(() => recoverImport(f.target)).toThrow('importRecoveryInvalid')
    writeFileSync(f.marker, JSON.stringify({ version: 1, backup: id }))
    expect(recoverImport(f.target)).toBe(true)
    mkdirSync(join(f.source, 'run'), { recursive: true })
    writeFileSync(join(f.source, 'run', 'import.pending.json'), '{}')
    expect(() => importData(f.source, join(f.root, 'new-target'))).toThrow('importPending')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('incomplete backup returns to first run while retaining backup, never discards published data', () => {
  const f = fixture()
  try {
    const id = crypto.randomUUID(), backup = join(f.root, 'import-backups', id)
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'settings.json'), 'incomplete')
    mkdirSync(join(f.target, 'run'), { recursive: true })
    writeFileSync(f.marker, JSON.stringify({ version: 2, backup: id, phase: 'backup' }))
    writeFileSync(join(f.target, 'settings.json'), 'unexpected partial data')
    expect(() => recoverImport(f.target)).toThrow('importRecoveryInvalid')
    rmSync(join(f.target, 'settings.json'))
    expect(recoverImport(f.target)).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
    expect(readFileSync(join(backup, 'settings.json'), 'utf8')).toBe('incomplete')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('import refuses linked run directory before acquiring any lock outside target', () => {
  const f = fixture()
  try {
    const outside = join(f.root, 'outside')
    mkdirSync(outside); mkdirSync(f.target)
    symlinkSync(outside, join(f.target, 'run'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => importData(f.source, f.target)).toThrow('importLinks')
    expect(readdirSync(outside)).toEqual([])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('recovery rejects linked backup without touching it or clearing journal', () => {
  const f = fixture()
  try {
    const id = crypto.randomUUID(), backupRoot = join(f.root, 'import-backups')
    mkdirSync(backupRoot)
    symlinkSync(f.source, join(backupRoot, id), process.platform === 'win32' ? 'junction' : 'dir')
    mkdirSync(join(f.target, 'run'), { recursive: true })
    writeFileSync(f.marker, JSON.stringify({ version: 1, backup: id }))
    expect(() => recoverImport(f.target)).toThrow('importLinks')
    expect(existsSync(f.marker)).toBe(true)
    expect(readFileSync(join(f.source, 'settings.json'), 'utf8')).toBe('{"version":4,"modelDirs":[]}')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('hard-killed import releases stale owner on restart and restores complete data', async () => {
  const f = fixture()
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/interrupted-import.ts'), f.source, f.target], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const received = reader.read()
    const ready = await Promise.race([received, Bun.sleep(3000).then(() => { throw new Error('checkpoint timeout') })])
    expect(new TextDecoder().decode(ready.value)).toContain('checkpoint')
    reader.releaseLock()
    child.kill()
    await child.exited
    expect(existsSync(f.marker)).toBe(true)
    expect(recoverImport(f.target)).toBe(true)
    for (const name of ['settings.json', 'models.json', 'secrets.json']) expect(readFileSync(join(f.target, name), 'utf8')).toBe(readFileSync(join(f.source, name), 'utf8'))
    acquireDataLock(f.source).release()
  } finally {
    child.kill()
    await child.exited
    rmSync(f.root, { recursive: true, force: true })
  }
}, 10000)
