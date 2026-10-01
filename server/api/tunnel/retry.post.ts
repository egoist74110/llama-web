// Start the tunnel again now (after an error), instead of waiting for the automatic retry.
import { getContext } from '../../service/context'

export default defineEventHandler(() => {
  getContext().tunnel.retry()
  return { ok: true }
})
