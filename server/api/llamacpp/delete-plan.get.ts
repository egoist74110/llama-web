// What deleting a build would do: GET ?ref=cuda:b11146 → { blocked, affected, isCurrent, becomesCurrent, needsConfirm }.
import { getContext } from '../../service/context'
import { runtimeError } from '../../service/llamacpp-api'

export default defineEventHandler((event) => {
  try {
    return getContext().runtimes.plan(String(getQuery(event).ref ?? ''))
  } catch (e) {
    runtimeError(e)
  }
})
