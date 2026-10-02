// Atomic directory ownership. A recovery mutex serializes acquisition/reclamation/release.
// Incomplete or unreadable owner files fail closed; a live PID (including a reused one) is never evicted.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive } from './runner'
export interface DataLock { release(): void }
export function acquireDataLock(dataDir: string, deps: { pid?: number, alive?: (pid: number) => boolean } = {}): DataLock {
  mkdirSync(dataDir, { recursive: true })
  const run = join(realpathSync(dataDir), 'run')
  mkdirSync(run, { recursive: true })
  const dir = join(run, 'instance.lock'), gate = join(run, 'instance.guard')
  const owner = join(dir, 'owner.json'), pid = deps.pid ?? process.pid, nonce = randomUUID()
  const alive = deps.alive ?? isAlive
  const busy = () => new Error('Data directory is already in use or its lock owner cannot be verified')
  const enter = () => { try { mkdirSync(gate) } catch { throw busy() } }
  enter()
  try {
    try { mkdirSync(dir) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let old: { pid: number }
      try { old = JSON.parse(readFileSync(owner, 'utf8')) } catch { throw busy() }
      if (!Number.isInteger(old.pid) || old.pid <= 0 || alive(old.pid)) throw busy()
      rmSync(dir, { recursive: true })
      mkdirSync(dir)
    }
    try { writeFileSync(owner, JSON.stringify({ version: 1, pid, nonce }), { flag: 'wx' }) }
    catch (e) { rmSync(dir, { recursive: true }); throw e }
  } finally { rmSync(gate, { recursive: true }) }
  let released = false
  return { release() {
    if (released) return
    enter()
    try {
      const current = JSON.parse(readFileSync(owner, 'utf8'))
      if (current.nonce !== nonce) throw busy()
      rmSync(dir, { recursive: true })
      released = true
    } finally { rmSync(gate, { recursive: true }) }
  } }
}
