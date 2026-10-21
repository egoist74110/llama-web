import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  descendantsOf, findListener, forceKill, forceStopPort, ForceStopError, inspectPort, isLocalHost, localPortOf, processInfo, selfChain,
  type PortOwnerDeps, type ProcInfo, type ProcessRow,
} from '../../server/core/port-owner'
import { isAlive } from '../../server/core/runner'

const p = (pid: number, ppid: number, exe: string, birth = `b${pid}`): ProcInfo => ({ pid, ppid, name: exe.split(/[\\/]/).pop()!, exe, birth })

/** A fake machine: processes by pid, who listens on which port, and llama-web's own place in the tree. */
function machine(procs: ProcInfo[], listeners: Record<number, number[]>, extra: Partial<PortOwnerDeps> = {}): PortOwnerDeps {
  const table: ProcessRow[] = procs.map(x => ({ pid: x.pid, ppid: x.ppid }))
  return {
    platform: 'win32',
    findListener: async port => listeners[port] ?? [],
    processInfo: async pid => procs.find(x => x.pid === pid) ?? null,
    processTable: async () => table,
    managedPids: () => [],
    runtimeDir: 'X:\\llama-web\\data\\runtime',
    self: { pid: 100, ppid: 90 },
    ...extra,
  }
}

const PY = 'X:\\apps\\py\\python.exe'

describe('isLocalHost', () => {
  test('loopback hosts only, with the port of the address', () => {
    expect(localPortOf('http://127.0.0.1:8080/v1')).toBe(8080)
    expect(localPortOf('http://localhost:11434/v1')).toBe(11434)
    expect(localPortOf('http://[::1]:9000/v1')).toBe(9000)
    expect(localPortOf('http://127.0.0.1/v1')).toBe(80)
    expect(localPortOf('https://localhost/v1')).toBe(443)
    expect(localPortOf('http://192.168.1.20:8080/v1')).toBeNull()
    expect(localPortOf('https://example.com/v1')).toBeNull()
    expect(localPortOf('not a url')).toBeNull()
    expect(isLocalHost('http://127.0.0.1:1/v1')).toBe(true)
    expect(isLocalHost('http://10.0.0.5:1/v1')).toBe(false)
  })
})

describe('inspectPort', () => {
  test('finds the listener and walks up while the parent runs the same program', async () => {
    const m = machine([
      p(100, 90, 'X:\\llama-web\\bun.exe'), p(90, 1, 'X:\\llama-web\\shell.exe'),
      p(50, 7, 'C:\\Windows\\explorer.exe'),
      p(60, 50, PY), p(61, 60, PY), p(62, 61, 'X:\\apps\\svc\\worker.exe'),
    ], { 8080: [61] })
    const r = await inspectPort(8080, m)
    expect(r).toMatchObject({ ok: true, target: { pid: 60 }, listener: { pid: 61 }, children: 2 })
  })

  test('the exe comparison ignores case on Windows only', async () => {
    const procs = [p(60, 50, PY), p(61, 60, PY.toUpperCase()), p(50, 7, 'C:\\Windows\\explorer.exe')]
    expect(await inspectPort(8080, machine(procs, { 8080: [61] }))).toMatchObject({ ok: true, target: { pid: 60 } })
    expect(await inspectPort(8080, machine(procs, { 8080: [61] }, { platform: 'darwin' }))).toMatchObject({ ok: true, target: { pid: 61 } })
  })

  test('stops at a parent that runs another program', async () => {
    const m = machine([p(60, 50, 'C:\\Windows\\cmd.exe'), p(61, 60, PY)], { 8080: [61] })
    expect(await inspectPort(8080, m)).toMatchObject({ ok: true, target: { pid: 61 } })
  })

  test('climbs at most 5 steps', async () => {
    // 201 listens; 202 .. 207 are its ancestors, all the same program.
    const chain: ProcInfo[] = []
    for (let i = 201; i <= 207; i++) chain.push(p(i, i < 207 ? i + 1 : 1, PY))
    const m = machine(chain, { 8080: [201] })
    const r = await inspectPort(8080, m)
    expect(r).toMatchObject({ ok: true, target: { pid: 206 } })
  })

  test('never climbs into an excluded process', async () => {
    const m = machine([p(60, 55, PY), p(55, 50, PY), p(50, 7, 'C:\\Windows\\explorer.exe'), p(61, 60, PY)], { 8080: [61] }, { managedPids: () => [55] })
    expect(await inspectPort(8080, m)).toMatchObject({ ok: true, target: { pid: 60 } })
    // The parent chain of llama-web itself is excluded too.
    const self = machine([p(100, 90, 'X:\\llama-web\\bun.exe'), p(90, 1, 'X:\\llama-web\\bun.exe'), p(61, 90, 'X:\\llama-web\\bun.exe')], { 8080: [61] }, { self: { pid: 100, ppid: 90 } })
    expect(await inspectPort(8080, self)).toMatchObject({ ok: true, target: { pid: 61 } }) // 61 is a child of our parent, not an ancestor: climbing stops below 90
  })

  test('refuses: nothing listening', async () => {
    expect(await inspectPort(8080, machine([], {}))).toEqual({ ok: false, code: 'not-listening' })
  })

  test('refuses: llama-web itself or any of its ancestors (the public entry may be on :8080)', async () => {
    const procs = [p(100, 90, 'X:\\llama-web\\bun.exe'), p(90, 80, 'X:\\llama-web\\shell.exe'), p(80, 1, 'C:\\Windows\\explorer.exe')]
    for (const pid of [100, 90, 80]) expect(await inspectPort(8080, machine(procs, { 8080: [pid] }))).toEqual({ ok: false, code: 'self' })
    // Even when it is not the first of several listeners.
    expect(await inspectPort(8080, machine([...procs, p(61, 1, PY)], { 8080: [61, 100] }))).toEqual({ ok: false, code: 'self' })
  })

  test('refuses: processes llama-web manages (pids.json) and anything under data/runtime', async () => {
    const m = machine([p(70, 1, 'X:\\llama-web\\data\\runtime\\b1\\llama-server.exe'), p(71, 1, PY)], { 8080: [70], 8081: [71] }, { managedPids: () => [71] })
    expect(await inspectPort(8080, m)).toEqual({ ok: false, code: 'managed' })
    expect(await inspectPort(8081, m)).toEqual({ ok: false, code: 'managed' })
  })

  test('refuses when the listener cannot be read', async () => {
    const m = machine([], { 8080: [61] })
    expect(await inspectPort(8080, m)).toEqual({ ok: false, code: 'unreadable' })
  })
})

describe('force stop', () => {
  const procs = [p(60, 50, PY), p(61, 60, PY), p(50, 7, 'C:\\Windows\\explorer.exe')]

  test('ends the process that was shown, and reports it', async () => {
    const killed: number[] = []
    const t = await forceStopPort(8080, { pid: 60, birth: 'b60' }, { ...machine(procs, { 8080: [61] }), kill: async pid => { killed.push(pid) } })
    expect(t.pid).toBe(60)
    expect(killed).toEqual([60])
  })

  test('"changed" when the pid or the start time is not the one that was shown; nothing is killed', async () => {
    const killed: number[] = []
    const deps = { ...machine(procs, { 8080: [61] }), kill: async (pid: number) => { killed.push(pid) } }
    for (const expected of [{ pid: 61, birth: 'b61' }, { pid: 60, birth: 'reborn' }]) {
      await expect(forceStopPort(8080, expected, deps)).rejects.toMatchObject({ name: 'ForceStopError', code: 'changed' })
    }
    expect(killed).toEqual([])
  })

  test('refusals come through as ForceStopError', async () => {
    const deps = { ...machine([], {}), kill: async () => { throw new Error('must not run') } }
    await expect(forceStopPort(8080, { pid: 1, birth: 'x' }, deps)).rejects.toBeInstanceOf(ForceStopError)
  })

  test('macOS: SIGTERM to the whole tree, SIGKILL to the survivors only', async () => {
    const table: ProcessRow[] = [{ pid: 60, ppid: 50 }, { pid: 61, ppid: 60 }, { pid: 62, ppid: 61 }, { pid: 99, ppid: 1 }]
    const sent: Array<[number, string]> = []
    const alive = new Set([60, 61, 62])
    await forceKill(60, {
      platform: 'darwin', processTable: async () => table, graceMs: 200, wait: async () => {},
      signal: (pid, s) => { sent.push([pid, s]); if (s === 'SIGTERM' && pid !== 61) alive.delete(pid) },
      alive: pid => alive.has(pid),
    })
    expect(sent.filter(([, s]) => s === 'SIGTERM').map(([pid]) => pid).sort()).toEqual([60, 61, 62])
    expect(sent.filter(([, s]) => s === 'SIGKILL')).toEqual([[61, 'SIGKILL']])
    expect(sent.some(([pid]) => pid === 99 || pid === 50)).toBe(false)
  })

  test('Windows uses the tree kill; our own pid and pid 1 are refused', async () => {
    const killed: number[] = []
    await forceKill(60, { platform: 'win32', killTree: async pid => { killed.push(pid) } })
    expect(killed).toEqual([60])
    await expect(forceKill(process.pid)).rejects.toThrow()
    await expect(forceKill(1)).rejects.toThrow()
  })
})

describe('process tree helpers', () => {
  test('descendants, nearest first; our parent chain', () => {
    const table: ProcessRow[] = [{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 2 }, { pid: 5, ppid: 3 }, { pid: 9, ppid: 8 }]
    expect(descendantsOf(2, table)).toEqual([3, 4, 5])
    expect(descendantsOf(5, table)).toEqual([])
    expect([...selfChain(table, 5, 3)].sort()).toEqual([1, 2, 3, 5])
    expect([...selfChain([], 5, 3)].sort()).toEqual([3, 5]) // the table could not be read: at least our own parent
  })
})

describe.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')('a real listener', () => {
  test('is found on its port and ended by forceKill (only a process this test started)', async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = probe.port!
    probe.stop(true)
    const child = spawn(process.execPath, ['-e', `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setTimeout(() => process.exit(0), 30000)`], { stdio: 'ignore', windowsHide: true })
    const pid = child.pid!
    try {
      let found: number[] = []
      for (let i = 0; i < 100 && !found.includes(pid); i++) { found = await findListener(port); if (!found.includes(pid)) await Bun.sleep(100) }
      expect(found).toContain(pid)
      const info = await processInfo(pid)
      expect(info).toMatchObject({ pid, ppid: process.pid })
      await forceKill(pid)
      for (let i = 0; i < 50 && isAlive(pid); i++) await Bun.sleep(100)
      expect(isAlive(pid)).toBe(false)
      expect(await findListener(port)).not.toContain(pid)
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 30000)
})
