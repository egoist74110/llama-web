// Run with pinned Bun on native Windows. Build in an owned, isolated worktree.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import zh from '../i18n/zh-CN'

const root = resolve(import.meta.dir, '..')
const resources = join(root, 'src-tauri', 'resources')
const work = join(root, '..', `lw-build-${crypto.randomUUID().slice(0, 8)}`)
const BUN_VERSION = '1.3.14'
// LLAMA_WEB_RELEASE=1 (the release workflow): versions.json carries the plain application version.
const release = process.env.LLAMA_WEB_RELEASE === '1'
// --dev (scripts/launch.ts desktop): macOS or Windows, reuse the .output of the working tree and the running Bun,
// no isolated worktree, no licence collection. Never used for a release package.
const dev = process.argv.includes('--dev')
const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const appVersion: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
async function run(argv: string[], cwd = root) {
  const p = Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  if (await p.exited !== 0) throw new Error(`Command failed: ${argv[0]} ${argv[1]}`)
}
async function gitHead() {
  const p = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'inherit' })
  const out = (await new Response(p.stdout).text()).trim()
  if (await p.exited !== 0 || !/^[0-9a-f]{40}$/.test(out)) throw new Error('Cannot read the commit being packaged')
  return out
}
function digest(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function resourceDigest() {
  const hash = createHash('sha256')
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Linked desktop resource')
      if (entry.isDirectory()) visit(full)
      else { hash.update(JSON.stringify(full.slice(resources.length))); hash.update(digest(full)) }
    }
  }
  visit(join(resources, 'app'))
  hash.update(digest(join(resources, 'import-data.mjs')))
  return hash.digest('hex')
}
function licenses(path: string, result: string[], base = path) {
  for (const file of readdirSync(path, { withFileTypes: true })) {
    if (file.isSymbolicLink()) continue
    const full = join(path, file.name)
    if (file.isDirectory()) licenses(full, result, base)
    else if (/^(license|copying|notice)(\.|$)/i.test(file.name)) {
      result.push(`\n--- ${full.slice(base.length)} ---\n${readFileSync(full, 'utf8')}`)
    }
  }
}
if (dev) {
  if (!existsSync(join(root, '.output', 'server', 'index.mjs'))) throw new Error('Build the app first (bun run build)')
  rmSync(resources, { recursive: true, force: true })
  mkdirSync(resources, { recursive: true })
  cpSync(join(root, '.output'), join(resources, 'app'), { recursive: true })
  cpSync(process.execPath, join(resources, bunName))
  await run([process.execPath, 'build', join(root, 'desktop', 'import-data.ts'), '--target=bun', '--outfile=' + join(resources, 'import-data.mjs')])
  writeFileSync(join(root, 'desktop', 'ui', 'strings.json'), JSON.stringify(zh.desktop))
  writeFileSync(join(resources, 'versions.json'), JSON.stringify({ application: `${appVersion}-dev`, bun: Bun.version,
    bunSha256: digest(join(resources, bunName)), resourceId: resourceDigest(), target: `${process.platform}-${process.arch}-dev`, signature: 'none',
    license: 'MIT', commit: 'dev' }, null, 2))
  console.log('Prepared desktop resources (dev) from the current .output')
  process.exit(0)
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop packaging currently requires native Windows x64')
if (Bun.version !== BUN_VERSION) throw new Error(`Use Bun ${BUN_VERSION}`)
let added = false
try {
  await run(['git', 'worktree', 'add', '--detach', work, 'HEAD'])
  added = true
  // Copy only build inputs; never data, .env, existing build output or source node_modules.
  for (const name of ['app', 'server', 'i18n', 'public', 'nuxt.config.ts', 'tsconfig.json', 'package.json', 'bun.lock']) {
    cpSync(join(root, name), join(work, name), { recursive: true })
  }
  await run([process.execPath, 'install', '--frozen-lockfile'], work)
  await run([process.execPath, 'run', 'build'], work)
  // This directory is generated exclusively by this script; user data is never stored here.
  if (resolve(resources) !== join(root, 'src-tauri', 'resources')) throw new Error('Unexpected resource target')
  rmSync(resources, { recursive: true, force: true })
  mkdirSync(resources, { recursive: true })
  cpSync(join(work, '.output'), join(resources, 'app'), { recursive: true })
  cpSync(process.execPath, join(resources, 'bun.exe'))
  await run([process.execPath, 'build', join(root, 'desktop', 'import-data.ts'), '--target=bun', '--outfile=' + join(resources, 'import-data.mjs')])
  mkdirSync(join(root, 'src-tauri', 'icons'), { recursive: true })
  cpSync(join(root, 'public', 'favicon.ico'), join(root, 'src-tauri', 'icons', 'icon.ico'))
  writeFileSync(join(root, 'desktop', 'ui', 'strings.json'), JSON.stringify(zh.desktop))
  const notices: string[] = []
  licenses(join(work, 'node_modules'), notices)
  const cargo = Bun.spawn(['cargo', 'metadata', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'), '--locked',
    '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], { stdout: 'pipe', stderr: 'inherit' })
  const metadata = JSON.parse(await new Response(cargo.stdout).text())
  if (await cargo.exited !== 0) throw new Error('Cannot obtain Rust dependency notices')
  for (const pkg of metadata.packages) {
    if (!pkg.source) continue
    notices.push(`\n--- Rust: ${pkg.name} ${pkg.version} (${pkg.license ?? 'see package'}) ---\n`)
    const dir = dirname(pkg.manifest_path)
    for (const name of readdirSync(dir)) if (/^(license|copying|notice)(\.|$)/i.test(name)) {
      const path = join(dir, name)
      if (Bun.file(path).size > 0) notices.push(readFileSync(path, 'utf8'))
    }
  }
  // Bun's MIT license and bundled dependency acknowledgments are kept next to the runtime.
  const bunLicense = await fetch(`https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md`)
  if (!bunLicense.ok) throw new Error('Cannot obtain bundled Bun license')
  cpSync(join(root, 'LICENSE'), join(resources, 'LICENSE.txt'))
  writeFileSync(join(resources, 'THIRD-PARTY-NOTICES.txt'), `Bun ${BUN_VERSION}\n${await bunLicense.text()}\n${notices.join('\n')}`)
  writeFileSync(join(resources, 'versions.json'), JSON.stringify({ application: release ? appVersion : `${appVersion}-local-test`, bun: BUN_VERSION,
    bunSha256: digest(join(resources, 'bun.exe')), resourceId: resourceDigest(), target: 'windows-x64', signature: 'unsigned',
    license: 'MIT', commit: (await gitHead()).slice(0, 40) }, null, 2))
  console.log('Prepared desktop resources from isolated build')
} finally {
  if (added) {
    // Node's native filesystem API handles long Windows paths; Git may not.
    rmSync(join(work, 'node_modules'), { recursive: true, force: true })
    await run(['git', '-c', 'core.longpaths=true', 'worktree', 'remove', '--force', work])
  }
}
