// Stop waiting for a manual start; the process that was started is ended if it still runs.
import { getContext } from '../../../service/context'
import { describeUpstreams } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  await getContext().launcher.cancel(getRouterParam(event, 'id')!)
  return describeUpstreams()
})
