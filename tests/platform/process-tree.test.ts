// Platform check (plan: tech validation): on Windows, Bun.spawn with an argv array keeps
// arguments intact, proc.kill() only kills the direct child, and `taskkill /T /F` kills the tree.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const fixtures = join(import.meta.dir, '..', 'fixtures')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  return !alive(pid)
}

async function spawnTree() {
  const parent = Bun.spawn([process.execPath, join(fixtures, 'tree-parent.ts')], { stdout: 'pipe', stderr: 'ignore' })
  const reader = parent.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const childPid = Number(/child=(\d+)/.exec(buf)?.[1])
  return { parent, childPid }
}

describe.skipIf(!isWin)('process tree on windows', () => {
  test('argv array is passed verbatim (spaces, quotes, backslashes, CJK)', async () => {
    const args = ['--model', 'X:\\models\\dir with space\\a.gguf', '--chat-template', '{"a": "b c"}', 'trailing\\', '中文 参数', '']
    const p = Bun.spawn([process.execPath, join(fixtures, 'echo-argv.ts'), ...args], { stdout: 'pipe' })
    const out = await new Response(p.stdout).text()
    await p.exited
    expect(JSON.parse(out)).toEqual(args)
  })

  // Observed on Bun 1.3 / Windows 11: children spawned by a Bun process die when that
  // Bun process dies, even on a hard kill (behaves like a kill-on-close Job Object).
  // This is what makes force-killing llama-web take its llama-server children with it.
  test('hard-killing a bun process also kills the children it spawned', async () => {
    const { parent, childPid } = await spawnTree()
    expect(alive(childPid)).toBe(true)
    const tk = Bun.spawn(['taskkill', '/PID', String(parent.pid), '/F'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await tk.exited).toBe(0)
    await parent.exited
    const dead = await waitDead(childPid)
    if (!dead) process.kill(childPid)
    expect(dead).toBe(true)
  })

  test('taskkill /T /F kills the whole tree', async () => {
    const { parent, childPid } = await spawnTree()
    expect(alive(childPid)).toBe(true)
    const tk = Bun.spawn(['taskkill', '/PID', String(parent.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await tk.exited).toBe(0)
    await parent.exited
    expect(await waitDead(childPid)).toBe(true)
  })

  test('executable path of a pid can be read (for residue cleanup)', async () => {
    const p = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore' })
    try {
      const q = Bun.spawn(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").ExecutablePath`],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const exe = (await new Response(q.stdout).text()).trim()
      await q.exited
      expect(exe.toLowerCase()).toBe(process.execPath.toLowerCase())
    } finally {
      p.kill()
      await p.exited
    }
  }, 20000)
})
