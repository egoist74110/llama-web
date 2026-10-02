import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkTree } from '../../desktop/check-package'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lw-pkgchk-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const put = (rel: string, text = 'x') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

test('allowlisted resources pass', () => {
  for (const f of ['versions.json', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'bun.exe', 'import-data.mjs', 'app/nitro.json', 'app/server/index.mjs', 'app/public/index.html']) put(f)
  expect(checkTree(root, 'resources').problems).toEqual([])
})

test('user data, secrets, logs, stray files and local paths are refused', () => {
  put('app/server/data/settings.json')
  put('app/server/node_modules/x/.env')
  put('app/server/debug.log')
  put('notes.txt')
  put('app/server/chunk.mjs', `const p = ${JSON.stringify(homedir())}`)
  const problems = checkTree(root, 'resources').problems.join('\n')
  expect(problems).toContain('denied: app/server/data/settings.json')
  expect(problems).toContain('denied: app/server/node_modules/x/.env')
  expect(problems).toContain('denied: app/server/debug.log')
  expect(problems).toContain('not allowed: notes.txt')
  expect(problems).toContain('home directory found in app/server/chunk.mjs')
  // The finding names the kind of marker, never its value.
  expect(problems).not.toContain(homedir())
})

test('installer layout: plugins and binaries at the root, everything else under resources', () => {
  put('$PLUGINSDIR/nsis_tauri_utils.dll')
  put('llama-web.exe')
  put('resources/versions.json')
  put('other/file.txt')
  expect(checkTree(root, 'installer').problems).toEqual(['not allowed: other/file.txt'])
})
