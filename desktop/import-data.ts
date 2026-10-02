// Explicit offline import. Recovery never starts a service with partially published data.
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep, win32, posix } from 'node:path'
import { acquireDataLock } from '../server/core/data-lock'
import { writeFileAtomic } from '../server/core/store'

const names = ['settings.json', 'models.json', 'secrets.json', 'templates', 'runtime', 'logs', 'backups']
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
class ImportError extends Error {}
function reject(code: string): never { throw new ImportError(code) }
function contains(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
function checkTree(path: string) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) reject('importLinks')
  if (stat.isDirectory()) for (const name of readdirSync(path)) checkTree(join(path, name))
  else if (!stat.isFile()) reject('importInvalid')
}
function configs(source: string, platform = process.platform) {
  const settings = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8'))
  const models = JSON.parse(readFileSync(join(source, 'models.json'), 'utf8'))
  for (const doc of [settings, models]) if (!Number.isInteger(doc?.version) || doc.version < 1) reject('importInvalid')
  if (!Array.isArray(settings.modelDirs ?? []) || !Array.isArray(models.models)) reject('importInvalid')
  if (platform === 'win32' && settings.llamacpp?.acceleration === 'metal') reject('importForeignPaths')
  // Directory references are platform-specific; never translate or launch foreign paths.
  for (const dir of settings.modelDirs ?? []) {
    if (typeof dir?.path !== 'string' || !(platform === 'win32'
      ? win32.isAbsolute(dir.path) && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(dir.path)
      : posix.isAbsolute(dir.path) && !/^[a-z]:|^\\\\/i.test(dir.path))) reject('importForeignPaths')
  }
}
function backupRoot(target: string) {
  const root = join(dirname(target), 'import-backups')
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) reject('importLinks')
  mkdirSync(root, { recursive: true })
  return root
}
function fingerprint(root: string): string {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  function visit(path: string) {
    const stat = lstatSync(path)
    hash.update(JSON.stringify([relative(root, path), stat.isDirectory() ? 'dir' : stat.size]))
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
    else {
      const fd = openSync(path, 'r')
      try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)) }
      finally { closeSync(fd) }
    }
  }
  for (const name of names) if (existsSync(join(root, name))) visit(join(root, name))
  return hash.digest('hex')
}
function prepareStage(backup: string, stage: string) {
  if (existsSync(stage)) { checkTree(stage); rmSync(stage, { recursive: true }) }
  mkdirSync(stage)
  for (const name of names) if (existsSync(join(backup, name))) cpSync(join(backup, name), join(stage, name), { recursive: true })
}
type Checkpoint = (phase: 'backup' | 'publish', name?: string) => void

export function importData(sourcePath: string, targetPath: string, checkpoint?: Checkpoint) {
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath)) reject('importAbsolute')
  const source = realpathSync(sourcePath)
  mkdirSync(targetPath, { recursive: true })
  const target = realpathSync(targetPath)
  if (contains(source, target) || contains(target, source)) reject('importSeparate')
  for (const root of [source, target]) if (existsSync(join(root, 'run'))) checkTree(join(root, 'run'))
  const sourceLock = acquireDataLock(source)
  let targetLock: ReturnType<typeof acquireDataLock> | undefined
  const id = crypto.randomUUID(), stage = join(dirname(target), `.import-stage-${id}`)
  try {
    targetLock = acquireDataLock(target)
    if (existsSync(join(source, 'run', 'import.pending.json')) || existsSync(join(target, 'run', 'import.pending.json'))) reject('importPending')
    if (readdirSync(target).some(n => n !== 'run')) reject('importNotEmpty')
    configs(source)
    for (const name of names) if (existsSync(join(source, name))) checkTree(join(source, name))
    const backup = join(backupRoot(target), id), marker = join(target, 'run', 'import.pending.json')
    writeFileAtomic(marker, JSON.stringify({ version: 2, backup: id, phase: 'backup' }))
    mkdirSync(backup)
    // Complete the immutable backup before publishing any imported data.
    for (const name of names) if (existsSync(join(source, name))) cpSync(join(source, name), join(backup, name), { recursive: true })
    writeFileAtomic(join(backup, 'complete.json'), JSON.stringify({ version: 1, digest: fingerprint(backup) }))
    checkpoint?.('backup')
    prepareStage(backup, stage)
    writeFileAtomic(marker, JSON.stringify({ version: 2, backup: id, phase: 'publish' }))
    // Keep the marker on every failure. Recovery can republish the complete backup.
    for (const name of names) if (existsSync(join(stage, name))) {
      renameSync(join(stage, name), join(target, name))
      checkpoint?.('publish', name)
    }
    rmSync(stage, { recursive: true })
    rmSync(marker)
    return backup
  } finally {
    try { if (existsSync(stage)) rmSync(stage, { recursive: true }) }
    finally { try { targetLock?.release() } finally { sourceLock.release() } }
  }
}

export function recoverImport(targetPath: string, checkpoint?: Checkpoint) {
  if (!isAbsolute(targetPath)) reject('importAbsolute')
  const target = realpathSync(targetPath)
  if (existsSync(join(target, 'run'))) checkTree(join(target, 'run'))
  const lock = acquireDataLock(target)
  let stage: string | undefined
  try {
    const marker = join(target, 'run', 'import.pending.json')
    if (!existsSync(marker)) return false
    checkTree(marker)
    const doc = JSON.parse(readFileSync(marker, 'utf8'))
    if (![1, 2].includes(doc?.version) || typeof doc.backup !== 'string' || !uuid.test(doc.backup)
      || (doc.version === 2 && !['backup', 'publish'].includes(doc.phase))) reject('importRecoveryInvalid')
    const backup = join(backupRoot(target), doc.backup)
    if (readdirSync(target).some(n => n !== 'run' && !names.includes(n))) reject('importNotEmpty')
    stage = join(dirname(target), `.import-stage-${doc.backup}`)
    if (doc.version === 2 && doc.phase === 'backup' && !existsSync(join(backup, 'complete.json'))) {
      // No publication has started. Keep the incomplete backup and return to first run.
      if (readdirSync(target).some(n => n !== 'run')) reject('importRecoveryInvalid')
      if (existsSync(stage)) { checkTree(stage); rmSync(stage, { recursive: true }) }
      rmSync(marker)
      return false
    }
    checkTree(backup)
    configs(backup)
    if (doc.version === 2) {
      const complete = JSON.parse(readFileSync(join(backup, 'complete.json'), 'utf8'))
      if (complete.version !== 1 || complete.digest !== fingerprint(backup)) reject('importBackupChanged')
    }
    for (const name of names) if (existsSync(join(target, name))) checkTree(join(target, name))
    prepareStage(backup, stage)
    const previous = join(backupRoot(target), `${doc.backup}-recovery-${crypto.randomUUID()}`)
    mkdirSync(previous)
    // Preserve partial/user-edited data. Interrupted recovery repeats from the
    // original backup under the same target lock.
    for (const name of names) {
      if (existsSync(join(target, name))) renameSync(join(target, name), join(previous, name))
      if (existsSync(join(stage, name))) renameSync(join(stage, name), join(target, name))
      checkpoint?.('publish', name)
    }
    rmSync(stage, { recursive: true })
    rmSync(marker)
    return true
  } finally {
    try { if (stage && existsSync(stage)) { checkTree(stage); rmSync(stage, { recursive: true }) } }
    finally { lock.release() }
  }
}
if (import.meta.main) {
  try {
    if (process.argv[2] === '--recover') recoverImport(process.argv[3] ?? '')
    else importData(process.argv[2] ?? '', process.argv[3] ?? '')
  } catch (error) {
    // Only translation codes, never configuration contents, keys or paths.
    console.error(error instanceof ImportError ? error.message : /already in use/.test(String(error)) ? 'importBusy' : 'importFailed')
    process.exitCode = 1
  }
}
