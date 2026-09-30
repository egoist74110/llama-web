// Platform check: the command preview (formatCmdCommand) pasted into cmd.exe gives the program
// exactly the argument array llama-web itself would pass. Runs the line through a real cmd.exe
// (`cmd /d /s /c "<line>"`, command-line rules, not batch-file rules) with an argv echo fixture.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatCmdCommand } from '../../server/core/args'

const isWin = process.platform === 'win32'
const echo = join(import.meta.dir, '..', 'fixtures', 'echo-argv.ts')

function throughCmd(args: string[], exe = process.execPath): string[] {
  const line = formatCmdCommand(exe, [echo, ...args])
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    env: { ...process.env, LLW_PREVIEW_VAR: 'EXPANDED' },
  })
  if (r.status !== 0) throw new Error(`cmd failed (${r.status}): ${r.stderr}\n${line}`)
  return JSON.parse(r.stdout.trim()) as string[]
}

describe.if(isWin)('command preview through cmd.exe', () => {
  test('paths with spaces, & and parentheses', () => {
    const args = ['--model', 'X:\\models\\A&B.gguf', '--mmproj', 'X:\\my models\\m 1.gguf', '--draft', 'X:\\my models\\A&B (1).gguf']
    expect(throughCmd(args)).toEqual(args)
  })

  test('percent signs are not expanded', () => {
    const args = ['100%', '%LLW_PREVIEW_VAR%', 'a %LLW_PREVIEW_VAR% b', '%%']
    expect(throughCmd(args)).toEqual(args)
  })

  test('quotes, JSON and trailing backslashes', () => {
    const args = ['--chat-template-kwargs', '{"enable_thinking":false}', 'say "hi" & bye', 'trailing\\', 'trail space\\', 'back\\"slash']
    expect(throughCmd(args)).toEqual(args)
  })

  test('other metacharacters, empty and non-ASCII arguments', () => {
    const args = ['a|b', '<x>', '^caret', '!bang!', '', 'X:\\模型 目录\\模型.gguf']
    expect(throughCmd(args)).toEqual(args)
  })

  test('parentheses alone, and ; , = (cmd separators in a program name, plain in arguments)', () => {
    const args = ['(abc)', ')', '(', 'X:\\models\\A(1).gguf', 'a)b(c', 'a;b', 'c,d', 'k=v']
    expect(throughCmd(args)).toEqual(args)
  })

  test('program paths with spaces and cmd metacharacters', () => {
    const base = mkdtempSync(join(tmpdir(), 'llw-cmd-'))
    try {
      for (const name of ['a b', 'a&b', 'a b&c (x)', 'p100%', 'semi;co,ma=eq']) {
        const dir = join(base, name)
        mkdirSync(dir)
        const exe = join(dir, 'bun.exe')
        try { linkSync(process.execPath, exe) } catch { copyFileSync(process.execPath, exe) }
        const args = ['--model', 'X:\\m & n.gguf', '100%']
        expect(throughCmd(args, exe)).toEqual(args)
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
