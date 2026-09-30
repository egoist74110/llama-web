// Custom Bun entry (plan 关键决定 25). Replaces Nitro's bun entry because that one reads the
// whole body before handing it to Nitro, drops req.signal, and inherits Bun's 10 s idle
// timeout. Here:
// - every request gets `server.timeout(req, 0)` (no idle timeout; loads can take minutes);
// - /v1/* and /upstream/* are handled natively (streaming pass-through, disconnect = abort);
// - everything else goes to Nitro via localFetch.
// Only used by the build (`bun run build` / `bun run preview` / start.bat); `nuxt dev`
// serves /v1 and /upstream through server/routes/ instead.
import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
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
    if (url.pathname.startsWith('/v1/')) return ctx.proxy.handleV1(req)
    if (url.pathname.startsWith('/upstream/')) return ctx.proxy.handleUpstream(req)
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
