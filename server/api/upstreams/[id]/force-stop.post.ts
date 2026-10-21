// Force stop (decision 66): end the process the page showed (pid + start time must still match) and what it started.
import { forceStop, forceStopError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  try {
    return await forceStop(getRouterParam(event, 'id'), await readBody(event))
  } catch (e) {
    forceStopError(e)
  }
})
