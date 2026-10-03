import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archiveCommand, extractArchive, listingTotals, safeArchivePath, validateArchive } from '../../server/core/archive'
import { defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION } from '../../server/core/config'
import { acquireDataLock } from '../../server/core/data-lock'
import { installedDir, installLatest, listInstalled, versionsDir } from '../../server/core/llamacpp'
import { cloudflaredAssetName, platformInfo, runtimeTarget, type RuntimeTarget } from '../../server/core/platform'
import { PidRegistry, Runner, stopProcessGroup } from '../../server/core/runner'
import { cleanupResidue } from '../../server/core/residue'
import { JsonStore } from '../../server/core/store'
import { prepareCloudflared } from '../../server/core/tunnel'
import { Updater, versionOfExe } from '../../server/core/updater'
import { formatPosixCommand } from '../../server/core/args'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-platform-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })
const sha = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`
const cuda: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const cpu: RuntimeTarget = { ...cuda, acceleration: 'cpu' }
const mac: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }

test('host facts distinguish unknown NVIDIA, CPU and unverified Mac; unsupported combinations refuse', () => {
  expect(platformInfo('win32', 'x64').acceleration).toBe('unknown')
  expect(() => runtimeTarget(platformInfo('win32', 'x64'), 'auto')).toThrow()
  expect(runtimeTarget(platformInfo('win32', 'x64', false), 'auto')).toEqual(cpu)
  expect(runtimeTarget(platformInfo('win32', 'x64', true), 'auto')).toEqual(cuda)
  expect(runtimeTarget(platformInfo('darwin', 'arm64'), 'auto')).toEqual(mac)
  expect(platformInfo('darwin', 'arm64').verified).toBe(false)
  expect(platformInfo('darwin', 'x64').acceleration).toBe('cpu')
  for (const info of [platformInfo('linux', 'x64'), platformInfo('win32', 'arm64')]) expect(() => runtimeTarget(info, 'cpu')).toThrow()
  expect(() => runtimeTarget(platformInfo('darwin', 'arm64'), 'cuda')).toThrow()
  expect(cloudflaredAssetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz')
  expect(cloudflaredAssetName('darwin', 'x64')).toBe('cloudflared-darwin-amd64.tgz')
  expect(cloudflaredAssetName('win32', 'arm64')).toBeNull()
  expect(defaultSettings(platformInfo('win32', 'x64', false)).defaults.gpuLayers).toBe(0)
  expect(defaultSettings(platformInfo('win32', 'x64', false)).defaults.flashAttn).toBeNull()
  expect(defaultSettings(platformInfo('darwin', 'arm64')).defaults.cacheTypeK).toBeNull()
})

test('v3 settings migration backs up exact bytes and retains current version and every user parameter', () => {
  const old = defaultSettings()
  old.version = 3
  delete (old.llamacpp as any).acceleration
  old.llamacpp.current = 'b99'
  old.defaults.gpuLayers = 7
  old.defaults.extraArgs = '--jinja --custom-flag'
  const bytes = JSON.stringify(old)
  writeFileSync(join(data, 'settings.json'), bytes)
  const store = new JsonStore({ dataDir: data, name: 'settings.json', version: SETTINGS_VERSION,
    defaults: defaultSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS })
  const next = store.load()
  expect(next.llamacpp).toEqual({ ...old.llamacpp, acceleration: 'cuda' })
  expect(next.defaults).toEqual(old.defaults)
  const backup = readdirSync(join(data, 'backups'))[0]!
  expect(readFileSync(join(data, 'backups', backup), 'utf8')).toBe(bytes)
  store.close()
})

const put = (target: RuntimeTarget | undefined, tag: string, exe = target?.os === 'darwin' ? 'llama-server' : 'llama-server.exe') => {
  const d = join(versionsDir(data, target), tag)
  mkdirSync(d, { recursive: true }); writeFileSync(join(d, exe), 'fixture')
  return d
}
test('runtime namespaces: legacy Windows stays usable, invisible to CPU and either Mac architecture', () => {
  const old = put(undefined, 'b100')
  put(cuda, 'b200'); put(cpu, 'b300'); put(mac, 'b400')
  expect(listInstalled(data, 'win32', cuda)).toEqual(['b200', 'b100'])
  expect(listInstalled(data, 'win32', cpu)).toEqual(['b300'])
  expect(listInstalled(data, 'darwin', mac)).toEqual(['b400'])
  expect(listInstalled(data, 'darwin', { ...mac, arch: 'x64' })).toEqual([])
  expect(installedDir(data, 'b100', cuda)).toBe(old)
  expect(versionOfExe(data, join(versionsDir(data, mac), 'b400', 'llama-server'))).toBe('b400')
})
test('scoped updater can rollback to a legacy tag and prunes only its own platform', async () => {
  put(undefined, 'b100'); put(cuda, 'b200'); put(cuda, 'b300'); const other = put(mac, 'b1')
  const cfg = { cudaRuntime: '13.3', current: 'b300', keepVersions: 2, autoUpdate: false }
  const u = new Updater({ dataDir: data, platform: 'win32', target: cuda, llamacpp: () => cfg,
    setCurrent: t => { cfg.current = t }, usedExes: () => [] })
  expect(u.rollbackTarget()).toBe('b200'); expect(u.use('b100')).toBe('b100')
  await u.run()
  expect(existsSync(other)).toBe(true); expect(existsSync(installedDir(data, 'b100', cuda))).toBe(true)
})

function release(names: string[]) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://fixture.test/tag' }] })
    if (url.endsWith('/tag')) return new Response('b9')
    if (url.includes('/tags/')) return Response.json({ assets: names.map(name => ({ name, browser_download_url: `https://fixture.test/${name}`, digest: sha('fixture') })) })
    return new Response('fixture')
  }
  return { fetch, calls }
}
for (const target of [cpu, mac, { ...mac, arch: 'x64', acceleration: 'cpu' as const }]) {
  test(`official asset selection and optional cudart: ${target.os}/${target.arch}/${target.acceleration}`, async () => {
    const name = target.os === 'win32' ? 'llama-b9-bin-win-cpu-x64.zip' : `llama-b9-bin-macos-${target.arch}.tar.gz`
    const gh = release([name, 'llama-b9-bin-win-cuda-13.3-x64.zip'])
    let extracted = 0
    await installLatest({ dataDir: data, platform: target.os, target, cudaRuntime: '13.3', fetch: gh.fetch,
      extract: async (_file, dest) => { extracted++; mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, target.os === 'win32' ? 'llama-server.exe' : 'llama-server'), 'fixture') } })
    expect(extracted).toBe(1)
    expect(listInstalled(data, target.os, target)).toEqual(['b9'])
    expect(gh.calls.some(c => c.includes('cudart'))).toBe(false)
    expect(readdirSync(versionsDir(data, target))).toEqual(['b9'])
  })
}
test('wrong architecture and missing assets refuse; extraction failure leaves no version or temporary dir', async () => {
  await expect(installLatest({ dataDir: data, target: mac, platform: 'darwin', cudaRuntime: '', fetch: release(['llama-b9-bin-macos-x64.tar.gz']).fetch })).rejects.toMatchObject({ code: 'asset-missing' })
  await expect(installLatest({ dataDir: data, target: mac, platform: 'darwin', cudaRuntime: '', fetch: release(['llama-b9-bin-macos-arm64.tar.gz']).fetch,
    extract: async () => { throw new Error('fixture failure') } })).rejects.toThrow('fixture failure')
  expect(readdirSync(versionsDir(data, mac))).toEqual([])
})
test('Darwin cloudflared verifies and unpacks tgz; cancelled extraction leaves no binary', async () => {
  const name = 'cloudflared-darwin-arm64.tgz'
  const fetch = async (url: string) => url.endsWith('/latest') ? Response.json({ assets: [{ name, browser_download_url: 'https://fixture.test/cf', digest: sha('fixture') }] }) : new Response('fixture')
  const ac = new AbortController()
  const o = { dataDir: data, platform: 'darwin' as const, arch: 'arm64', env: { PATH: '' }, exists: () => false, fetch }
  await expect(prepareCloudflared({ ...o, net: { signal: ac.signal }, extract: async (_f, dest) => {
    mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'cloudflared'), 'fixture'); ac.abort()
  } })).rejects.toMatchObject({ code: 'download-failed' })
  const result = await prepareCloudflared({ ...o, extract: async (_f, dest) => {
    mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'cloudflared'), 'fixture')
  } })
  expect(readFileSync(result.exe, 'utf8')).toBe('fixture')
  expect(readdirSync(join(result.exe, '..'))).toEqual(['cloudflared'])
})

test('archive preflight refuses traversal, absolute paths, special entries and escaping links', () => {
  for (const p of ['../escape', '/escape', 'X:/escape', 'a/../../b', 'a\\..\\b', 'a:stream', 'a\nname']) expect(safeArchivePath(p)).toBe(false)
  expect(() => validateArchive('a\n', '-rw-r--r-- a')).not.toThrow()
  expect(() => validateArchive('../a', '-rw-r--r-- a')).toThrow()
  expect(() => validateArchive('a', 'lrwxr-xr-x a -> ../escape')).toThrow()
  expect(() => validateArchive('a', 'crw-r--r-- a')).toThrow()
})
for (const ext of ['zip', 'tar.gz', 'tgz']) test(`real system extractor accepts a tiny ${ext} fixture`, async () => {
  const src = join(data, 'src'); mkdirSync(src); writeFileSync(join(src, 'file.txt'), 'fixture')
  const file = join(data, `test.${ext}`)
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  const packed = spawnSync(tar, [ext === 'zip' ? '-acf' : '-czf', file, '-C', src, 'file.txt'])
  expect(packed.status).toBe(0)
  await extractArchive(file, join(data, 'out'))
  expect(readFileSync(join(data, 'out', 'file.txt'), 'utf8')).toBe('fixture')
}, 30000)
test('archive listing totals add up announced sizes and entries', () => {
  const v = '-rw-r--r--  0 user group     100 Jan  1  2024 a.bin\ndrwxr-xr-x  0 user group       0 Jan  1  2024 d/\n-rw-r--r--  0 user group      50 Jan  1  2024 d/b.bin'
  expect(listingTotals(v)).toEqual({ bytes: 150, entries: 3 })
})
test('extraction refuses an archive that expands past the budget before writing anything', async () => {
  const src = join(data, 'src'); mkdirSync(src); writeFileSync(join(src, 'padding.bin'), Buffer.alloc(8192))
  const file = join(data, 'bomb.tar.gz')
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  expect(spawnSync(tar, ['-czf', file, '-C', src, 'padding.bin']).status).toBe(0)
  const out = join(data, 'out')
  await expect(extractArchive(file, out, { maxBytes: 1024 })).rejects.toMatchObject({ code: 'extract-too-large' })
  expect(existsSync(join(out, 'padding.bin'))).toBe(false)
  // not enough free space for the announced size
  await expect(extractArchive(file, out, { maxBytes: 1 << 20, freeBytes: 4096 })).rejects.toMatchObject({ code: 'extract-too-large', detail: 'space:8192' })
  expect(existsSync(join(out, 'padding.bin'))).toBe(false)
  // entry count
  await expect(extractArchive(file, out, { maxEntries: 0 })).rejects.toMatchObject({ code: 'extract-too-large' })
  // within the budget it still extracts
  await extractArchive(file, out, { maxBytes: 1 << 20, maxEntries: 10, freeBytes: 1 << 30 })
  expect(readFileSync(join(out, 'padding.bin')).length).toBe(8192)
}, 30000)
test('extraction budget counts what the destination already holds (overlay)', async () => {
  const src = join(data, 'src'); mkdirSync(src); writeFileSync(join(src, 'b.bin'), Buffer.alloc(600))
  const file = join(data, 'b.tar.gz')
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  expect(spawnSync(tar, ['-czf', file, '-C', src, 'b.bin']).status).toBe(0)
  const out = join(data, 'out'); mkdirSync(out); writeFileSync(join(out, 'a.bin'), Buffer.alloc(600))
  await expect(extractArchive(file, out, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'extract-too-large' })
  expect(existsSync(join(out, 'b.bin'))).toBe(false)
}, 30000)
test('archive command timeout and cancellation wait for the extractor to close', async () => {
  await expect(archiveCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { extractTimeoutMs: 50 })).rejects.toThrow('timed out')
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 50)
  try { await expect(archiveCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: ac.signal })).rejects.toThrow('cancelled') }
  finally { clearTimeout(timer) }
}, 30000)

test('owned POSIX group gets TERM, bounded wait, KILL; already-exited leader does not discard descendants', async () => {
  const signals: Array<NodeJS.Signals | 0> = [], waits: number[] = []
  await stopProcessGroup(12345, { signal: (p, s) => { expect(p).toBe(-12345); signals.push(s) }, wait: async ms => { waits.push(ms) }, graceMs: 100 })
  expect(signals[0]).toBe('SIGTERM'); expect(signals.at(-1)).toBe('SIGKILL'); expect(waits.reduce((a, b) => a + b, 0)).toBe(100)
  const sent: unknown[] = []
  await stopProcessGroup(12345, { signal: (_p, s) => { sent.push(s); throw Object.assign(new Error(), { code: 'ESRCH' }) } })
  expect(sent).toEqual(['SIGTERM'])
})
test('data mutex rejects second owner before cleanup; dead parent can be reclaimed; duplicate release is safe', () => {
  const first = acquireDataLock(data, { pid: 1234, alive: () => true })
  writeFileSync(join(data, 'run', 'pids.json'), 'untouched')
  expect(() => acquireDataLock(data, { pid: 5678, alive: () => true })).toThrow('already in use')
  expect(readFileSync(join(data, 'run', 'pids.json'), 'utf8')).toBe('untouched')
  const second = acquireDataLock(data, { pid: 5678, alive: () => false })
  expect(() => first.release()).toThrow()
  second.release(); second.release()
})
test('PID v1 has exact backup, missing or reused birth identity cannot authorize a kill', async () => {
  const file = join(data, 'pids.json'), registry = new PidRegistry(file)
  const p = { pid: 101, exe: '/runtime/llama-server', port: 7100, tag: 'fixture', startedAt: 'fixture' }
  const bytes = JSON.stringify({ version: 1, processes: [p] }); writeFileSync(file, bytes)
  expect(registry.list()).toEqual([p]); expect(readFileSync(`${file}.v1.bak`, 'utf8')).toBe(bytes)
  registry.add({ ...p, birth: 'old', pgid: 101 })
  const killed: number[] = []
  const r = await cleanupResidue(registry, '/runtime', { platform: 'darwin', isAlive: () => true,
    identities: async () => new Map([[101, { exe: p.exe, birth: 'new', pgid: 101 }]]), killTree: async pid => { killed.push(pid) } })
  expect(killed).toEqual([]); expect(r.skipped.length).toBe(1)
})
test('failed PID migration backup and a future PID version are never overwritten by add', () => {
  const file = join(data, 'pids.json'), registry = new PidRegistry(file)
  const record = { pid: 101, exe: '/runtime/llama-server', port: 7100, tag: 'fixture', startedAt: 'fixture' }
  const old = JSON.stringify({ version: 1, processes: [record] }); writeFileSync(file, old)
  mkdirSync(`${file}.v1.bak`)
  expect(() => registry.add(record)).toThrow('backup')
  expect(readFileSync(file, 'utf8')).toBe(old)
  const future = JSON.stringify({ version: 3, processes: [record] }); writeFileSync(file, future)
  expect(() => registry.add(record)).toThrow('newer')
  expect(readFileSync(file, 'utf8')).toBe(future)
})
test('matching Mac identity and group authorizes cleanup; unknown path and changed group never do', async () => {
  const registry = new PidRegistry(join(data, 'pids.json'))
  for (const pid of [101, 102, 103]) registry.add({ pid, exe: '/runtime/llama-server', birth: 'same', pgid: pid, port: 7100, tag: 'fixture', startedAt: 'fixture' })
  const killed: number[] = []
  await cleanupResidue(registry, '/runtime', { platform: 'darwin', isAlive: () => true,
    identities: async () => new Map([[101, { exe: '/runtime/llama-server', birth: 'same', pgid: 101 }], [103, { exe: '/runtime/llama-server', birth: 'same', pgid: 999 }]]),
    killTree: async pid => { killed.push(pid) } })
  expect(killed).toEqual([101])
})
test('PID reuse between probes and a different executable inside runtime are both left alone', async () => {
  const registry = new PidRegistry(join(data, 'pids.json'))
  registry.add({ pid: 101, exe: '/runtime/llama-server', birth: 'old', pgid: 101, port: 7100, tag: 'fixture', startedAt: 'fixture' })
  let call = 0
  const killed: number[] = []
  await cleanupResidue(registry, '/runtime', { platform: 'darwin', isAlive: () => true,
    identities: async () => new Map([[101, { exe: '/runtime/llama-server', birth: ++call === 1 ? 'old' : 'new', pgid: 101 }]]),
    killTree: async pid => { killed.push(pid) } })
  expect(killed).toEqual([])
  registry.add({ pid: 102, exe: '/runtime/llama-server', birth: 'same', pgid: 102, port: 7100, tag: 'fixture', startedAt: 'fixture' })
  await cleanupResidue(registry, '/runtime', { platform: 'darwin', isAlive: () => true,
    identities: async () => new Map([[102, { exe: '/runtime/cloudflared', birth: 'same', pgid: 102 }]]),
    killTree: async pid => { killed.push(pid) } })
  expect(killed).toEqual([])
})
test('real second context refuses before reading config or cleaning PID records; dead owner recovers', async () => {
  const lockUrl = pathToFileURL(join(import.meta.dir, '../../server/core/data-lock.ts')).href
  const contextUrl = pathToFileURL(join(import.meta.dir, '../../server/service/context.ts')).href
  const owner = Bun.spawn([process.execPath, '-e', `import { acquireDataLock } from ${JSON.stringify(lockUrl)}; acquireDataLock(${JSON.stringify(data)}); console.log('locked'); setInterval(() => {}, 1000)`], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = owner.stdout.getReader()
    const first = await reader.read(); reader.releaseLock()
    expect(new TextDecoder().decode(first.value)).toContain('locked')
    const file = join(data, 'run', 'pids.json'); writeFileSync(file, 'unchanged fixture')
    const second = Bun.spawn([process.execPath, '-e', `import { getContext } from ${JSON.stringify(contextUrl)}; try { getContext(); process.exit(2) } catch (e) { console.log(e.message); process.exit(0) }`],
      { env: { ...process.env, LLAMA_WEB_DATA: data }, stdout: 'pipe', stderr: 'pipe' })
    expect(await second.exited).toBe(0)
    expect(await new Response(second.stdout).text()).toContain('already in use')
    expect(readFileSync(file, 'utf8')).toBe('unchanged fixture')
  } finally { owner.kill(); await owner.exited }
  const reclaimed = acquireDataLock(data); reclaimed.release()
}, 30000)
test.skipIf(process.platform !== 'win32')('a runner started inside Bun.serve persists birth identity without blocking the request loop', async () => {
  const registry = new PidRegistry(join(data, 'pids.json'))
  const runner = new Runner({ registry, portRange: [17400, 17500], healthIntervalMs: 25 })
  const fixture = join(import.meta.dir, '../fixtures/fake-llama-server.ts')
  const app = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    const child = await runner.start({ exe: process.execPath, args: port => [fixture, '--port', String(port)], tag: 'fixture', loadTimeoutMs: 10000 })
    await child.ready
    return Response.json(registry.list()[0])
  } })
  try {
    const response = await fetch(app.url)
    expect(response.ok).toBe(true)
    const record = await response.json() as { birth?: string }
    expect(typeof record.birth).toBe('string')
  } finally { await runner.stopAll(); app.stop(true) }
  expect(registry.list()).toEqual([])
}, 30000)
test('POSIX preview quotes substitutions, operators, empty args and embedded apostrophes', () => {
  expect(formatPosixCommand('/app/llama-server', ['$HOME', '$(id)', 'a;b', "a'b", ''])).toBe("'/app/llama-server' '$HOME' '$(id)' 'a;b' 'a'\"'\"'b' ''")
})
