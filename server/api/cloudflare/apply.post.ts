// Run a confirmed preview: the preview body plus { fingerprint }. Refused (409) when the account
// changed since the preview. Returns the run with every step's result.
import { getContext } from '../../service/context'
import { cloudflareError, savedClient, setupInput } from '../../service/cloudflare-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const api = savedClient()
  try {
    const { cloudflare } = getContext()
    await cloudflare.apply(api, setupInput(body), typeof body?.fingerprint === 'string' ? body.fingerprint : '')
    // The job as of now with its version (not the run's return value: the page orders by the version).
    return cloudflare.view()
  } catch (e) {
    cloudflareError(e)
  }
})
