// Stop a running installer download.
import { getContext } from '../../service/context'

export default defineEventHandler(() => {
  const u = getContext().appUpdate
  u.cancel()
  return u.view()
})
