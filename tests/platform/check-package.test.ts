import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { checkMacApp, checkTree, machoArchs } from '../../desktop/check-package'
import { elf, machoArm64, machoUniversal, machoX64, peX64 } from '../fixtures/fake-binary'

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

test('the Windows allowlist is unchanged: bun.exe passes, a Mac "bun" does not', () => {
  put('bun')
  expect(checkTree(root, 'resources').problems).toEqual(['not allowed: bun'])
  expect(checkTree(root, 'resources', 'macos').problems).toEqual([])
})

// ---- macOS .app ----
const plist = (v: string) => `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${v}</string></dict></plist>`
const R = 'Contents/Resources/resources'
function putBin(rel: string, data: Buffer, mode = 0o755) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), data, { mode })
}
/** A minimal valid arm64 app tree. */
function goodApp(over: { bun?: Buffer, target?: string, version?: string } = {}) {
  const bun = over.bun ?? machoArm64()
  put('Contents/Info.plist', plist('1.2.3'))
  put('Contents/PkgInfo', 'APPL????')
  putBin('Contents/MacOS/llama-web-desktop', machoArm64())
  put('Contents/Resources/icon.icns')
  put('Contents/_CodeSignature/CodeResources')
  putBin(`${R}/bun`, bun)
  put(`${R}/versions.json`, JSON.stringify({ application: over.version ?? '1.2.3', target: over.target ?? 'macos-arm64', bunSha256: createHash('sha256').update(bun).digest('hex') }))
  for (const f of ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'import-data.mjs', 'app/nitro.json', 'app/server/index.mjs']) put(`${R}/${f}`)
  putBin(`${R}/app/server/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node`, machoArm64())
  putBin(`${R}/app/server/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.dylib`, machoArm64())
}

test('machoArchs reads thin and universal headers and rejects other files', () => {
  putBin('a', machoArm64()); putBin('b', machoX64()); putBin('c', machoUniversal([0x0100000c, 0x01000007])); putBin('d', peX64()); putBin('e', elf(0xb7))
  expect(machoArchs(join(root, 'a'))).toEqual(['arm64'])
  expect(machoArchs(join(root, 'b'))).toEqual(['x64'])
  expect(machoArchs(join(root, 'c'))).toEqual(['arm64', 'x64'])
  expect(machoArchs(join(root, 'd'))).toBeNull()
  expect(machoArchs(join(root, 'e'))).toBeNull()
})

test('a well-formed arm64 app passes', () => {
  goodApp()
  expect(checkMacApp(root).problems).toEqual([])
})

test('mac app: user data, secrets, stray files and local paths are refused', () => {
  goodApp()
  put(`${R}/app/server/data/settings.json`)
  put(`${R}/app/server/node_modules/x/.env`)
  put('Contents/Resources/notes.txt')
  put(`${R}/app/server/chunk.mjs`, `const p = ${JSON.stringify(homedir())}`)
  const problems = checkMacApp(root).problems.join('\n')
  expect(problems).toContain('denied: app/server/data/settings.json')
  expect(problems).toContain('denied: app/server/node_modules/x/.env')
  expect(problems).toContain('not allowed: Contents/Resources/notes.txt')
  expect(problems).toContain('home directory found in app/server/chunk.mjs')
  expect(problems).not.toContain(homedir())
})

test('mac app: wrong Bun, missing or foreign native files, wrong target and version are refused', () => {
  goodApp({ bun: machoX64(), target: 'windows-x64', version: '9.9.9' })
  rmSync(join(root, `${R}/app/server/node_modules/@img/sharp-libvips-darwin-arm64`), { recursive: true })
  putBin(`${R}/app/server/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node`, peX64())
  putBin(`${R}/app/server/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node`, machoX64())
  putBin(`${R}/bin/tool.dll`, peX64())
  const problems = checkMacApp(root).problems.join('\n')
  expect(problems).toContain('bundled Bun is not a thin arm64 Mach-O (x64)')
  expect(problems).toContain('libvips for darwin-arm64 is missing')
  expect(problems).toContain("other platform's native file")
  expect(problems).toContain('versions.json target is windows-x64')
  expect(problems).toContain('Info.plist version 1.2.3 differs from versions.json 9.9.9')
})

test.skipIf(process.platform === 'win32')('mac app: a non-executable Bun is refused', () => {
  goodApp()
  chmodSync(join(root, `${R}/bun`), 0o644)
  expect(checkMacApp(root).problems).toContain('bundled Bun is not executable')
})

test('mac app: a missing resources directory is refused', () => {
  goodApp()
  rmSync(join(root, R), { recursive: true })
  expect(checkMacApp(root).problems).toEqual(['Contents/Resources/resources is missing'])
})
