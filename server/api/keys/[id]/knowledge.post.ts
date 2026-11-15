// Set the knowledge base permissions of a key: { kbs: string[] | null, kbWrite: boolean } (kbs null = all knowledge bases).
// Takes effect on the next request (decisions 65 ⑧ / 69 ⑧).
import { setKeyKnowledge } from '../../../core/keys'
import { getContext } from '../../../service/context'
import { describeKeys, keysError } from '../../../service/keys-api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody(event).catch(() => null)
  try {
    const ctx = getContext()
    ctx.updateSecrets((draft) => { setKeyKnowledge(draft, id, body, ctx.getKnowledge().bases.map(b => b.id)) })
  } catch (e) {
    keysError(e)
  }
  return describeKeys()
})
