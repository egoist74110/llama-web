// Release gate: what may ship in the Windows package. Usage:
//   bun desktop/check-package.ts <src-tauri/resources | installed resources dir | installer.exe>
// An installer is unpacked with 7-Zip (7z on PATH) into a temporary directory first.
// Fails when a file is outside the allowlist, looks like user data / secrets / logs, or a text
// file contains this machine's home directory, user name or checkout path (reported by kind only).
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'

const RESOURCE_ALLOW = [
  /^THIRD-PARTY-NOTICES\.txt$/, /^LICENSE\.txt$/, /^versions\.json$/, /^bun\.exe$/, /^import-data\.mjs$/,
  /^app\/nitro\.json$/, /^app\/public\//, /^app\/server\//,
]
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

export function checkTree(root: string, mode: 'resources' | 'installer') {
  const problems: string[] = []
  const markers = [
    { kind: 'home directory', value: homedir() },
    { kind: 'checkout path', value: resolve(import.meta.dir, '..') },
    { kind: 'user name', value: userInfo().username.length >= 4 ? userInfo().username : '' },
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
    if (!RESOURCE_ALLOW.some(r => r.test(inResources))) problems.push(`not allowed: ${rel}`)
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

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error('Usage: bun desktop/check-package.ts <resources dir | installer.exe>')
  let root = resolve(target)
  let temp: string | null = null
  let mode: 'resources' | 'installer' = 'resources'
  try {
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
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}
