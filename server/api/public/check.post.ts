// Self-check of the public addresses: request each one's /v1/models without a key from this
// machine (through Cloudflare and the tunnel); 401 = reachable. The addresses come from the
// saved domain and the tunnel's configuration (quick mode: only the quick tunnel's address),
// never from the request.
import { checkAddresses, publicAddresses } from '../../core/public-check'
import { getContext } from '../../service/context'

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const MAX = 20

export default defineEventHandler(async () => {
  const ctx = getContext()
  const hosts = publicAddresses(ctx.getSettings().public, ctx.tunnel.status())
    .filter(h => HOST.test(h)).slice(0, MAX)
  return { results: await checkAddresses(hosts, { fetch }) }
})
