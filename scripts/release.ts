// Cross-platform (Windows / macOS) release helper. Wrapped by release.bat / release.command.
// Usage: bun scripts/release.ts [next|patch|minor|major|<x.y.z[-pre.N]>] [options]
//   next     (default) 0.1.0-beta.7 -> 0.1.0-beta.8; a stable version goes to its next patch
//   patch / minor / major   bump and drop any pre-release part
//   <version>               use this exact version (no leading "v")
// Options:
//   -m, --message <text>  commit message for uncommitted work (asked for when stdin is a terminal)
//   --notes <file>        use this file as docs/release-notes/v<version>.md
//   --windows-only        skip the macOS workflow
//   --skip-checks         skip the local `bun test` / `bun run typecheck`
//   --publish             after both builds pass, publish the draft (asks you to type the version)
//   -y, --yes             do not ask for confirmation (needed when stdin is not a terminal)
//   --dry-run             print what would happen, change nothing
// Flow: checks -> commit pending work -> bump package.json -> release notes -> test -> commit -> push
//       -> "Windows release (draft)" -> "macOS arm64 build" (attach_to_draft) -> draft link.
// The release stays a DRAFT unless --publish is given: publishing is the step after you tried the installer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const root = resolve(import.meta.dir, '..')
const pkgPath = join(root, 'package.json')
const notesDir = join(root, 'docs', 'release-notes')
const windowsWorkflow = 'release-windows.yml'
const macosWorkflow = 'release-macos.yml'
const log = (msg: string) => console.log(`[release] ${msg}`)

class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg) }

// ---- arguments ----

interface Options {
  bump: string
  message?: string
  notes?: string
  windowsOnly: boolean
  skipChecks: boolean
  publish: boolean
  yes: boolean
  dryRun: boolean
}

function parseArgs(argv: string[]): Options {
  const o: Options = { bump: 'next', windowsOnly: false, skipChecks: false, publish: false, yes: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = () => argv[++i] ?? fail(`${a} needs a value`)
    if (a === '-m' || a === '--message') o.message = value()
    else if (a === '--notes') o.notes = value()
    else if (a === '--windows-only') o.windowsOnly = true
    else if (a === '--skip-checks') o.skipChecks = true
    else if (a === '--publish') o.publish = true
    else if (a === '-y' || a === '--yes') o.yes = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a.startsWith('-')) fail(`Unknown option ${a}`)
    else o.bump = a
  }
  return o
}

// ---- process helpers ----

interface Run { code: number, out: string }

function run(cmd: string[], opts: { allowFail?: boolean } = {}): Run {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim()
  if (p.exitCode !== 0 && !opts.allowFail) fail(`${cmd.join(' ')} failed (exit ${p.exitCode}):\n${out}`)
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim() || out }
}

// Streams output; used for the long local checks and pushes.
async function runLive(cmd: string[]): Promise<number> {
  const child = Bun.spawn(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
  return await child.exited
}

const git = (...args: string[]) => run(['git', ...args]).out
const gh = (...args: string[]) => run(['gh', ...args]).out

// ---- prompts ----

const interactive = Boolean(process.stdin.isTTY)

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(question)).trim() } finally { rl.close() }
}

async function confirm(question: string, o: Options): Promise<void> {
  if (o.yes) return
  if (!interactive) fail(`${question} needs confirmation: run in a terminal or pass --yes`)
  const answer = (await ask(`[release] ${question} [y/N] `)).toLowerCase()
  if (answer !== 'y' && answer !== 'yes') fail('Cancelled')
}

// ---- version ----

const versionRe = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+)\.(\d+))?$/

export function nextVersion(current: string, bump: string): string {
  if (versionRe.test(bump)) return bump
  const m = versionRe.exec(current) ?? fail(`package.json version "${current}" is not x.y.z[-pre.N]`)
  const [major, minor, patch] = [Number(m![1]), Number(m![2]), Number(m![3])]
  const [pre, n] = [m![4], m![5]]
  if (bump === 'next') return pre ? `${major}.${minor}.${patch}-${pre}.${Number(n) + 1}` : `${major}.${minor}.${patch + 1}`
  if (bump === 'patch') return `${major}.${minor}.${patch + (pre ? 0 : 1)}`
  if (bump === 'minor') return `${major}.${minor + (pre && patch === 0 ? 0 : 1)}.0`
  if (bump === 'major') return `${major + (pre && minor === 0 && patch === 0 ? 0 : 1)}.0.0`
  return fail(`Unknown bump "${bump}" (use next, patch, minor, major or an exact version)`)
}

function readVersion(): string {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version
}

// Replaces only the top-level "version" line so the rest of package.json keeps its formatting.
function writeVersion(version: string) {
  const text = readFileSync(pkgPath, 'utf8')
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`)
  if (next === text) fail('Could not find the "version" line in package.json')
  writeFileSync(pkgPath, next)
}

// ---- working tree ----

// cargo rewrites src-tauri/Cargo.lock without the "pre-commit:allow" markers on checksum lines. That is
// only noise and the pre-commit hook rejects it, so restore the file when nothing else differs.
function restoreCargoLockNoise() {
  const lock = 'src-tauri/Cargo.lock'
  if (!git('status', '--short', '--', lock)) return
  const diff = git('diff', '-U0', '--', lock)
  const real = diff.split('\n').filter(l => /^[+-][^+-]/.test(l)).map(l => l.replace(/\s*# pre-commit:allow.*$/, '').trimEnd())
  const removed = real.filter(l => l.startsWith('-')).map(l => l.slice(1))
  const added = real.filter(l => l.startsWith('+')).map(l => l.slice(1))
  if (removed.length === added.length && removed.every((l, i) => l === added[i])) {
    git('checkout', '--', lock)
    log('restored src-tauri/Cargo.lock (cargo only dropped its pre-commit:allow markers)')
  }
}

async function commitPending(o: Options) {
  const status = git('status', '--short')
  if (!status) return
  log('uncommitted changes:')
  console.log(status)
  let message = o.message
  if (!message) {
    if (!interactive) fail('Working tree is dirty: pass -m "<message>" to commit it, or clean it first')
    message = await ask('[release] commit message (empty = cancel): ') || fail('Cancelled')
  } else await confirm('Commit these changes?', o)
  if (o.dryRun) return log(`(dry run) would commit: ${message}`)
  git('add', '-A')
  const code = await runLive(['git', 'commit', '-m', message])
  if (code !== 0) fail('git commit failed (the pre-commit hook prints the reason above)')
}

// ---- release notes ----

const carriedSections = ['macOS 说明', 'Windows 说明', '文件']

// Skeleton: change list from commit subjects since the last tag, plus the platform sections of the
// previous notes with the old version replaced. The TODO marker blocks the release until it is removed.
function draftNotes(version: string, previousTag: string | undefined): string {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const subjects = git('log', range, '--no-merges', '--pretty=format:%s').split('\n').filter(Boolean)
    .filter(s => !/^release: prepare/i.test(s))
  const head = [
    `<!-- TODO: edit this draft (summary + 新增 / 修复), then delete this line. Commits since ${previousTag ?? 'the start'} are listed below. -->`,
    `llama-web ${version}。`,
    '',
    '## 新增',
    '',
    ...subjects.map(s => `- ${s}`),
    '',
    '## 修复',
    '',
    '- ',
    '',
  ]
  const prevFile = previousTag ? join(notesDir, `${previousTag}.md`) : ''
  if (!prevFile || !existsSync(prevFile)) return `${head.join('\n')}\n`
  const prevVersion = previousTag!.slice(1)
  const parts = readFileSync(prevFile, 'utf8').split(/^(?=## )/m)
  const kept = parts.filter(p => carriedSections.some(h => p.startsWith(`## ${h}`)))
    .map(p => p.trimEnd().replaceAll(prevVersion, version))
  return `${head.join('\n')}${kept.join('\n\n')}\n`
}

async function ensureNotes(version: string, previousTag: string | undefined, o: Options): Promise<string> {
  const file = join(notesDir, `v${version}.md`)
  if (o.notes) {
    if (!existsSync(o.notes)) fail(`--notes file not found: ${o.notes}`)
    if (!o.dryRun) writeFileSync(file, readFileSync(o.notes, 'utf8'))
  } else if (!existsSync(file)) {
    log(`writing a draft of docs/release-notes/v${version}.md`)
    if (!o.dryRun) writeFileSync(file, draftNotes(version, previousTag))
  } else log(`using the existing docs/release-notes/v${version}.md`)
  if (o.dryRun) return file
  for (;;) {
    if (!readFileSync(file, 'utf8').includes('TODO')) return file
    if (!interactive) fail(`Edit ${file} (remove the TODO line), then run again`)
    await ask(`[release] Edit ${file} and delete the TODO line, then press Enter... `)
  }
}

// ---- GitHub workflows ----

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Starts the workflow and returns the id of the run it created for this commit.
async function dispatch(workflow: string, fields: Record<string, string>, sha: string): Promise<string> {
  const startedAt = Date.now() - 60_000
  const args = ['workflow', 'run', workflow, '--ref', 'main']
  for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`)
  gh(...args)
  for (let i = 0; i < 30; i++) {
    await sleep(3000)
    const rows = JSON.parse(gh('run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch',
      '--limit', '10', '--json', 'databaseId,headSha,createdAt'))
    const hit = rows.find((r: { headSha: string, createdAt: string }) => r.headSha === sha && Date.parse(r.createdAt) >= startedAt)
    if (hit) return String(hit.databaseId)
  }
  return fail(`${workflow}: the run did not show up; check the Actions tab`)
}

async function waitRun(name: string, id: string) {
  const url = gh('run', 'view', id, '--json', 'url', '--jq', '.url')
  log(`${name}: ${url}`)
  const code = await runLive(['gh', 'run', 'watch', id, '--exit-status', '--interval', '20'])
  if (code !== 0) fail(`${name} failed: ${url}`)
  log(`${name}: passed`)
}

// ---- main ----

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2))

  if (run(['gh', '--version'], { allowFail: true }).code !== 0) fail('gh (GitHub CLI) was not found in PATH: https://cli.github.com')
  if (run(['gh', 'auth', 'status'], { allowFail: true }).code !== 0) fail('gh is not logged in: run `gh auth login`')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`Releases are built from main (current branch: ${branch})`)

  git('fetch', 'origin', '--tags', '--quiet')
  const [behind] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/).map(Number)
  if (behind) fail(`main is ${behind} commit(s) behind origin/main: pull first`)

  restoreCargoLockNoise()
  await commitPending(o)

  const current = readVersion()
  const version = nextVersion(current, o.bump)
  const tag = `v${version}`
  if (git('tag', '--list', tag) || run(['gh', 'release', 'view', tag], { allowFail: true }).code === 0) {
    fail(`${tag} already exists (tag or release)`)
  }
  const previousTag = run(['git', 'describe', '--tags', '--abbrev=0', '--match', 'v*'], { allowFail: true }).out || undefined
  log(`version ${current} -> ${version}${o.windowsOnly ? ' (Windows only)' : ''}${o.publish ? ', will publish' : ', draft only'}`)

  if (o.dryRun) {
    await ensureNotes(version, previousTag, o)
    log('(dry run) would: bump package.json, commit, push, run the Windows workflow' +
      `${o.windowsOnly ? '' : ', then the macOS workflow'}${o.publish ? ', publish the draft' : ''}`)
    return 0
  }
  await confirm(`Release ${tag}?`, o)

  writeVersion(version)
  const notes = await ensureNotes(version, previousTag, o)

  if (!o.skipChecks) {
    log('bun test')
    if (await runLive(['bun', 'test']) !== 0) fail('bun test failed; the version bump stays uncommitted')
    log('bun run typecheck')
    if (await runLive(['bun', 'run', 'typecheck']) !== 0) fail('typecheck failed; the version bump stays uncommitted')
    restoreCargoLockNoise()
  }

  git('add', 'package.json', notes)
  const staged = git('diff', '--cached', '--name-only')
  if (staged.split('\n').some(f => f && f !== 'package.json' && !f.startsWith('docs/release-notes/'))) {
    fail(`Unexpected staged files:\n${staged}`)
  }
  if (await runLive(['git', 'commit', '-m', `release: prepare ${tag}`]) !== 0) fail('git commit failed')
  if (await runLive(['git', 'push', 'origin', 'main']) !== 0) fail('git push failed')
  const sha = git('rev-parse', 'HEAD')

  await waitRun('Windows', await dispatch(windowsWorkflow, { version }, sha))
  if (!o.windowsOnly) {
    await waitRun('macOS', await dispatch(macosWorkflow, { version, attach_to_draft: 'true' }, sha))
  }

  const draft = JSON.parse(gh('release', 'view', tag, '--json', 'url,isDraft,assets'))
  log(`draft ready: ${draft.url}`)
  log(`files: ${draft.assets.map((a: { name: string }) => a.name).join(', ')}`)

  if (!o.publish) {
    log('Left as a draft. Download and try the installer, then publish it on GitHub or re-run with --publish for the next release.')
    return 0
  }
  if (!interactive && !o.yes) fail('--publish needs a terminal (or --yes)')
  if (!o.yes) {
    const typed = await ask(`[release] Type the version (${version}) to publish the draft: `)
    if (typed !== version) fail('Not published (version did not match); the draft is still there')
  }
  gh('release', 'edit', tag, '--draft=false', '--prerelease=' + String(version.includes('-')))
  log(`published: ${draft.url}`)
  return 0
}

if (import.meta.main) {
  try {
    process.exit(await main())
  } catch (e) {
    console.error(`[release] ${e instanceof Fail ? e.message : e}`)
    process.exit(1)
  }
}
