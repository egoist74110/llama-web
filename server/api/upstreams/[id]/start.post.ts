// Run the saved start command of an upstream that is not up, then wait for its models (decision 56 ⑩). Answers at once
// with the list; the page follows the progress in the live snapshot (`launch`).
import { getContext } from '../../../service/context'
import { describeUpstreams, launchError } from '../../../service/upstreams-api'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ctx = getContext()
  try {
    ctx.refresh()
    ctx.launcher.start(id, ctx.health.isUp(id))
    return describeUpstreams()
  } catch (e) {
    launchError(e)
  }
})
