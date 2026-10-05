// Cross-platform (Windows / macOS) launcher for the built app. Wrapped by start.bat / start.command.
// Usage: bun scripts/launch.ts [build|run|ask]
//   build  always rebuild, then run
//   run    never rebuild (builds only if there is no build output), then run
//   ask    (default) decide by whether sources changed since the last build; asks when stdin is a terminal
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const entry = join(root, '.output', 'server', 'index.mjs')
const countdownSeconds = 3

// Everything that can change the build output.
const watched = ['app', 'server', 'i18n', 'public', 'nuxt.config.ts', 'package.json', 'bun.lock', 'tsconfig.json']

function newestMtime(path: string): number {
  let stat
  try { stat = statSync(path) } catch { return 0 }
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    newest = Math.max(newest, newestMtime(join(path, name)))
  }
  return newest
}

function sourcesChanged(): boolean {
  const built = statSync(entry).mtimeMs
  return watched.some(p => newestMtime(join(root, p)) > built)
}

// Resolves 'b' / 'r' / 'q' (or the default after the countdown / Enter).
function choose(defaultKey: 'b' | 'r'): Promise<'b' | 'r' | 'q'> {
  return new Promise((resolveKey) => {
    const stdin = process.stdin
    let left = countdownSeconds
    const label = defaultKey === 'b' ? 'rebuild' : 'run'
    const render = () => process.stdout.write(`\r[llama-web] Enter = ${label} (auto in ${left}s)   `)
    const finish = (key: 'b' | 'r' | 'q') => {
      clearInterval(timer)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      resolveKey(key)
    }
    const timer = setInterval(() => {
      left -= 1
      if (left <= 0) finish(defaultKey)
      else render()
    }, 1000)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', (data) => {
      const c = data.toString().toLowerCase()
      if (c === '\u0003' || c === 'q') finish('q')
      else if (c === 'b') finish('b')
      else if (c === 'r') finish('r')
      else if (c === '\r' || c === '\n' || c === ' ') finish(defaultKey)
    })
    render()
  })
}

async function exec(cmd: string[]): Promise<number> {
  const child = Bun.spawn(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
  // Ctrl+C reaches the child through the console too; just wait for it so its cleanup finishes.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  process.on('SIGTERM', () => child.kill())
  return await child.exited
}

async function main() {
  const mode = process.argv[2] ?? 'ask'
  const hasBuild = existsSync(entry)
  let build: boolean

  if (mode === 'build') build = true
  else if (!hasBuild) build = true
  else if (mode === 'run') build = false
  else {
    const stale = sourcesChanged()
    console.log(`[llama-web] build found; sources ${stale ? 'changed since the last build' : 'unchanged'}.`)
    console.log('[llama-web] keys: [b] rebuild  [r] run as is  [q] quit')
    if (process.stdin.isTTY) {
      const key = await choose(stale ? 'b' : 'r')
      if (key === 'q') return 0
      build = key === 'b'
    } else {
      build = stale
    }
  }

  if (build) {
    // Cheap no-op when up to date; catches dependencies added since the last install.
    console.log('[llama-web] checking dependencies...')
    const installed = await exec(['bun', 'install'])
    if (installed !== 0) return installed
    console.log('[llama-web] building...')
    const code = await exec(['bun', 'run', 'build'])
    if (code !== 0) return code
  }

  console.log('[llama-web] starting...')
  return await exec(['bun', entry])
}

process.exit(await main())
