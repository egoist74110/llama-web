// Fixture: a stand-in for cloudflared. Reads TUNNEL_TOKEN from the environment (like the real
// `tunnel run`) and behaves according to argv[2]:
//   connect   two "Registered tunnel connection" lines, then stays alive
//   leak      prints the token (and its secret) in a line first, to test redaction, then connects
//   badtoken  prints the invalid-token error and exits with 1
//   crash     prints an error and exits with 2
//   child     like connect, plus a long-lived grandchild (`child=<pid>`)
//   quiet     prints one ERR line and never connects
const mode = process.argv[2] ?? 'connect'
const token = process.env.TUNNEL_TOKEN ?? ''
console.log(`fake cloudflared mode=${mode} token-length=${token.length}`)

const connect = () => {
  console.log('2026-10-01T00:00:00Z INF Registered tunnel connection connIndex=0 location=xxx01 protocol=quic')
  console.error('2026-10-01T00:00:00Z INF Registered tunnel connection connIndex=1 location=xxx02 protocol=quic')
}

if (mode === 'badtoken') {
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
if (mode === 'quiet') console.error('2026-10-01T00:00:00Z ERR Unable to establish connection with Cloudflare edge')
else connect()
setInterval(() => {}, 1000)
