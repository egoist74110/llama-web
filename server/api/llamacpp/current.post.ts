// Switch the current llama.cpp version: { tag } (rollback; the page asks for confirmation first).
// Running models keep their process; the next load uses the chosen version.
import { getContext } from '../../service/context'
import { describeLlamacpp, llamacppError } from '../../service/llamacpp-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    getContext().updater.use(body?.tag)
  } catch (e) {
    llamacppError(e)
  }
  return describeLlamacpp()
})
