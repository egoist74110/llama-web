// What a force stop would end (decision 66): the process that listens on this local upstream's port, shown before the user confirms.
import { forceStopError, inspectForceStop } from '../../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  try {
    return await inspectForceStop(getRouterParam(event, 'id'))
  } catch (e) {
    forceStopError(e)
  }
})
