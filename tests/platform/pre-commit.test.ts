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
  // Each hook run starts git and sh processes (slow on Windows, slower while the whole suite runs in
  // parallel): one run per test where possible, with an explicit budget instead of bun's default 5 s.
  const it = (name: string, fn: () => void, ms = 30_000) => test(name, fn, ms)

  it('allows ordinary changes', () => {
    reset()
    stage('src/a.ts', 'export const x = 1\n// commit abcdef0 fixed this\n')
    expect(hook().code).toBe(0)
  })

  it('rejects files under data/', () => {
    reset()
    stage('data/settings.json', '{}')
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('data/settings.json')
  })

  it('rejects secrets.json anywhere', () => {
    reset()
    stage('x/secrets.json', '{}')
    expect(hook().code).toBe(1)
  })

  it('rejects .env anywhere', () => {
    reset()
    stage('.env.local', 'A=1')
    expect(hook().code).toBe(1)
  })

  it('rejects sk- keys without printing the value', () => {
    reset()
    const key = 'sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx'
    stage('src/b.ts', `const k = '${key}'\n`)
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('src/b.ts')
    expect(r.err).not.toContain(key)
  })

  it('rejects long hex strings', () => {
    reset()
    stage('src/c.ts', `const h = '${'0123456789abcdef'.repeat(2)}'\n`)
    expect(hook().code).toBe(1)
  })

  it('rejects Bearer tokens', () => {
    reset()
    stage('src/d.ts', 'const h = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"\n') // pre-commit:allow
    expect(hook().code).toBe(1)
  })

  // Built at run time: this file must not contain a token-shaped literal itself.
  const tunnelToken = Buffer.from(JSON.stringify({ a: 'acct0123456789', t: '11111111-2222-3333-4444-555555555555', s: 'secretvalue1234567890' })).toString('base64')
  for (const [path, body] of [
    ['README.md', `${tunnelToken}
`],
    ['docs/notes.md', `run: cloudflared.exe service install ${tunnelToken}
`],
    ['src/t.ts', `const t = "${tunnelToken}"
`],
  ] as const) {
    it(`rejects a tunnel token (bare, or inside the pasted install command) without printing it: ${path}`, () => {
      reset()
      stage(path, body)
      const r = hook()
      expect(r.code).toBe(1)
      expect(r.err).toContain(path)
      expect(r.err).not.toContain(tunnelToken)
    })
  }

  const api = 'Ab1_'.repeat(10)
  const letters = 'abcdefghij'.repeat(4)
  const rejectsLine = (name: string, line: string, value: string) => it(name, () => {
    reset()
    stage('src/c.ts', `${line}
`)
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('src/c.ts')
    expect(r.err).not.toContain(value)
  })
  for (const line of [
    `cloudflareToken: '${api}'`,
    `const CLOUDFLARE_API_TOKEN = "${api}"`,
    `CF_API_TOKEN=${api}`,
    `"apiToken": "${api}"`,
    `tunnelToken = '${api}'`,
    `cloudflared tunnel run --token ${api}`,
    `TUNNEL_TOKEN=${api}`,
  ]) rejectsLine(`rejects a Cloudflare API token assigned to a token-like name, and --token / TUNNEL_TOKEN values: ${line.replace(api, '<value>')}`, line, api)

  // A backtick string without `${` is a plain string literal, in a declaration or anywhere else; a
  // TypeScript type annotation between the name and the value does not hide it either.
  for (const value of [api, letters]) {
    for (const line of [
      `const apiToken = \`${value}\``,
      `export const cfg = { apiToken: \`${value}\` }`,
      `let tunnelToken = \`${value}\`;`,
      `headers.cloudflareToken = \`${value}\``,
      `const apiToken: string = '${value}'`,
      `private readonly cloudflareToken?: string | null = \`${value}\``,
    ]) rejectsLine(`rejects backtick and type-annotated literals: ${line.replace(value, value === api ? '<value>' : '<letters>')}`, line, value)
  }

  for (const [name, body] of Object.entries({
    'multi-line object': `const cfg = {
  cloudflareToken:
    '${api}',
}
`,
    'multi-line assignment': `const apiToken =
  "${api}"
`,
    'multi-line backtick assignment': `const apiToken =
  \`${letters}\`
`,
    'string opened on the name line': `const apiToken = \`
${letters}\`
`,
    'multi-line typed assignment': `const apiToken: string =
  '${letters}'
`,
    'CF_TOKEN': `CF_TOKEN=${api}
`,
    'CF_API_KEY': `export CF_API_KEY="${api}"
`,
    'yaml': `cloudflare_api_token:
  ${api}
`,
  })) {
    it(`rejects a credential whose value is on the line after its name, and CF_TOKEN / CF_API_KEY style names: ${name}`, () => {
      reset()
      stage('src/m.ts', body)
      const r = hook()
      expect(r.code).toBe(1)
      expect(r.err).not.toContain(api)
      expect(r.err).not.toContain(letters)
    })
  }

  it('long identifiers and calls after a token-like name are not credentials', () => {
    reset()
    stage('src/long.ts', [
      'const tunnelToken = extractTokenFromPastedCloudflaredCommand(raw)',
      'const cloudflareToken = readSavedCloudflareApiTokenFromSecretsFile',
      'const apiToken =',
      '  readTheSavedApiTokenFromTheSecretsStoreOrThrow()',
      '',
    ].join('\n'))
    expect(hook().code).toBe(0)
  })

  it('changing only the value of an existing multi-line credential field is caught (the name line is unchanged context)', () => {
    reset()
    const api = 'Ab1_'.repeat(10)
    stage('src/existing.ts', ['const cfg = {', '  cloudflareToken:', "    'placeholder',", '}', ''].join('\n'))
    run(['commit', '-q', '--no-verify', '-m', 'seed'])
    stage('src/existing.ts', `const cfg = {
  cloudflareToken:
    '${api}',
}
`)
    const r = hook()
    expect(r.code).toBe(1)
    expect(r.err).toContain('src/existing.ts')
    expect(r.err).not.toContain(api)
    run(['reset', '-q', '--hard'])
  })

  for (const body of [`cloudflareToken: '${letters}'`, `const apiToken = "${letters}"`, `{ "cfToken": "${letters}" }`]) {
    rejectsLine(`a quoted literal after a credential name is rejected without digits too: ${body.replace(letters, '<letters>')}`, body, letters)
  }

  it('a bare value (.env / yaml) needs a digit to count as a credential (known trade-off)', () => {
    reset()
    stage('src/bare.ts', `CF_TOKEN=${letters}
`)
    expect(hook().code).toBe(0)
  })

  it('long names with digits (versions) and calls after a credential name are code, not credentials', () => {
    reset()
    stage('src/v2.ts', [
      'const tunnelToken = extractTokenFromPastedCloudflaredV2Command(raw)', // pre-commit:allow
      'const apiToken = readSavedApiTokenWithSha256Check2024(file, { strict: true })', // pre-commit:allow
      'const cloudflareToken = loadCloudflareTokenFromSecretsStoreV3', // pre-commit:allow
      '',
    ].join('\n'))
    expect(hook().code).toBe(0)
  })

  it('ordinary token handling code and docs are not flagged', () => {
    reset()
    stage('src/ok.ts', [
      'const tunnelToken = extractToken(raw.trim())',
      'draft.cloudflareToken = token',
      'cloudflareToken: string | null',
      '// the API token is only sent in the Authorization header',
      'export const API_TOKEN = /^[A-Za-z0-9_.-]{30,200}$/',
      'TUNNEL_TOKEN=[token]',
      'const apiToken = `${prefix}${readSavedApiTokenFromTheSecretsStore()}`',
      '',
    ].join('\n'))
    expect(hook().code).toBe(0)
  })

  it('does not flag short ids or words containing sk-', () => {
    reset()
    stage('src/e.ts', "const a = 'deadbeef'\nconst b = 'task-management-board-name-long'\n")
    expect(hook().code).toBe(0)
  })

  it('marker allows deliberate fakes', () => {
    reset()
    stage('tests/f.ts', `const k = 'sk-${'A'.repeat(30)}' // pre-commit:allow\n`)
    expect(hook().code).toBe(0)
  })

  it('review reports may quote commit hashes', () => {
    reset()
    stage('docs/reviews/r.md', 'commit `' + 'a'.repeat(40) + '`\n')
    expect(hook().code).toBe(0)
  })

  it('other docs may not quote long hex runs', () => {
    reset()
    stage('docs/other.md', 'commit `' + 'a'.repeat(40) + '`\n')
    expect(hook().code).toBe(1)
  })

  it('a changed line is scanned again', () => {
    reset()
    stage('src/g.ts', `const k = 'sk-${'A'.repeat(30)}'\n`)
    run(['commit', '-q', '--no-verify', '-m', 'seed'])
    stage('src/g.ts', `const k = 'sk-${'A'.repeat(30)}'\n`.replace('const k', 'const kk') + '// ok\n')
    expect(hook().code).toBe(1) // the changed line is added again
    run(['reset', '-q', '--hard'])
  })

  it('only added lines are scanned', () => {
    reset()
    stage('src/h.ts', 'const ok = 1\n')
    expect(hook().code).toBe(0)
  })
})
