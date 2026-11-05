// Run a saved start command of an upstream that is not up, then wait for its models (decision 56 ⑩). Body: { commandId? }
// (needed when the upstream has more than one runnable command, decision 68). Answers at once with the list; the page
// follows the progress in the live snapshot (`launch`).
import { getContext } from '../../../service/context'
import { describeUpstreams, launchError } from '../../../service/upstreams-api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ctx = getContext()
  const body = await readBody<{ commandId?: unknown } | null>(event).catch(() => null)
  const commandId = typeof body?.commandId === 'string' ? body.commandId : undefined
  try {
    ctx.refresh()
    ctx.launcher.start(id, ctx.health.isUp(id), commandId)
    return describeUpstreams()
  } catch (e) {
    launchError(e)
  }
})
