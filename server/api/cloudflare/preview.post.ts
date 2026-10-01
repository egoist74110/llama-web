// Work out what the setup would do: { zoneId, subdomain, tunnelName, tunnel?, dns? }. Changes nothing.
import { planSetup } from '../../core/cloudflare'
import { cloudflareError, savedClient, setupInput } from '../../service/cloudflare-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const api = savedClient()
  try {
    return await planSetup(api, setupInput(body))
  } catch (e) {
    cloudflareError(e)
  }
})
