// The usage guide of a knowledge base: the effective text, the stored custom text ('' = default) and its revision.
import { getContext } from '../../../service/context'
import { kbError } from '../../../service/kb-api'

export default defineEventHandler((event) => {
  try {
    return getContext().kb.guide(getRouterParam(event, 'id') ?? '')
  } catch (e) {
    kbError(e)
  }
})
