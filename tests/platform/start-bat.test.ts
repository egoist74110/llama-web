// start.bat is run by cmd.exe: POSIX redirections such as `>/dev/null` only work there by
// accident (when <drive>:\dev exists) and otherwise make the command fail.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const text = readFileSync(join(import.meta.dir, '..', '..', 'start.bat'), 'utf8')

test('start.bat uses cmd redirections only', () => {
  expect(text).not.toContain('/dev/null')
  expect(text).toMatch(/where bun >nul 2>nul/)
})

// `bun` is usually bun.cmd: without `call` the batch file never returns to its error handling.
test('start.bat runs the built server with call bun', () => {
  expect(text).toContain('call bun ".output\\server\\index.mjs"')
})
