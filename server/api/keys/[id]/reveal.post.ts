// The plain-text key, for 查看 / 复制 on the settings page. POST so the cross-site guard applies.
import { findKey } from '../../../core/keys'
import { getContext } from '../../../service/context'
import { keysError } from '../../../service/keys-api'

export default defineEventHandler((event) => {
  try {
    const k = findKey(getContext().getSecrets(), getRouterParam(event, 'id'))
    return { id: k.id, key: k.key }
  } catch (e) {
    keysError(e)
  }
})
