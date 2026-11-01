// Save the switch and/or keys: { enabled?: boolean, order?: 'free-only' | 'free-first' | 'keyed-first', guide?: string, guideRequired?: boolean, keys?: { tavily?: string, brave?: string } }. A key of '' removes it.
// The body is validated as a whole first; nothing is written when any part is invalid.
import { t } from '../../core/i18n'
import { applyKeys, parseWebSearchPatch } from '../../core/web-search/admin'
import { getContext } from '../../service/context'
import { viewWebSearch, webSearchError } from '../../service/web-search-api'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ctx = getContext()
  try {
    const patch = parseWebSearchPatch(body)
    if (patch.keys) ctx.updateSecrets((draft) => { applyKeys(draft, patch.keys) })
    if (patch.enabled !== undefined || patch.order !== undefined || patch.guide !== undefined || patch.guideRequired !== undefined) {
      ctx.updateSettings((draft) => {
        if (patch.enabled !== undefined) draft.webSearch.enabled = patch.enabled
        if (patch.order !== undefined) draft.webSearch.order = patch.order
        // Saved as '' when it is the default text, so the default keeps following the language and later improvements.
        if (patch.guide !== undefined) draft.webSearch.guide = patch.guide.trim() === t.webPrompt.defaultGuide.trim() ? '' : patch.guide
        if (patch.guideRequired !== undefined) draft.webSearch.guideRequired = patch.guideRequired
      })
    }
  } catch (e) {
    webSearchError(e)
  }
  return viewWebSearch()
})
