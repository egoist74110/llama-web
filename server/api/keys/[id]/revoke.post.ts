// Revoke a key (the page asks for confirmation first). Takes effect on the next public request.
import { revokeKey } from '../../../core/keys'
import { getContext } from '../../../service/context'
import { describeKeys, keysError } from '../../../service/keys-api'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  try {
    getContext().updateSecrets((draft) => { revokeKey(draft, id) })
  } catch (e) {
    keysError(e)
  }
  return describeKeys()
})
