import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupResidue, getExePaths, isInsideDir } from '../../server/core/residue'
import { isAlive, PidRegistry, type PidRecord } from '../../server/core/runner'
import { processIdentity } from '../../server/core/process-identity'

let dir: string
let registry: PidRegistry
const runtime = 'X:\\app\\data\\runtime'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-residue-'))
  registry = new PidRegistry(join(dir, 'pids.json'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const rec = (pid: number, exe = `${runtime}\\llama.cpp\\b1\\llama-server.exe`): PidRecord =>
  ({ pid, exe, port: 7100, tag: 'm:默认', startedAt: '2026-01-01T00:00:00Z', birth: `birth-${pid}` })
const identities = async (pids: number[]) => new Map(registry.list().filter(r => pids.includes(r.pid)).map(r => [r.pid, { exe: r.exe, birth: r.birth! }]))

test('isInsideDir', () => {
  expect(isInsideDir('X:\\app\\data\\runtime\\llama.cpp\\b1\\llama-server.exe', runtime, 'win32')).toBe(true)
  expect(isInsideDir('x:\\APP\\Data\\Runtime\\b1\\llama-server.exe', runtime, 'win32')).toBe(true)
  expect(isInsideDir('X:\\app\\data\\runtime-old\\llama-server.exe', runtime, 'win32')).toBe(false)
  expect(isInsideDir('X:\\app\\data\\runtime\\..\\llama-server.exe', runtime, 'win32')).toBe(false)
  expect(isInsideDir('X:\\tools\\llama-server.exe', runtime, 'win32')).toBe(false)
})

describe('cleanupResidue (injected process table)', () => {
  test('kills only live processes whose exe is under runtime/, then empties the file', async () => {
    registry.add(rec(101)) // ours, alive -> kill
    registry.add(rec(102)) // ours, gone
    registry.add(rec(103)) // pid reused by something else -> skip
    registry.add(rec(104)) // alive but path unreadable -> skip
    const killed: number[] = []
    const r = await cleanupResidue(registry, runtime, {
      platform: 'win32',
      identities,
      isAlive: pid => pid !== 102,
      getExePaths: async pids => {
        expect(pids).toEqual([101, 103, 104])
        return new Map([
          [101, 'X:\\app\\data\\runtime\\llama.cpp\\b1\\llama-server.exe'],
          [103, 'C:\\Windows\\System32\\notepad.exe'],
        ])
      },
      killTree: async (pid) => { killed.push(pid) },
    })
    expect(killed).toEqual([101])
    expect(r.killed.map(x => x.pid)).toEqual([101])
    expect(r.gone.map(x => x.pid)).toEqual([102])
    expect(r.skipped.map(x => [x.pid, x.actualExe])).toEqual([[103, 'C:\\Windows\\System32\\notepad.exe'], [104, null]])
    expect(registry.list()).toEqual([])
  })

  test('a tunnel left behind (cloudflared under runtime/) is killed; the user own cloudflared is not', async () => {
    registry.add({ ...rec(301, 'X:\\app\\data\\runtime\\cloudflared\\cloudflared.exe'), tag: 'tunnel' })
    registry.add({ ...rec(302, 'C:\\Program Files\\cloudflared\\cloudflared.exe'), tag: 'tunnel' })
    const killed: number[] = []
    await cleanupResidue(registry, runtime, {
      platform: 'win32',
      identities,
      isAlive: () => true,
      getExePaths: async () => new Map([[301, 'X:\\app\\data\\runtime\\cloudflared\\cloudflared.exe'], [302, 'C:\\Program Files\\cloudflared\\cloudflared.exe']]),
      killTree: async (pid) => { killed.push(pid) },
    })
    expect(killed).toEqual([301])
  })

  test('a user-started llama-server outside runtime/ is never killed', async () => {
    registry.add(rec(201, 'X:\\tools\\llama-server.exe'))
    const killed: number[] = []
    await cleanupResidue(registry, runtime, {
      platform: 'win32',
      identities,
      isAlive: () => true,
      getExePaths: async () => new Map([[201, 'X:\\tools\\llama-server.exe']]),
      killTree: async (pid) => { killed.push(pid) },
    })
    expect(killed).toEqual([])
  })

  test('empty registry does not query the process table', async () => {
    let queried = false
    const r = await cleanupResidue(registry, runtime, { getExePaths: async () => { queried = true; return new Map() } })
    expect(queried).toBe(false)
    expect(r).toEqual({ killed: [], skipped: [], gone: [] })
  })
})

describe.skipIf(process.platform !== 'win32')('cleanupResidue (real processes)', () => {
  test('kills a recorded live process under the runtime dir, spares one outside it', async () => {
    const victim = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore' })
    const bystander = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore' })
    try {
      const exes = await getExePaths([victim.pid, bystander.pid])
      expect(exes.get(victim.pid)?.toLowerCase()).toBe(process.execPath.toLowerCase())
      registry.add({ ...rec(victim.pid, process.execPath), birth: processIdentity(victim.pid)?.birth })
      registry.add({ ...rec(bystander.pid, process.execPath), birth: processIdentity(bystander.pid)?.birth })
      // Pretend bun's own directory is data/runtime for the victim only.
      const bunDir = join(process.execPath, '..')
      const r = await cleanupResidue(registry, bunDir, {
        getExePaths: async pids => new Map([...(await getExePaths(pids))].map(([pid, exe]) =>
          [pid, pid === bystander.pid ? 'X:\\elsewhere\\llama-server.exe' : exe])),
      })
      expect(r.killed.map(x => x.pid)).toEqual([victim.pid])
      await victim.exited
      expect(isAlive(victim.pid)).toBe(false)
      expect(isAlive(bystander.pid)).toBe(true)
    } finally {
      victim.kill()
      bystander.kill()
    }
  }, 30000)
})
