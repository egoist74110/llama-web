// Stop a service this llama-web run started by hand (decision 56 ⑩). Not available for a service started elsewhere
// or before llama-web was restarted.
import { getContext } from '../../../service/context'
import { describeUpstreams, launchError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  try {
    await getContext().launcher.stop(getRouterParam(event, 'id')!)
    return describeUpstreams()
  } catch (e) {
    launchError(e)
  }
})
