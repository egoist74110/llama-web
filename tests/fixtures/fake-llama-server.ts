// Fixture: a stand-in for llama-server. Reads --host/--port, serves /health (503 while
// "loading", then 200), writes some output. Behaviour via --fake-mode:
//   ok     ready after --fake-delay ms (default 100)
//   exit   print an error and exit with code 3 before becoming ready
//   hang   never becomes ready
//   dots   like ok, and writes a dots-only unfinished line with a raw write (no newline, like the weight loader)
//   child  like ok, but also spawns a long-lived grandchild and prints `child=<pid>`
const argv = process.argv.slice(2)
const opt = (name: string, def = '') => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1]! : def
}
const mode = opt('--fake-mode', 'ok')
const delay = Number(opt('--fake-delay', '100'))
const host = opt('--host', '127.0.0.1')
const port = Number(opt('--port'))

console.log(`fake llama-server mode=${mode} port=${port}`)
console.error('stderr: 加载模型中')

if (mode === 'exit') {
  console.error('error: unknown argument: --bogus')
  process.exit(3)
}

if (mode === 'child') {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
  console.log(`child=${child.pid}`)
}

const readyAt = mode === 'hang' ? Infinity : Date.now() + delay
Bun.serve({
  hostname: host,
  port,
  fetch(req) {
    if (new URL(req.url).pathname === '/health') {
      return Date.now() >= readyAt
        ? Response.json({ status: 'ok' })
        : Response.json({ error: { code: 503, message: 'Loading model' } }, { status: 503 })
    }
    return new Response('not found', { status: 404 })
  },
})
if (mode === 'dots') {
  require('node:fs').writeSync(2, '..........')
} else {
  process.stdout.write('partial line without newline')
}
setInterval(() => {}, 1000)
