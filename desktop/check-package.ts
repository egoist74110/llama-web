// Release gate: what may ship in a desktop package. Usage:
//   bun desktop/check-package.ts <src-tauri/resources | installed resources dir | installer.exe | llama-web.app | llama-web.dmg>
// A Windows installer is unpacked with 7-Zip (7z on PATH) into a temporary directory first; a macOS DMG is
// mounted read-only with hdiutil (macOS only) and its .app is checked in place.
// Fails when a file is outside the allowlist, looks like user data / secrets / logs, or a text
// file contains this machine's home directory, user name or checkout path (reported by kind only).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'

export type PackageTarget = 'windows' | 'macos'
const RESOURCE_ALLOW_COMMON = [
  /^THIRD-PARTY-NOTICES\.txt$/, /^LICENSE\.txt$/, /^versions\.json$/, /^import-data\.mjs$/,
  /^app\/nitro\.json$/, /^app\/public\//, /^app\/server\//,
]
const RESOURCE_ALLOW = { windows: [/^bun\.exe$/, ...RESOURCE_ALLOW_COMMON], macos: [/^bun$/, ...RESOURCE_ALLOW_COMMON] }
// Anything that would be user data, secrets, logs or development leftovers.
const DENY = [
  /(^|\/)data\//, /(^|\/)\.env(\.|$)/, /(^|\/)secrets\.json$/, /(^|\/)pids\.json$/, /(^|\/)app-update\.json$/,
  /\.log$/i, /\.(pem|key|pfx|p12)$/i, /(^|\/)\.git(\/|$)/, /(^|\/)\.cache\//, /(^|\/)import-backups\//, /\.gguf$/i,
]
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.html', '.css', '.map', '.ts', '.nsh', '.ini', '.xml', ''])

function files(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Linked entry: ${relative(base, full)}`)
    if (entry.isDirectory()) files(full, base, out)
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

export function checkTree(root: string, mode: 'resources' | 'installer', target: PackageTarget = 'windows') {
  const problems: string[] = []
  const markers = [
    { kind: 'home directory', value: homedir() },
    { kind: 'checkout path', value: resolve(import.meta.dir, '..') },
    // The macOS runner's account is called "runner", an ordinary word in the code itself; it is not a person's
    // name, so the user-name marker is skipped on the GitHub macOS runner (home directory and checkout path still apply).
    { kind: 'user name', value: userInfo().username.length >= 4 && !(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true') ? userInfo().username : '' },
  ].filter(m => m.value).flatMap(m => [m, { kind: m.kind, value: m.value.split('\\').join('/') }, { kind: m.kind, value: m.value.split('\\').join('\\\\') }])
  const list = files(root)
  let scanned = 0
  for (const rel of list) {
    let inResources = rel
    if (mode === 'installer') {
      if (/^\$PLUGINSDIR\//.test(rel) || /^[^/]+\.exe$/i.test(rel)) continue
      if (!rel.startsWith('resources/')) { problems.push(`not allowed: ${rel}`); continue }
      inResources = rel.slice('resources/'.length)
    }
    if (!RESOURCE_ALLOW[target].some(r => r.test(inResources))) problems.push(`not allowed: ${rel}`)
    if (DENY.some(r => r.test(inResources))) problems.push(`denied: ${rel}`)
    const full = join(root, rel)
    if (TEXT.has(extname(rel).toLowerCase()) && lstatSync(full).size < 32 * 1024 * 1024) {
      scanned++
      const text = readFileSync(full, 'latin1').toLowerCase()
      for (const m of markers) if (text.includes(m.value.toLowerCase())) problems.push(`${m.kind} found in ${rel}`)
    }
  }
  return { files: list.length, scanned, problems: [...new Set(problems)] }
}

// ---- macOS .app ----------------------------------------------------------------------------------
// Everything a Tauri .app of this project contains outside resources/.
const APP_ALLOW = [
  /^Contents\/Info\.plist$/, /^Contents\/PkgInfo$/, /^Contents\/MacOS\/llama-web-desktop$/, /^Contents\/Resources\/icon\.icns$/,
  /^Contents\/_CodeSignature\/CodeResources$/,
]
// Native code of other platforms (or other Mac architectures) must not ride along in the arm64 package.
const FOREIGN_NATIVE = [/\.(exe|dll)$/i, /sharp-(win32|linux|linuxmusl|wasm)/i, /sharp-libvips-(win32|linux|linuxmusl)/i, /sharp-darwin-x64/, /sharp-libvips-darwin-x64/]

/** CPU of a thin or universal Mach-O file, or null when it is not one. 'arm64' | 'x64' | list for universal. */
export function machoArchs(file: string): string[] | null {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(8 + 5 * 20)
    const n = readSync(fd, head, 0, head.length, 0)
    if (n < 8) return null
    const name = (cpu: number) => (cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `cpu-${cpu.toString(16)}`)
    if (head.readUInt32LE(0) === 0xfeedfacf) return [name(head.readUInt32LE(4))]
    if (head.readUInt32BE(0) === 0xcafebabe) {
      const count = Math.min(head.readUInt32BE(4), 5)
      return Array.from({ length: count }, (_, i) => name(head.readUInt32BE(8 + i * 20)))
    }
    return null
  } finally { closeSync(fd) }
}

/** Check a macOS .app directory (arm64 only). `signed` also runs codesign (macOS hosts only). */
export function checkMacApp(app: string, opts: { codesign?: boolean } = {}) {
  const problems: string[] = []
  const resources = join(app, 'Contents', 'Resources', 'resources')
  if (!existsSync(resources)) return { files: 0, scanned: 0, problems: ['Contents/Resources/resources is missing'] }
  const all = files(app)
  for (const rel of all) {
    if (rel.startsWith('Contents/Resources/resources/')) continue
    if (!APP_ALLOW.some(r => r.test(rel))) problems.push(`not allowed: ${rel}`)
  }
  const inner = checkTree(resources, 'resources', 'macos')
  problems.push(...inner.problems.map(p => `resources: ${p}`))
  for (const rel of all) if (FOREIGN_NATIVE.some(r => r.test(rel))) problems.push(`other platform's native file: ${rel}`)

  const bun = join(resources, 'bun')
  if (!existsSync(bun)) problems.push('bundled Bun is missing')
  else {
    const archs = machoArchs(bun)
    if (!archs || archs.join() !== 'arm64') problems.push(`bundled Bun is not a thin arm64 Mach-O (${archs?.join('+') ?? 'not Mach-O'})`)
    // Windows file systems carry no execute bit, so the check only means something on a POSIX host.
    if (process.platform !== 'win32' && (lstatSync(bun).mode & 0o111) === 0) problems.push('bundled Bun is not executable')
  }
  // sharp: the arm64 addon and libvips must be present and arm64.
  const img = join(resources, 'app', 'server', 'node_modules', '@img')
  const native = (dir: string, ext: RegExp) => {
    try { return readdirSync(join(img, dir, 'lib')).filter(f => ext.test(f)).map(f => join(img, dir, 'lib', f)) } catch { return [] }
  }
  for (const [dir, ext, what] of [['sharp-darwin-arm64', /\.node$/, 'sharp addon'], ['sharp-libvips-darwin-arm64', /\.dylib$/, 'libvips']] as const) {
    const found = native(dir, ext)
    if (!found.length) problems.push(`${what} for darwin-arm64 is missing`)
    for (const f of found) if (machoArchs(f)?.join() !== 'arm64') problems.push(`${what} is not arm64: ${relative(app, f)}`)
  }
  try {
    const versions = JSON.parse(readFileSync(join(resources, 'versions.json'), 'utf8'))
    if (versions.target !== 'macos-arm64') problems.push(`versions.json target is ${versions.target}, expected macos-arm64`)
    if (existsSync(bun) && versions.bunSha256 !== createHash('sha256').update(readFileSync(bun)).digest('hex')) problems.push('versions.json bunSha256 does not match the bundled Bun')
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')
    const shown = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]
    if (shown !== versions.application) problems.push(`Info.plist version ${shown} differs from versions.json ${versions.application}`)
  } catch (e) { problems.push(`versions.json / Info.plist unreadable: ${(e as Error).message}`) }
  if (opts.codesign) {
    // The app seal must verify, and the bundled Bun must keep its own (Developer ID, hardened-runtime, JIT entitlement)
    // signature: re-signing it ad-hoc would drop the entitlements and Bun would crash on its first JIT page.
    const run = (args: string[]) => spawnSync('codesign', args, { encoding: 'utf8' })
    if (run(['--verify', '--deep', '--strict', app]).status !== 0) problems.push('codesign --verify failed for the app')
    if (existsSync(bun)) {
      if (run(['--verify', '--strict', bun]).status !== 0) problems.push('bundled Bun signature does not verify')
      const ent = run(['-d', '--entitlements', '-', bun])
      if (!(ent.stdout + ent.stderr).includes('com.apple.security.cs.allow-jit')) problems.push('bundled Bun lost its allow-jit entitlement')
    }
  }
  return { files: all.length, scanned: inner.scanned, problems: [...new Set(problems)] }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error('Usage: bun desktop/check-package.ts <resources dir | installer.exe | llama-web.app | llama-web.dmg>')
  let root = resolve(target)
  let temp: string | null = null
  let mounted: string | null = null
  let mode: 'resources' | 'installer' = 'resources'
  try {
    if (/\.dmg$/i.test(root) || /\.app$/i.test(root)) {
      let app = root
      if (/\.dmg$/i.test(root)) {
        if (process.platform !== 'darwin') throw new Error('A DMG can only be checked on macOS')
        mounted = mkdtempSync(join(tmpdir(), 'lw-dmg-'))
        const r = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, root], { stdio: ['ignore', 'ignore', 'inherit'] })
        if (r.status !== 0) { rmSync(mounted, { recursive: true, force: true }); mounted = null; throw new Error('hdiutil could not mount the DMG') }
        const top = readdirSync(mounted)
        const extra = top.filter(n => !/^llama-web\.app$|^Applications$|^\.(DS_Store|VolumeIcon\.icns|background|fseventsd|Trashes)$/.test(n))
        for (const n of extra) console.error(`package check: not allowed at the DMG root: ${n}`)
        if (extra.length) process.exitCode = 1
        app = join(mounted, 'llama-web.app')
      }
      const result = checkMacApp(app, { codesign: process.platform === 'darwin' })
      console.log(`checked ${result.files} files in the app (${result.scanned} text files scanned for local paths)`)
      for (const p of result.problems) console.error(`package check: ${p}`)
      if (result.problems.length) process.exitCode = 1
      else if (!process.exitCode) console.log('package check passed')
    } else {
      if (/\.exe$/i.test(root)) {
        temp = mkdtempSync(join(tmpdir(), 'lw-pkg-'))
        const r = spawnSync('7z', ['x', '-y', `-o${temp}`, root], { stdio: ['ignore', 'ignore', 'inherit'] })
        if (r.status !== 0) throw new Error('7z could not unpack the installer')
        root = temp
        mode = 'installer'
      }
      const result = checkTree(root, mode)
      console.log(`checked ${result.files} files (${result.scanned} text files scanned for local paths)`)
      for (const p of result.problems) console.error(`package check: ${p}`)
      if (result.problems.length) process.exitCode = 1
      else console.log('package check passed')
    }
  } finally {
    if (mounted) spawnSync('hdiutil', ['detach', '-force', mounted], { stdio: 'ignore' })
    if (mounted) rmSync(mounted, { recursive: true, force: true })
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}
