import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Runs scripts/pre-commit inside a throwaway git repo (needs git and a POSIX sh, e.g. Git for Windows).
const hookSource = readFileSync(resolve(import.meta.dir, '../../scripts/pre-commit'), 'utf8')
const git = Bun.which('git')
const available = !!git && !!Bun.which('sh')

let repo = ''

function run(args: string[]) {
  const p = Bun.spawnSync([git!, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

function stage(path: string, content: string) {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  run(['add', '-f', path])
}

function hook() {
  const p = Bun.spawnSync(['sh', join(repo, 'scripts/pre-commit')], { cwd: repo })
  return { code: p.exitCode, err: p.stderr.toString() }
}

beforeAll(() => {
  if (!available) return
  repo = mkdtempSync(join(tmpdir(), 'llama-web-hook-'))
  run(['init', '-q'])
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts/pre-commit'), hookSource.replace(/\r\n/g, '\n'))
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

function reset() {
  run(['rm', '-r', '-q', '--cached', '-f', '.'])
  run(['reset', '-q'])
}

describe.skipIf(!available)('scripts/pre-commit', () => {
  test('allows ordinary changes', () => {
    reset()
    stage('src/a.ts', 'export const x = 1\n// commit abcdef0 fixed this\n')
    expect(hook().code).toBe(0)
  })

  test('rejects files under data/', () => {
    reset()
    stage('data/settings.json', '{}')
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('data/settings.json')
  })

  test('rejects secrets.json and .env anywhere', () => {
    reset()
    stage('x/secrets.json', '{}')
    expect(hook().code).toBe(1)
    reset()
    stage('.env.local', 'A=1')
    expect(hook().code).toBe(1)
  })

  test('rejects sk- keys without printing the value', () => {
    reset()
    const key = 'sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx'
    stage('src/b.ts', `const k = '${key}'\n`)
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('src/b.ts')
    expect(r.err).not.toContain(key)
  })

  test('rejects long hex strings and Bearer tokens', () => {
    reset()
    stage('src/c.ts', `const h = '${'0123456789abcdef'.repeat(2)}'\n`)
    expect(hook().code).toBe(1)
    reset()
    stage('src/d.ts', 'const h = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"\n') // pre-commit:allow
    expect(hook().code).toBe(1)
  })

  test('does not flag short ids or words containing sk-', () => {
    reset()
    stage('src/e.ts', "const a = 'deadbeef'\nconst b = 'task-management-board-name-long'\n")
    expect(hook().code).toBe(0)
  })

  test('marker allows deliberate fakes; review reports may quote commit hashes', () => {
    reset()
    stage('tests/f.ts', `const k = 'sk-${'A'.repeat(30)}' // pre-commit:allow\n`)
    expect(hook().code).toBe(0)
    reset()
    stage('docs/reviews/r.md', 'commit `' + 'a'.repeat(40) + '`\n')
    expect(hook().code).toBe(0)
    reset()
    stage('docs/other.md', 'commit `' + 'a'.repeat(40) + '`\n')
    expect(hook().code).toBe(1)
  })

  test('only added lines are scanned', () => {
    reset()
    stage('src/g.ts', `const k = 'sk-${'A'.repeat(30)}'\n`)
    run(['commit', '-q', '--no-verify', '-m', 'seed'])
    stage('src/g.ts', `const k = 'sk-${'A'.repeat(30)}'\n`.replace('const k', 'const kk') + '// ok\n')
    expect(hook().code).toBe(1) // the changed line is added again
    run(['reset', '-q', '--hard'])
    stage('src/h.ts', 'const ok = 1\n')
    expect(hook().code).toBe(0)
  })
})
