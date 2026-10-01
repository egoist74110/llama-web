// Custom Bun entry (plan 关键决定 25). Replaces Nitro's bun entry because that one reads the
// whole body before handing it to Nitro, drops req.signal, and inherits Bun's 10 s idle
// timeout. Here:
// - every request gets `server.timeout(req, 0)` (no idle timeout; loads can take minutes);
// - /v1/*, /upstream/* and GET /api/stream are handled natively (streaming, disconnect = abort);
// - everything else goes to Nitro via localFetch.
// The public entry (settings.public, 127.0.0.1 only) is a second Bun.serve whose handler only
// knows /v1/* behind an API key (core/public-entry.ts); it never reaches Nitro.
// Only used by the build (`bun run build` / `bun run preview` / start.bat); `nuxt dev`
// serves /v1 and /upstream through server/routes/ instead.
import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
import { handleStream } from './core/live'
import { getContext } from './service/context'

const nitroApp = useNitroApp()
const ctx = getContext()
const cfg = ctx.getSettings().server

const server = Bun.serve({
  port: Number(process.env.NITRO_PORT || process.env.PORT) || cfg.port,
  hostname: process.env.NITRO_HOST || process.env.HOST || cfg.host,
  async fetch(req, srv) {
    srv.timeout(req, 0)
    const url = new URL(req.url)
    if (url.pathname.startsWith('/v1/')) return ctx.proxy.handleV1(req, { ip: srv.requestIP(req)?.address })
    if (url.pathname.startsWith('/upstream/')) return ctx.proxy.handleUpstream(req)
    if (url.pathname === '/api/stream' && req.method === 'GET') return handleStream(req, { hub: ctx.live })
    const body = req.body ? await req.arrayBuffer() : undefined
    return nitroApp.localFetch(url.pathname + url.search, {
      host: url.hostname,
      protocol: url.protocol,
      headers: req.headers,
      method: req.method,
      redirect: req.redirect,
      body,
    })
  },
})
console.log(`[llama-web] listening on ${server.url}`)

ctx.publicEntry.attach((opts) => {
  const s = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    fetch(req, srv) {
      srv.timeout(req, 0)
      return opts.fetch(req, srv.requestIP(req)?.address ?? null)
    },
    // Plain 500 instead of Bun's error page (which can show stacks and paths).
    error: () => new Response('Internal Server Error', { status: 500 }),
  })
  // Turning the entry off (or moving it) also ends requests still running on it.
  return { stop: () => void s.stop(true) }
})
ctx.applyPublic()

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[llama-web] ${signal}: stopping models...`)
  const guard = setTimeout(() => process.exit(1), 15_000)
  try {
    await nitroApp.hooks.callHook('close')
    await ctx.shutdown()
  } catch (e) {
    console.error('[llama-web] shutdown failed', e)
  }
  clearTimeout(guard)
  server.stop(true)
  process.exit(0)
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => void stop(s))
