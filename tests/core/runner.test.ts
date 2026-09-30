import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allocatePort, isAlive, isPortFree, LoadError, PidRegistry, Runner, type LogStream,
} from '../../server/core/runner'

const fixture = join(import.meta.dir, '..', 'fixtures', 'fake-llama-server.ts')
// A range unlikely to clash with anything else on the machine.
const RANGE: [number, number] = [47100, 47140]

let dir: string
let runner: Runner
let registry: PidRegistry
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lw-runner-'))
  registry = new PidRegistry(join(dir, 'run', 'pids.json'))
  runner = new Runner({ portRange: RANGE, registry, healthIntervalMs: 50 })
})
afterEach(async () => {
  await runner.stopAll()
  rmSync(dir, { recursive: true, force: true })
})

function start(mode: string, extra: { loadTimeoutMs?: number, delay?: number, onLine?: (s: LogStream, l: string) => void } = {}) {
  return runner.start({
    exe: process.execPath,
    args: port => [fixture, '--fake-mode', mode, '--fake-delay', String(extra.delay ?? 100), '--host', '127.0.0.1', '--port', String(port)],
    tag: `test:${mode}`,
    loadTimeoutMs: extra.loadTimeoutMs ?? 15000,
    onLine: extra.onLine,
  })
}

async function waitDead(pid: number, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end && isAlive(pid)) await Bun.sleep(50)
  return !isAlive(pid)
}

function listen(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen({ port, host: '127.0.0.1' }, () => res(s))
  })
}

describe('ports', () => {
  test('allocatePort skips busy and excluded ports', async () => {
    const busy = await listen(RANGE[0])
    try {
      expect(await isPortFree(RANGE[0])).toBe(false)
      expect(await allocatePort([RANGE[0], RANGE[0] + 5], [RANGE[0] + 1])).toBe(RANGE[0] + 2)
      expect(await allocatePort([RANGE[0], RANGE[0]])).toBe(null)
    } finally {
      busy.close()
    }
  })

  test('no free port is a LoadError(no-port)', async () => {
    const busy = await listen(RANGE[0])
    try {
      const r = new Runner({ portRange: [RANGE[0], RANGE[0]] })
      const e = await r.start({ exe: process.execPath, args: () => [], tag: 't', loadTimeoutMs: 1000 }).catch(e => e)
      expect(e).toBeInstanceOf(LoadError)
      expect(e.code).toBe('no-port')
    } finally {
      busy.close()
    }
  })
})

describe('runner', () => {
  test('ready after /health 200; output captured line by line; pids.json kept in sync', async () => {
    const lines: Array<[LogStream, string]> = []
    const p = await start('ok', { onLine: (s, l) => lines.push([s, l]) })
    await p.ready
    expect(p.port).toBeGreaterThanOrEqual(RANGE[0])
    expect((await fetch(`${p.url}/health`)).status).toBe(200)
    expect(registry.list().map(r => [r.pid, r.port, r.tag])).toEqual([[p.pid!, p.port, 'test:ok']])
    expect(registry.list()[0]!.exe).toBe(process.execPath)

    const info = await p.stop()
    expect(info.requested).toBe(true)
    expect(p.isRunning).toBe(false)
    expect(registry.list()).toEqual([])
    expect(lines).toContainEqual(['stdout', `fake llama-server mode=ok port=${p.port}`])
    expect(lines).toContainEqual(['stderr', 'stderr: 加载模型中'])
    expect(p.tail(100)).toContain('partial line without newline')
  }, 30000)

  test('exit before ready -> LoadError(exited) with exit code and last lines', async () => {
    const p = await start('exit')
    const e = await p.ready.catch(e => e)
    expect(e).toBeInstanceOf(LoadError)
    expect(e.code).toBe('exited')
    expect(e.exitCode).toBe(3)
    expect(e.tail).toContain('error: unknown argument: --bogus')
    const info = await p.exited
    expect(info).toEqual({ code: 3, signal: null, requested: false })
    expect(registry.list()).toEqual([])
  }, 30000)

  test('load timeout -> LoadError(timeout) and the process is killed', async () => {
    const p = await start('hang', { loadTimeoutMs: 1500 })
    const e = await p.ready.catch(e => e)
    expect(e.code).toBe('timeout')
    await p.exited
    expect(await waitDead(p.pid!)).toBe(true)
    expect(registry.list()).toEqual([])
  }, 30000)

  test('stop while loading -> LoadError(aborted)', async () => {
    const p = await start('hang')
    await Bun.sleep(300)
    await p.stop()
    const e = await p.ready.catch(e => e)
    expect(e.code).toBe('aborted')
  }, 30000)

  test('missing executable -> LoadError(spawn-failed)', async () => {
    const p = await runner.start({ exe: join(dir, 'nope', 'llama-server.exe'), args: () => [], tag: 't', loadTimeoutMs: 5000 })
    const e = await p.ready.catch(e => e)
    expect(e.code).toBe('spawn-failed')
    await p.exited
    expect(registry.list()).toEqual([])
  })

  test.skipIf(process.platform !== 'win32')('stop kills the whole process tree', async () => {
    const p = await start('child')
    await p.ready
    let childPid = 0
    const end = Date.now() + 5000
    while (!childPid && Date.now() < end) {
      childPid = Number(/child=(\d+)/.exec(p.tail(50).join('\n'))?.[1] ?? 0)
      if (!childPid) await Bun.sleep(50)
    }
    expect(isAlive(childPid)).toBe(true)
    await p.stop()
    expect(await waitDead(p.pid!)).toBe(true)
    expect(await waitDead(childPid)).toBe(true)
  }, 30000)

  test('concurrent starts get different ports', async () => {
    const [p1, p2] = await Promise.all([start('ok'), start('ok')])
    expect(p1.port).not.toBe(p2.port)
    await Promise.all([p1.ready, p2.ready])
    expect(registry.list().length).toBe(2)
  }, 30000)
})

describe('pid registry', () => {
  test('missing or corrupt file reads as empty', () => {
    expect(registry.list()).toEqual([])
    registry.add({ pid: 1, exe: 'X:\\a.exe', port: 1, tag: 't', startedAt: '' })
    registry.add({ pid: 2, exe: 'X:\\b.exe', port: 2, tag: 't', startedAt: '' })
    registry.remove(1)
    expect(registry.list().map(r => r.pid)).toEqual([2])
    writeFileSync(registry.file, '{ not json')
    expect(registry.list()).toEqual([])
  })
})
