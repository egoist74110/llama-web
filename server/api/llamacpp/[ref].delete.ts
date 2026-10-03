// Delete a build: DELETE /api/llamacpp/<ref>?confirm=1. The newest official build of a channel and builds
// in use are refused; models / the global version that use it need confirm=1 (their references are then cleared).
import { getContext } from '../../service/context'
import { describeLlamacpp, runtimeError } from '../../service/llamacpp-api'

export default defineEventHandler((event) => {
  const ref = decodeURIComponent(getRouterParam(event, 'ref') ?? '')
  try {
    const plan = getContext().runtimes.remove(ref, { confirm: getQuery(event).confirm === '1' })
    return { plan, ...describeLlamacpp() }
  } catch (e) {
    runtimeError(e)
  }
})
