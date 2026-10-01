// Create a key: { name }. Returns the list plus the new key in plain text, so it can be copied once right away.
import { createKey, type ApiKey } from '../../core/keys'
import { getContext } from '../../service/context'
import { describeKeys, keysError } from '../../service/keys-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  let created: ApiKey | null = null
  try {
    getContext().updateSecrets((draft) => { created = createKey(draft, body?.name) })
  } catch (e) {
    keysError(e)
  }
  const k = created as ApiKey | null
  return { ...describeKeys(), created: k ? { id: k.id, key: k.key } : null }
})
