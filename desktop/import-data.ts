// Explicit, offline import. No config content or secrets are printed.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { acquireDataLock } from '../server/core/data-lock'

const names = ['settings.json', 'models.json', 'secrets.json', 'templates', 'runtime', 'logs', 'backups']
function contains(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
function checkTree(path: string) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Links are not allowed in imported data')
  if (stat.isDirectory()) for (const name of readdirSync(path)) checkTree(join(path, name))
  else if (!stat.isFile()) throw new Error('Unsupported imported file')
}
export function importData(sourcePath: string, targetPath: string) {
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath)) throw new Error('Import paths must be absolute')
  const source = realpathSync(sourcePath)
  mkdirSync(targetPath, { recursive: true })
  const target = realpathSync(targetPath)
  if (contains(source, target) || contains(target, source)) throw new Error('Import directories must be separate')
  const sourceLock = acquireDataLock(source)
  let targetLock: ReturnType<typeof acquireDataLock> | undefined
  const id = crypto.randomUUID()
  const stage = join(dirname(target), `.import-stage-${id}`)
  const backup = join(dirname(target), 'import-backups', id)
  try {
    targetLock = acquireDataLock(target)
    if (readdirSync(target).some(n => n !== 'run')) throw new Error('Target data directory is not empty')
    for (const name of ['settings.json', 'models.json']) {
      const doc = JSON.parse(readFileSync(join(source, name), 'utf8'))
      if (!Number.isInteger(doc.version) || doc.version < 1) throw new Error('Invalid source configuration')
    }
    for (const name of names) if (existsSync(join(source, name))) checkTree(join(source, name))
    mkdirSync(backup, { recursive: true })
    // Complete the backup before publishing any imported data.
    for (const name of names) if (existsSync(join(source, name))) cpSync(join(source, name), join(backup, name), { recursive: true })
    cpSync(backup, stage, { recursive: true })
    // Keep the target ownership lock throughout publication. A crash marker prevents
    // launching with a partial copy; the complete backup remains available to recover.
    const marker = join(target, 'run', 'import.pending.json')
    writeFileSync(marker, JSON.stringify({ version: 1, backup: id }), { flag: 'wx' })
    const published: string[] = []
    try {
      for (const name of names) if (existsSync(join(stage, name))) {
        renameSync(join(stage, name), join(target, name))
        published.push(name)
      }
      rmSync(marker)
    } catch (e) {
      for (const name of published.reverse()) renameSync(join(target, name), join(stage, name))
      rmSync(marker)
      throw e
    }
    return backup
  } finally {
    targetLock?.release()
    sourceLock.release()
    rmSync(stage, { recursive: true, force: true })
  }
}
if (import.meta.main) {
  try {
    importData(process.argv[2] ?? '', process.argv[3] ?? '')
    console.log('Imported data and retained backup')
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
