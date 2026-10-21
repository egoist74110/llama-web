import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpstream, defaultUpstreams, type UpstreamsDoc } from '../../server/core/upstreams'
import { LaunchError, launchArgv, needsOutsideJob, UpstreamLauncher, realSpawn, type CheckResult, type LaunchedProcess, type SpawnSpec } from '../../server/core/upstream-launcher'
import { fileLaunchedStore, type Ident, type LaunchedEntry } from '../../server/core/launched-store'
import { quoteWindowsArg, windowsCommandLine } from '../../server/core/win-spawn'

const closers: Array<() => void> = []
afterEach(() => { while (closers.length) closers.pop()!() })

function doc(form: Record<string, unknown> = {}): UpstreamsDoc {
  const d = defaultUpstreams()
  createUpstream(d, { name: 'Strata', baseUrl: 'http://127.0.0.1:9/v1', startCommand: 'strata-start --fast "a b"', ...form }, { localNames: [], selfPorts: [] })
  return d
}

class FakeProc implements LaunchedProcess {
  pid = 4242
  exitCb: (code: number | null) => void = () => {}
  errorCb: (e: Error) => void = () => {}
  unrefs = 0
  onExit(cb: (code: number | null) => void) { this.exitCb = cb }
  onError(cb: (e: Error) => void) { this.errorCb = cb }
  unref() { this.unrefs++ }
}

function setup(d: UpstreamsDoc, opts: { timeoutMs?: number, dirExists?: boolean } = {}) {
  const spawned: SpawnSpec[] = []
  const procs: FakeProc[] = []
  const logs: string[] = []
  const ready: Array<{ name: string, models: string[] }> = []
  const killed: number[] = []
  let result: CheckResult = { ok: false, models: [] }
  const launcher = new UpstreamLauncher({
    upstreams: () => d.upstreams,
    check: async () => result,
    onReady: (u, models) => ready.push({ name: u.name, models }),
    onChange: () => {},
    log: m => logs.push(m),
    spawn: (spec) => { spawned.push(spec); const p = new FakeProc(); procs.push(p); return p },
    kill: async (pid) => { killed.push(pid) },
    dirExists: () => opts.dirExists ?? true,
    pollMs: 5, timeoutMs: opts.timeoutMs ?? 5000, platform: 'linux',
  })
  closers.push(() => launcher.close())
  const id = d.upstreams[0]!.id
  const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(5); expect(pred()).toBe(true) }
  return { launcher, id, spawned, procs, logs, ready, killed, setResult: (r: CheckResult) => { result = r }, until }
}

describe('start command line', () => {
  test('is split into an argument array (quotes understood), never given to a shell', () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    expect(s.spawned).toEqual([{ file: 'strata-start', args: ['--fast', 'a b'], cwd: undefined, keepRunning: true }])
  })

  test('.bat / .cmd go through cmd.exe on Windows only', () => {
    expect(launchArgv(['E:\\x\\start.bat', '-a'], 'win32')).toEqual({ file: 'cmd.exe', args: ['/c', 'E:\\x\\start.bat', '-a'] })
    expect(launchArgv(['E:\\x\\Run.CMD'], 'win32').file).toBe('cmd.exe')
    expect(launchArgv(['E:\\x\\app.exe', '--p'], 'win32')).toEqual({ file: 'E:\\x\\app.exe', args: ['--p'] })
    expect(launchArgv(['./start.bat'], 'linux')).toEqual({ file: './start.bat', args: [] })
  })

  test('the working directory is passed on and must exist', () => {
    const s = setup(doc({ startCwd: 'X:\\apps\\strata' }))
    s.launcher.start(s.id, false)
    expect(s.spawned[0]!.cwd).toBe('X:\\apps\\strata')
    const bad = setup(doc({ startCwd: 'X:\\nope' }), { dirExists: false })
    expect(() => bad.launcher.start(bad.id, false)).toThrow(LaunchError)
    expect(bad.spawned).toHaveLength(0)
  })
})

describe('refusals', () => {
  const code = (fn: () => void) => {
    try { fn() } catch (e) { return e instanceof LaunchError ? e.code : 'other' }
    return 'none'
  }

  test('no command, already up, unknown id, a second start while waiting', () => {
    const none = setup(doc({ startCommand: '' }))
    expect(code(() => none.launcher.start(none.id, false))).toBe('no-command')
    const s = setup(doc())
    expect(code(() => s.launcher.start(s.id, true))).toBe('already-up')
    expect(code(() => s.launcher.start('u-nope', false))).toBe('not-found')
    s.launcher.start(s.id, false)
    expect(code(() => s.launcher.start(s.id, false))).toBe('already-starting')
    expect(s.spawned).toHaveLength(1)
  })
})

describe('waiting for the service', () => {
  test('started = it lists models; they are handed over, the process is detached and left alone', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    expect(s.launcher.state(s.id).state).toBe('starting')
    expect(s.procs[0]!.unrefs).toBe(1)
    // Answering without models yet (loading): still waiting.
    s.setResult({ ok: true, models: [] })
    await Bun.sleep(30)
    expect(s.launcher.state(s.id).state).toBe('starting')
    s.setResult({ ok: true, models: ['m1', 'm2'] })
    await s.until(() => s.launcher.state(s.id).state === 'idle')
    expect(s.ready).toEqual([{ name: 'Strata', models: ['m1', 'm2'] }])
    expect(s.killed).toEqual([])
    // Only the program name is logged: the arguments may hold secrets.
    expect(s.logs.join('\n')).not.toContain('a b')
    expect(s.logs[0]).toContain('strata-start')
  })

  test('an upstream with hand-typed models is started as soon as it answers', async () => {
    const s = setup(doc({ manualModels: ['x'] }))
    s.launcher.start(s.id, false)
    s.setResult({ ok: true, models: [] })
    await s.until(() => s.launcher.state(s.id).state === 'idle')
    expect(s.ready).toHaveLength(1)
  })

  test('a launcher that exits with 0 after starting the service is fine; the wait goes on', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.procs[0]!.exitCb(0)
    await Bun.sleep(30)
    expect(s.launcher.state(s.id).state).toBe('starting')
    s.setResult({ ok: true, models: ['m'] })
    await s.until(() => s.launcher.state(s.id).state === 'idle')
  })

  test('exiting with an error before the models show up fails the start', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.procs[0]!.exitCb(3)
    expect(s.launcher.state(s.id)).toEqual({ state: 'failed', code: 'exited', detail: '3' })
    // The wait is over: a later answer changes nothing, and a new start is allowed.
    s.setResult({ ok: true, models: ['m'] })
    await Bun.sleep(30)
    expect(s.ready).toHaveLength(0)
    s.launcher.start(s.id, false)
    expect(s.launcher.state(s.id).state).toBe('starting')
  })

  test('a program that cannot be started', () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.procs[0]!.errorCb(new Error('spawn strata-start ENOENT'))
    expect(s.launcher.state(s.id)).toEqual({ state: 'failed', code: 'spawn-failed', detail: 'spawn strata-start ENOENT' })
  })

  test('gives up after the timeout and leaves the process alone', async () => {
    const s = setup(doc(), { timeoutMs: 40 })
    s.launcher.start(s.id, false)
    await s.until(() => s.launcher.state(s.id).state === 'failed')
    expect(s.launcher.state(s.id)).toMatchObject({ state: 'failed', code: 'timeout' })
    expect(s.killed).toEqual([])
  })

  test('cancel ends the wait and the process that was started', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    await s.launcher.cancel(s.id)
    expect(s.launcher.state(s.id).state).toBe('idle')
    expect(s.killed).toEqual([4242])
    s.setResult({ ok: true, models: ['m'] })
    await Bun.sleep(30)
    expect(s.ready).toHaveLength(0)
  })

  test('cancel does not kill a process that already exited', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.procs[0]!.exitCb(0)
    await s.launcher.cancel(s.id)
    expect(s.killed).toEqual([])
  })

  test('a service that came up can be stopped by hand; one we did not start cannot', async () => {
    const s = setup(doc())
    await expect(s.launcher.stop(s.id)).rejects.toThrow(LaunchError)
    expect(s.launcher.canStop(s.id)).toBe(false)
    s.launcher.start(s.id, false)
    s.setResult({ ok: true, models: ['m'] })
    await s.until(() => s.ready.length === 1)
    expect(s.launcher.state(s.id).state).toBe('idle')
    expect(s.launcher.canStop(s.id)).toBe(true)
    await s.launcher.stop(s.id)
    expect(s.killed).toEqual([4242])
    expect(s.launcher.canStop(s.id)).toBe(false)
  })

  test('a start that failed leaves nothing to stop; a script that exited is not stoppable on Windows', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.procs[0]!.exitCb(1)
    expect(s.launcher.canStop(s.id)).toBe(false)
  })

  test('removing the upstream while waiting ends the wait quietly', async () => {
    const d = doc()
    const s = setup(d)
    s.launcher.start(s.id, false)
    d.upstreams.length = 0
    await s.until(() => s.launcher.state(s.id).state === 'idle')
    expect(s.ready).toHaveLength(0)
  })

  test('closing stops the timers and leaves the service running', async () => {
    const s = setup(doc())
    s.launcher.start(s.id, false)
    s.launcher.close()
    s.setResult({ ok: true, models: ['m'] })
    await Bun.sleep(30)
    expect(s.ready).toHaveLength(0)
    expect(s.killed).toEqual([])
  })
})

describe('stop when llama-web exits (decision 60)', () => {
  test('off by default: the spawn asks to keep running, and shutdown leaves the service alone', async () => {
    const s = setup(doc())
    expect(doc().upstreams[0]!.stopOnExit).toBe(false)
    s.launcher.start(s.id, false)
    expect(s.spawned[0]!.keepRunning).toBe(true)
    await s.launcher.shutdown()
    expect(s.killed).toEqual([])
  })

  test('on: shutdown ends the process this run started (and only that)', async () => {
    const d = doc({ stopOnExit: true })
    createUpstream(d, { name: 'Other', baseUrl: 'http://127.0.0.1:8/v1', startCommand: 'other-start' }, { localNames: [], selfPorts: [] })
    const s = setup(d)
    s.launcher.start(s.id, false)
    expect(s.spawned[0]!.keepRunning).toBe(false)
    s.procs[0]!.pid = 5001
    s.launcher.start(d.upstreams[1]!.id, false) // stopOnExit off: stays running
    s.procs[1]!.pid = 5002
    await s.launcher.shutdown()
    expect(s.killed).toEqual([5001])
    expect(s.logs.some(l => l.includes('Strata') && l.includes('exiting'))).toBe(true)
  })

  test('on, but nothing was started from here, or it already exited on Windows: nothing to stop', async () => {
    const s = setup(doc({ stopOnExit: true }))
    await s.launcher.shutdown()
    expect(s.killed).toEqual([])
  })

  test('the switch is read at exit: turned on after the start still stops it', async () => {
    const d = doc()
    const s = setup(d)
    s.launcher.start(s.id, false)
    d.upstreams[0]!.stopOnExit = true
    await s.launcher.shutdown()
    expect(s.killed).toEqual([4242])
  })

  test('only the Windows desktop app needs a start outside its job, and only to keep running', () => {
    const desk = { LLAMA_WEB_DESKTOP_SESSION: 'x' }
    expect(needsOutsideJob({ keepRunning: true }, 'win32', desk)).toBe(true)
    expect(needsOutsideJob({ keepRunning: false }, 'win32', desk)).toBe(false)
    expect(needsOutsideJob({ keepRunning: true }, 'win32', {})).toBe(false) // start.bat: no job
    expect(needsOutsideJob({ keepRunning: true }, 'darwin', desk)).toBe(false) // its own process group already
  })

  test('Windows command line: quoted the way the C runtime splits it again', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('two words')).toBe('"two words"')
    expect(quoteWindowsArg('X:\\models\\a.gguf')).toBe('X:\\models\\a.gguf')
    expect(quoteWindowsArg('X:\\Program Files\\app\\')).toBe('"X:\\Program Files\\app\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"')
    expect(windowsCommandLine('X:\\apps\\py.exe', ['-m', 'server', '--name', 'a b'])).toBe('X:\\apps\\py.exe -m server --name "a b"')
  })
})

describe('a real process', () => {
  test('is started detached with its argument array and the wait ends when its server answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-launch-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const script = join(dir, 'engine.ts')
    const marker = join(dir, 'args.txt')
    const stop = join(dir, 'stop')
    // "Loading" for 300 ms (no models), then serves a model list; records its arguments; ends when the stop file appears.
    writeFileSync(script, [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))`,
      'const t0 = Date.now()',
      "const srv = Bun.serve({ port: Number(process.argv[2]), hostname: '127.0.0.1', fetch: () => Response.json({ data: Date.now() - t0 < 300 ? [] : [{ id: 'real-model' }] }) })",
      `setInterval(() => { if (existsSync(${JSON.stringify(stop)}) || Date.now() - t0 > 20000) { srv.stop(true); process.exit(0) } }, 100)`,
    ].join('\n'))
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)
    const d = defaultUpstreams()
    createUpstream(d, { name: 'Real', baseUrl: `http://127.0.0.1:${port}/v1`, startCommand: `"${process.execPath}" "${script}" ${port} "two words"`, startCwd: dir }, { localNames: [], selfPorts: [] })
    const ready: string[][] = []
    const launcher = new UpstreamLauncher({
      upstreams: () => d.upstreams,
      check: async () => {
        try {
          const j = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(500) })).json() as { data: Array<{ id: string }> }
          return { ok: true, models: j.data.map(m => m.id) }
        } catch { return { ok: false, models: [] } }
      },
      onReady: (_u, models) => ready.push(models),
      onChange: () => {},
      spawn: realSpawn, pollMs: 50, timeoutMs: 15000,
    })
    closers.push(() => launcher.close())
    launcher.start(d.upstreams[0]!.id, false)
    for (let i = 0; i < 200 && ready.length === 0; i++) await Bun.sleep(50)
    expect(ready).toEqual([['real-model']])
    expect(JSON.parse(await Bun.file(marker).text())).toEqual([String(port), 'two words'])
    writeFileSync(stop, '')
    await Bun.sleep(300)
  })
})

describe('a real process at exit (decision 60)', () => {
  test.skipIf(process.platform === 'win32')('shutdown ends the service with the switch on and leaves the other one answering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-exit-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const script = join(dir, 'svc.ts')
    const stop = join(dir, 'stop')
    // Serves a model list at once; ends on its own when the stop file appears (or after 20 s).
    writeFileSync(script, [
      "import { existsSync } from 'node:fs'",
      'const t0 = Date.now()',
      "const srv = Bun.serve({ port: Number(process.argv[2]), hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'm' }] }) })",
      `setInterval(() => { if (existsSync(${JSON.stringify(stop)}) || Date.now() - t0 > 20000) { srv.stop(true); process.exit(0) } }, 100)`,
    ].join('\n'))
    const freePort = () => { const p = Bun.serve({ port: 0, fetch: () => new Response('') }); const n = p.port; p.stop(true); return n }
    const [pa, pb] = [freePort(), freePort()]
    const d = defaultUpstreams()
    const cmd = (port: number) => `"${process.execPath}" "${script}" ${port}`
    createUpstream(d, { name: 'Gone', baseUrl: `http://127.0.0.1:${pa}/v1`, startCommand: cmd(pa), stopOnExit: true }, { localNames: [], selfPorts: [] })
    createUpstream(d, { name: 'Stays', baseUrl: `http://127.0.0.1:${pb}/v1`, startCommand: cmd(pb) }, { localNames: [], selfPorts: [] })
    const answers = async (port: number) => {
      try { return (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(500) })).ok } catch { return false }
    }
    const ready: string[] = []
    const launcher = new UpstreamLauncher({
      upstreams: () => d.upstreams,
      check: async u => ({ ok: await answers(Number(new URL(u.baseUrl).port)), models: ['m'] }),
      onReady: u => ready.push(u.name),
      onChange: () => {},
      spawn: realSpawn, pollMs: 50, timeoutMs: 15000,
    })
    closers.push(() => launcher.close())
    for (const u of d.upstreams) launcher.start(u.id, false)
    for (let i = 0; i < 200 && ready.length < 2; i++) await Bun.sleep(50)
    expect(ready.sort()).toEqual(['Gone', 'Stays'])
    await launcher.shutdown()
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) { gone = !(await answers(pa)); if (!gone) await Bun.sleep(50) }
    expect(gone).toBe(true)
    expect(await answers(pb)).toBe(true)
    writeFileSync(stop, '')
    await Bun.sleep(300)
  })
})

// Remembering what was started (decision 66)
type World = Map<number, { exe: string, birth: string }>

function remembering(d: UpstreamsDoc, seed: LaunchedEntry[] = []) {
  const world: World = new Map()
  let saved: LaunchedEntry[] = seed
  let saves = 0
  const killed: number[] = []
  let listeners: number[] = []
  let result: CheckResult = { ok: false, models: [] }
  const procs: FakeProc[] = []
  const logs: string[] = []
  const launcher = new UpstreamLauncher({
    upstreams: () => d.upstreams,
    check: async () => result,
    onReady: () => {},
    onChange: () => {},
    log: m => logs.push(m),
    spawn: () => { const p = new FakeProc(); procs.push(p); return p },
    kill: async (pid) => { killed.push(pid); world.delete(pid) },
    dirExists: () => true,
    store: { load: () => saved, save: (e) => { saved = JSON.parse(JSON.stringify(e)); saves++ } },
    identity: async pid => world.get(pid) ?? null,
    isAlive: pid => world.has(pid),
    findListener: async () => listeners,
    pollMs: 5, timeoutMs: 5000, platform: 'linux',
  })
  closers.push(() => launcher.close())
  const id = d.upstreams[0]!.id
  const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(5); expect(pred()).toBe(true) }
  return { launcher, id, world, killed, procs, logs, saved: () => saved, saves: () => saves, until, setListeners: (p: number[]) => { listeners = p }, setResult: (r: CheckResult) => { result = r } }
}

const ident = (pid: number, exe = 'X:\\apps\\svc.exe', birth = `b${pid}`): Ident => ({ pid, exe, birth })

describe('remembering the started service (decision 66)', () => {
  test('an entry is saved on start with the identity of the process', async () => {
    const s = remembering(doc())
    s.world.set(4242, { exe: 'X:\\apps\\start.exe', birth: 'b1' })
    s.launcher.start(s.id, false)
    await s.until(() => s.saved()[0]?.root !== null && s.saved().length === 1)
    expect(s.saved()[0]).toMatchObject({ upstream: s.id, root: { pid: 4242, exe: 'X:\\apps\\start.exe', birth: 'b1' }, listener: null })
  })

  test('an unreadable root still leaves an entry', async () => {
    const s = remembering(doc())
    s.launcher.start(s.id, false)
    await Bun.sleep(30)
    expect(s.saved()).toHaveLength(1)
    expect(s.saved()[0]!.root).toBeNull()
  })

  test('the listener of a local upstream is recorded once it is up; a remote one is never probed', async () => {
    const s = remembering(doc())
    s.world.set(4242, { exe: 'X:\\apps\\start.exe', birth: 'b1' })
    s.world.set(777, { exe: 'X:\\apps\\py.exe', birth: 'b7' })
    s.setListeners([777])
    s.launcher.start(s.id, false)
    s.setResult({ ok: true, models: ['m'] })
    await s.until(() => s.launcher.state(s.id).state === 'idle')
    expect(s.saved()[0]!.listener).toEqual({ pid: 777, exe: 'X:\\apps\\py.exe', birth: 'b7' })

    const remote = remembering(doc({ baseUrl: 'https://example.com/v1' }))
    remote.world.set(777, { exe: 'X:\\apps\\py.exe', birth: 'b7' })
    remote.setListeners([777])
    remote.launcher.start(remote.id, false)
    remote.setResult({ ok: true, models: ['m'] })
    await remote.until(() => remote.launcher.state(remote.id).state === 'idle')
    expect(remote.saved()[0]!.listener).toBeNull()
  })

  test('restore keeps matching identities and drops dead, reused and removed ones', async () => {
    const d = doc()
    createUpstream(d, { name: 'Two', baseUrl: 'http://127.0.0.1:7/v1' }, { localNames: [], selfPorts: [] })
    createUpstream(d, { name: 'Three', baseUrl: 'http://127.0.0.1:6/v1' }, { localNames: [], selfPorts: [] })
    const [a, b, c] = d.upstreams.map(u => u.id)
    const seed: LaunchedEntry[] = [
      { upstream: a!, root: ident(10), listener: ident(11), startedAt: 1 },
      { upstream: b!, root: ident(20), listener: ident(21), startedAt: 2 }, // 20 is a reused pid (other start time), 21 is dead
      { upstream: c!, root: ident(30), listener: null, startedAt: 3 },
      { upstream: 'u-removed', root: ident(40), listener: null, startedAt: 4 },
    ]
    const s = remembering(d, seed)
    s.world.set(10, { exe: 'X:\\apps\\svc.exe', birth: 'b10' })
    s.world.set(11, { exe: 'X:\\apps\\svc.exe', birth: 'b11' })
    s.world.set(20, { exe: 'X:\\apps\\svc.exe', birth: 'other' })
    s.world.set(30, { exe: 'X:\\apps\\other.exe', birth: 'b30' }) // same pid and start time, different program
    s.world.set(40, { exe: 'X:\\apps\\svc.exe', birth: 'b40' })
    await s.launcher.restore()
    expect(s.saved().map(e => e.upstream)).toEqual([a!])
    expect(s.saved()[0]).toMatchObject({ root: { pid: 10 }, listener: { pid: 11 } })
    expect(s.launcher.canStop(a!)).toBe(true)
    expect(s.launcher.canStop(b!)).toBe(false)
    expect(s.launcher.canStop(c!)).toBe(false)
    expect(s.killed).toEqual([])
  })

  test('exe paths compare case-insensitively on Windows only', async () => {
    const make = async (platform: NodeJS.Platform) => {
      const d = doc()
      const s = remembering(d, [{ upstream: d.upstreams[0]!.id, root: ident(10, 'X:\\Apps\\Svc.exe'), listener: null, startedAt: 1 }])
      s.world.set(10, { exe: 'x:\\apps\\svc.exe', birth: 'b10' })
      const l = new UpstreamLauncher({
        upstreams: () => d.upstreams, check: async () => ({ ok: false, models: [] }), onReady: () => {}, onChange: () => {},
        store: { load: () => s.saved(), save: () => {} }, identity: async pid => s.world.get(pid) ?? null, isAlive: pid => s.world.has(pid), platform,
      })
      await l.restore()
      return l.canStop(s.id)
    }
    expect(await make('win32')).toBe(true)
    expect(await make('linux')).toBe(false)
  })

  test('after a restart the service is stoppable while only its listener lives (root gone)', async () => {
    const d = doc()
    const s = remembering(d, [{ upstream: d.upstreams[0]!.id, root: ident(10), listener: ident(11), startedAt: 1 }])
    s.world.set(11, { exe: 'X:\\apps\\svc.exe', birth: 'b11' })
    await s.launcher.restore()
    expect(s.launcher.canStop(s.id)).toBe(true)
    await s.launcher.stop(s.id)
    expect(s.killed).toEqual([11])
    expect(s.saved()).toEqual([])
    expect(s.launcher.canStop(s.id)).toBe(false)
  })

  test('stop only ends identity-verified processes: a pid reused since the last check is left alone', async () => {
    const d = doc()
    const s = remembering(d, [{ upstream: d.upstreams[0]!.id, root: ident(10), listener: ident(11), startedAt: 1 }])
    s.world.set(10, { exe: 'X:\\apps\\svc.exe', birth: 'b10' })
    s.world.set(11, { exe: 'X:\\apps\\svc.exe', birth: 'b11' })
    await s.launcher.restore()
    s.world.set(10, { exe: 'X:\\other\\thing.exe', birth: 'new' }) // reused after the restore
    await s.launcher.stop(s.id)
    expect(s.killed).toEqual([11])
    expect(s.world.has(10)).toBe(true)
  })

  test('stop with nothing verified kills nothing and says it is not ours', async () => {
    const d = doc()
    const s = remembering(d, [{ upstream: d.upstreams[0]!.id, root: ident(10), listener: null, startedAt: 1 }])
    s.world.set(10, { exe: 'X:\\apps\\svc.exe', birth: 'b10' })
    await s.launcher.restore()
    s.world.set(10, { exe: 'X:\\apps\\svc.exe', birth: 'new' })
    await expect(s.launcher.stop(s.id)).rejects.toThrow(LaunchError)
    expect(s.killed).toEqual([])
    expect(s.saved()).toEqual([])
  })

  test('shutdown with stopOnExit ends a remembered service too; the others stay and stay remembered', async () => {
    const d = doc({ stopOnExit: true })
    createUpstream(d, { name: 'Stays', baseUrl: 'http://127.0.0.1:8/v1' }, { localNames: [], selfPorts: [] })
    const [a, b] = d.upstreams.map(u => u.id)
    const s = remembering(d, [
      { upstream: a!, root: null, listener: ident(11), startedAt: 1 },
      { upstream: b!, root: null, listener: ident(12), startedAt: 2 },
    ])
    s.world.set(11, { exe: 'X:\\apps\\svc.exe', birth: 'b11' })
    s.world.set(12, { exe: 'X:\\apps\\svc.exe', birth: 'b12' })
    await s.launcher.restore()
    await s.launcher.shutdown()
    expect(s.killed).toEqual([11])
    expect(s.saved().map(e => e.upstream)).toEqual([b!])
  })

  test('close keeps the file; cancel and a failed start remove the entry', async () => {
    const s = remembering(doc())
    s.world.set(4242, { exe: 'X:\\apps\\start.exe', birth: 'b1' })
    s.launcher.start(s.id, false)
    await s.until(() => s.saved()[0]?.root !== null && s.saved().length === 1)
    const before = s.saves()
    s.launcher.close()
    expect(s.saves()).toBe(before)
    expect(s.saved()).toHaveLength(1)

    const c = remembering(doc())
    c.launcher.start(c.id, false)
    await c.launcher.cancel(c.id)
    expect(c.saved()).toEqual([])

    const f = remembering(doc())
    f.launcher.start(f.id, false)
    f.procs[0]!.exitCb(2)
    expect(f.saved()).toEqual([])
  })

  test('forget drops the entry without touching the process', async () => {
    const d = doc()
    const s = remembering(d, [{ upstream: d.upstreams[0]!.id, root: null, listener: ident(11), startedAt: 1 }])
    s.world.set(11, { exe: 'X:\\apps\\svc.exe', birth: 'b11' })
    await s.launcher.restore()
    s.launcher.forget(s.id)
    expect(s.saved()).toEqual([])
    expect(s.killed).toEqual([])
    expect(s.world.has(11)).toBe(true)
  })

  test('the file store round-trips, and a torn file reads as nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-launched-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'run', 'upstreams-launched.json')
    const store = fileLaunchedStore(file)
    expect(store.load()).toEqual([])
    const e: LaunchedEntry = { upstream: 'u-1', root: ident(5), listener: { ...ident(6), pgid: 6 }, startedAt: 9 }
    store.save([e])
    expect(store.load()).toEqual([e])
    writeFileSync(file, '{ torn')
    expect(store.load()).toEqual([])
  })
})
