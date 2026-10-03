// Fixture: a stand-in for cloudflared. Reads TUNNEL_TOKEN from the environment (like the real
// `tunnel run`) and behaves according to argv[2]:
//   connect   two "Registered tunnel connection" lines, then stays alive
//   leak      prints the token (and its secret) in a line first, to test redaction, then connects
//   badtoken  prints the invalid-token error and exits with 1
//   crash     prints an error and exits with 2
//   child     like connect, plus a long-lived grandchild (`child=<pid>`)
//   quiet     prints one ERR line and never connects
//   flap      two connections, both unregistered, then one registered again (all on stdout, in order)
//   config    connects, then prints the remotely managed configuration (like the real one)
//   quick       quick tunnel (`tunnel --url`): an error line naming the API host, the banner with a
//               random *.trycloudflare.com address (label includes the pid), then one connection
//   quick-crash like quick, then exits with 1 shortly after
//   quick-child like quick, plus a long-lived grandchild (`child=<pid>`)
const mode = process.argv[2] ?? 'connect'
const token = process.env.TUNNEL_TOKEN ?? ''
console.log(`fake cloudflared mode=${mode} token-length=${token.length}`)

const connect = () => {
  console.log('2026-10-01T00:00:00Z INF Registered tunnel connection connIndex=0 location=xxx01 protocol=quic')
  console.error('2026-10-01T00:00:00Z INF Registered tunnel connection connIndex=1 location=xxx02 protocol=quic')
}

if (mode.startsWith('quick')) {
  const l = (m: string) => console.error(`2026-10-01T00:00:00Z INF ${m}`)
  console.error('2026-10-01T00:00:00Z WRN retrying request to https://api.trycloudflare.com/tunnel')
  l('Requesting new quick Tunnel on trycloudflare.com...')
  l('+--------------------------------------------------------------------------------------------+')
  l('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |')
  l(`|  https://fake-words-${process.pid}.trycloudflare.com                                        |`)
  l('+--------------------------------------------------------------------------------------------+')
  l('Registered tunnel connection connIndex=0 location=xxx01 protocol=quic')
  if (mode === 'quick-crash') setTimeout(() => process.exit(1), 300)
  if (mode === 'quick-child') {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
    console.log(`child=${child.pid}`)
  }
} else if (mode === 'badtoken') {
  console.error('2026-10-01T00:00:00Z ERR Provided Tunnel token is not valid.')
  process.exit(1)
}
if (mode === 'crash') {
  console.error('2026-10-01T00:00:00Z ERR something broke')
  process.exit(2)
}
if (mode === 'leak') {
  const secret = JSON.parse(Buffer.from(token, 'base64').toString('utf8')).s as string
  console.log(`2026-10-01T00:00:00Z INF debug token=${token} secret=${secret}`)
}
if (mode === 'child') {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
  console.log(`child=${child.pid}`)
}
if (mode === 'config') {
  connect()
  const cfg = {
    ingress: [
      { hostname: 'llm.example.com', service: 'http://127.0.0.1:8080', originRequest: {} },
      { hostname: 'other.example.com', service: 'http://localhost:3000' },
      { hostname: 'b.example.net', service: 'http://localhost:8080/' },
      { service: 'http_status:404' },
    ],
    'warp-routing': { enabled: false },
  }
  console.error(`2026-10-01T00:00:01Z INF Updated to new configuration config=${JSON.stringify(JSON.stringify(cfg))} version=2`)
} else if (mode === 'quiet') console.error('2026-10-01T00:00:00Z ERR Unable to establish connection with Cloudflare edge')
else if (mode === 'flap') {
  const l = (m: string) => console.log(`2026-10-01T00:00:00Z INF ${m}`)
  l('Registered tunnel connection connIndex=0 location=xxx01')
  l('Registered tunnel connection connIndex=1 location=xxx02')
  l('Unregistered tunnel connection connIndex=0')
  l('Unregistered tunnel connection connIndex=1')
  l('Registered tunnel connection connIndex=0 location=xxx01')
} else if (!mode.startsWith('quick')) connect()
setInterval(() => {}, 1000)
